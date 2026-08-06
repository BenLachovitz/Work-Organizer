# BACKLOG — resume here

Handoff for the next session. Everything below is decided unless marked
**OPEN**.

---

## Where the project stands

| Step | State | Verification |
|---|---|---|
| **A** Database, RLS, seed | done | Gate A local 42/42, cloud 26/26 |
| **B** Badge auth + PIN | done | Gate B 18/18, client 8/8 |
| **C** Preference persistence | done | Gate C 12/12 |
| **D** Manager dashboard | done | Gate D 18/18 |
| **E** Scheduling engine | **half done** | mock 42/42, CP-SAT 40/40 all OPTIMAL |
| **E** Generate → publish flow | **not started** | — |

**164 tests green.** Commits: `ad6de51` → `fbef84c` → `2eee277` → `ad4a897`.

### Live environment

- Supabase project `atojvgyxqdbmhhycdcsa` (eu-central-1 / Frankfurt)
- Credentials in `.env.local` (gitignored): project URL, publishable key,
  `SUPABASE_ACCESS_TOKEN` (account-scoped PAT)
- Migrations run over HTTPS via the Management API — outbound Postgres ports
  5432/6543 are **blocked on this network**, so `DATABASE_URL` will not work
- Edge Function `claim-code` deployed and live
- Solver service written and tested locally; **not deployed**

### Commands

```bash
npm run dev            # Vite dev server, port 5173
npm run db:apply       # apply pending migrations (ledger-tracked, safe to re-run)
npm run db:verify      # RLS + reachability audit
npm run test:rls       # local PGlite RLS suite
npm run test:cloud     # all 5 cloud suites against the live project
npm run test:fixtures  # mock solver over the 7 golden fixtures
npm run test:compare   # CP-SAT vs mock (run the Python suite first)

solver/.venv/Scripts/python solver/tests/test_scheduler.py   # CP-SAT suite
SOLVER_SECRET=local-test npm run solver:dev                  # solver on :8099
```

---

## PART 1 — finish Step E

### E1. `generate-schedule` Edge Function

Manager-gated, holds `SOLVER_SECRET` so it never reaches a browser.

1. Verify the caller is a manager (`is_manager()` via their JWT — do **not**
   trust a client-supplied role)
2. Load active guards, submissions, preferences, targets for the week
3. Compute `effective_kamut = min(configured, distinct_available_days, 5)` and
   persist it to `weekly_guard_targets.effective_kamut`
4. Build `carry_in` from `carry_in_shifts(week_start)` (migration 2) — the
   previous week's published run
5. POST `SolverInput` to the solver service with the bearer secret
6. Write `schedule_runs` (via `next_run_version()`) + `schedule_assignments`
7. Return the run id and coverage report

**Fallback:** if the solver is unreachable, run the mock in-browser rather than
failing outright. Render's free tier sleeps after 15 min idle (~50 s cold
start), so the UI needs a "מחמם מנוע…" state on first call.

### E2. Roster grid + publish UI

- 7-day × segment grid, colour-coded per shift type, guard names in cells
- Coverage report panel: floor breaches, target gaps, unmet כמות, 8h rests
- Manual override: add/remove a guard from a shift. **Must re-run
  `verifySchedule()` after every edit** and refuse (or loudly warn on) any edit
  that breaks H1–H7 — the database's `one_shift_per_guard_per_day` index only
  catches double-booking, not clopens
- Post assignment (סריקה / בוטקה / בקרה / שמירה) — manual, solver never touches it
- Publish button → `is_published = true`; the partial unique index guarantees
  one published run per week
- Guard-side `RosterView` reads the published run (hooks already exist)

### E3. Deploy the solver

1. Render → New → Blueprint → point at this repo (`solver/render.yaml`)
2. Set `SOLVER_SECRET` in the Render dashboard
3. Set the same `SOLVER_SECRET` + `SOLVER_URL` in Supabase Edge Function secrets
4. Flip `VITE_SOLVER_MODE=remote`

**Needs from Ben:** create the Render service, send the URL.

### E4. Gate E (cloud)

End-to-end: manager generates → run and assignments land → verifier passes on
what was actually written → publish → guard sees only their own shifts → guard
cannot publish or edit.

---

## PART 2 — fine-tuning batch

Do these **together**: they overlap heavily in `shifts.ts`, both referees, both
solvers, the fixtures, and the form.

### F1. Per-day 12h opt-in *(replaces the week-level toggle)*

Chosen: **inline chips under each day** (locality — "can I do 12h on Monday" is
a Monday decision; and the chip disappears with the button that enabled it, so
there is no silent orphan state).

**Schema:**
```sql
ALTER TABLE weekly_wish_preferences ADD COLUMN allows_12h BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE weekly_wish_preferences ADD CONSTRAINT twelve_h_on_extendable_shift
  CHECK (NOT allows_12h OR shift IN ('morning','night'));
```
Migrate existing data from `weekly_submissions.can_work_12h_day/night` onto the
matching morning/night rows, then **drop those two columns** — keeping both
would recreate the two-sources-of-truth bug called out in spec §1.1.

**Contract:** `can_work_12h_day: bool` → `twelve_hour_day: number[]` (day
indices), same for night. Eligibility: `day12` on day *d* ⟺ `morning ∈
availability[d]` **and** `d ∈ twelve_hour_day`.

**UI:** chip only rendered when the enabling base shift is selected; visually
subordinate to the three shift buttons. Add a **"בכל הימים"** shortcut so
"always" is still one tap.

**Touches:** migration, `save_week_preferences` RPC, `shifts.ts::isEligible`,
`solverContract.ts`, `validate.ts`, `mockSolver.ts`, `models.py`, `verify.py`,
`scheduler.py`, all 7 fixtures, `WeeklyPreferenceForm.tsx`, `useGuardPortal.ts`,
`useManager.ts`, spec §3.

### F2. Rolling current + next week

Today's three seeded weeks are **test scaffolding, not a product model**
(locked / open / target-3, one per code path). Replace with a lifecycle:

- Exactly two live weeks: **current** (roster published, in progress) and
  **next** (open for submissions)
- Auto-create the next week when the current one rolls over, with its
  Wednesday 20:00 deadline
- Delete `2026-08-23` from the seed; the target-3 path moves into the suites
- Manager week picker shows the pair; archive is separate (see F4)

### F3. Morning target 3 applies Mon–Fri only

`segmentTargets()` / `segmentFloors()` become functions of **(week setting, day
index)** instead of the week alone.

| Days | set to 2 | set to 3 |
|---|---|---|
| Mon–Fri (indices 1–5) | target 2, floor 1 | target 3, floor 2 |
| Sun (0) & Sat (6) | target 2, floor 1 | **target 2, floor 1** |

Weekly demand at target 3 drops from 392 to ~376 guard-hours (19 morning slots,
not 21).

**Touches:** `shifts.ts`, `validate.ts`, `mockSolver.ts`, `models.py`,
`verify.py`, `scheduler.py`, `CoverageMatrix.tsx`, `WeekControlsPanel.tsx`,
fixtures, spec §2.4.

### F4. Manager-only archive

Past weeks stay stored, visible only to the manager — **enforced in RLS**, not
just hidden in the UI, or a guard could still read old rosters through
PostgREST.

Change `runs_read` so guards see published runs only for the current and future
weeks; managers see everything. Add a read-only archive view.

> **OPEN:** should a guard still see *their own* past assignments (for a pay
> dispute), or is the cut absolute? Cheap either way — add `guard_id =
> auth.uid()` to the assignment policy for the softer version. Default if
> unanswered: **absolute**, as literally requested.

### F5. US work week

Ben works at an American school: **Saturday and Sunday are the days off,
Friday is a normal working day.**

- `WeeklyPreferenceForm` currently tints **Friday + Saturday** as the weekend —
  wrong. Must be **Saturday + Sunday** (indices 6 and 0).
- Deadline moves from **Thursday** to **Wednesday** 20:00 Asia/Jerusalem
  (`week_start − 4`). Update `submissionDeadline()`, the seed, and spec §3.5.
- **Week start stays Sunday.** A Sun–Sat week renders Sunday-first (natural to
  read, matches a US calendar) *and* makes Mon–Fri a contiguous block for F3.
  Moving to Monday-start would make the weekend contiguous instead, which is
  not what the target rule keys on, and would churn the CHECK constraint, day
  indices, day names, carry-in day, fixtures and seeds for no gain.
- Solver day index stays `0 = week_start = Sunday`. Two numbering schemes (one
  for storage, one for the solver) is an off-by-one generator; "Mon–Fri" is
  simply indices 1–5.

---

## Open questions

1. **F4** — do guards keep read access to their own past shifts?
2. **F5** — confirm Wednesday **20:00** is the right time (only the day was
   specified).
3. **E3** — Render service URL, once created.

---

## Notes worth keeping

- **Solver hard set is minimal by design.** Only H1–H7 are hard; floors,
  targets and כמות are soft with weighted penalties, so the solver can never
  return `INFEASIBLE` to a manager on a Wednesday night. Preserve this when
  editing `scheduler.py`.
- **Neither solver reports on its own work.** Both hand assignments to the
  referee (`validate.ts` / `verify.py`) and return what it computes. Keep it
  that way — it is what stops a solver bug hiding behind a flattering report.
- **The 7 fixtures are the TS↔Python contract.** Neither side is generated from
  the other; drift shows up as a fixture failure. Any contract change must
  update all 7.
- **Capacity reality:** 8 guards × 5 shifts = 40 supply vs 42 needed at
  target 2 on 8h shifts. 12h uptake is what closes the gap — a 12h shift covers
  two segments but costs one against the ceiling. Fixture 06 meets every target.
- **Revoke the Supabase PAT** (`supabase.com/dashboard/account/tokens`) and
  rotate the database password when the project is finished. Both appear in the
  session transcript.
- **Delete the old Seoul project** `jqyacxeguqkqhctrsnru` if still present.
