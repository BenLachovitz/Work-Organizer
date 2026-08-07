# BACKLOG — resume here

Handoff for the next session. Everything below is decided unless marked
**OPEN**.

---

## Where the project stands

| Step | State | Verification |
|---|---|---|
| **A** Database, RLS, seed | done | Gate A local 42/42, cloud 31/31 |
| **B** Badge auth + PIN | done | Gate B 18/18, client 8/8 |
| **C** Preference persistence | done | Gate C 13/13 |
| **D** Manager dashboard | done | Gate D 18/18 |
| **E** Scheduling engine | done | mock 51/51, CP-SAT 49/49 all OPTIMAL |
| **E** Generate → publish flow | **not started** | — |
| **F1–F5** Fine-tuning batch | **done** | covered by the suites above |

**230 tests green** across 8 suites. Commits: `ad6de51` → `fbef84c` → `2eee277`
→ `ad4a897` → `6b046bb` → `7d71ac4` → `fa60120` → `e96848d` → `c3bad9a`.

### Live environment

- Supabase project `atojvgyxqdbmhhycdcsa` (eu-central-1 / Frankfurt)
- Credentials in `.env.local` (gitignored): project URL, publishable key,
  `SUPABASE_ACCESS_TOKEN` (account-scoped PAT)
- Migrations run over HTTPS via the Management API — outbound Postgres ports
  5432/6543 are **blocked on this network**, so `DATABASE_URL` will not work
- Edge Function `claim-code` deployed and live
- Solver service written and tested locally; **not deployed**
- 10 migrations applied. Weeks are now created by `ensure_roster_weeks()`, not
  seeded by hand.

### Commands

```bash
npm run dev            # Vite dev server, port 5173
npm run db:apply       # apply pending migrations (ledger-tracked, safe to re-run)
npm run db:verify      # RLS + reachability audit
npm run test:rls       # local PGlite RLS suite (applies ALL migrations)
npm run test:cloud     # all 5 cloud suites against the live project
npm run test:fixtures  # mock solver over the 8 golden fixtures
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

### E3. Deploy the solver — OPTIONAL, do last

**Why a third host at all:** OR-Tools only ships for Python/C++/Java. Supabase
Edge Functions run Deno (JS only) and Vercel serves a static browser bundle, so
neither can execute the solver. Render runs a Python web service on its free
tier and returns a URL the Edge Function calls server-to-server.

**Not a blocker.** The mock solver runs in the browser and its output is always
legal — every hard rule is checked before each assignment and the same referee
judges it. Across the 7 fixtures it tied CP-SAT on 5 and lost on 2. Recommended
sequence: ship E1+E2 on the mock, use it for a real week, and add Render only
if the rosters feel worse than hand-built ones.

**E0 prerequisite — no GitHub remote exists yet.** Render deploys from a Git
repository; this repo is local-only. Create a GitHub repo (do NOT initialise it
with a README — that makes a conflicting root commit) and push. Needed for
Vercel deployment regardless.

Then:
1. render.com → New → Blueprint → point at the repo (`solver/render.yaml`)
2. Set `SOLVER_SECRET` in the Render dashboard to any random string
3. Set the same `SOLVER_SECRET` + `SOLVER_URL` in Supabase Edge Function secrets
4. Flip `VITE_SOLVER_MODE=remote`

**Needs from Ben:** the GitHub repo, then the Render URL.

### E4. Gate E (cloud)

End-to-end: manager generates → run and assignments land → verifier passes on
what was actually written → publish → guard sees only their own shifts → guard
cannot publish or edit.

---

## PART 2 — fine-tuning batch — COMPLETE

All five landed. Kept here as the record of what was decided and why.

| | Change | Commit |
|---|---|---|
| **F1** | 12h opt-in is **per day** (`allows_12h` on the preference row, week-level columns dropped). Chips render under the day they apply to; "בכל הימים" shortcut retained. Fixture 08 pins the semantics. | `e96848d` |
| **F2** | Weeks auto-created by `ensure_roster_weeks()`. The rule is **"exactly one week open"**, not "current + next" — a Wednesday deadline means next week is already locked for the back half of each week. | `c3bad9a` |
| **F3** | Raised morning target applies **Mon–Fri only**; Sat/Sun always 2. `segmentTargets/Floors` take a required day index so a forgetful call site fails to compile. | `fa60120` |
| **F4** | Past weeks **manager-only**, RLS-enforced. Cut is absolute: a guard sees nothing from a finished week, not even their own shift. | `c3bad9a` |
| **F5** | US work week — weekend is **Sat+Sun**, Friday is a working day. Deadline **Wednesday 19:00**. | `fa60120` |

Spec updated to **v2.1** with a §1.2 changelog covering all five.

---

## Known issue — date-coupled test fixtures

`OPEN_WEEK = '2026-08-16'` and `LOCKED_WEEK = '2026-08-09'` are hardcoded in
`rls.test.mjs`, `rls.cloud.test.mjs` and `preferences.cloud.test.mjs`. They work
today because `ensure_roster_weeks()` happens to produce exactly those weeks,
but **they will start failing once real time passes 2026-08-12**, when
2026-08-16 stops being the open week.

Fix when it bites: have those suites create their own throwaway weeks the way
`manager.cloud.test.mjs` already does, rather than leaning on whichever weeks
the lifecycle produced. Not urgent, but it is a scheduled failure, not a
flake — worth recognising rather than re-diagnosing.

---

## Open questions

All product questions are answered. The only outstanding items need an action
from Ben, not a decision:

1. **E0** — create the GitHub repo and push (needed for both Render and Vercel).
2. **E3** — Render service URL, once created. Optional; see E3.

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
- **Credentials: deliberately left live.** Ben has chosen to keep the Supabase
  PAT and database password active until the project is finished, so tooling
  keeps full access. Both appear in the session transcript, so this is a
  conscious trade, not an oversight. **End-of-project checklist:** revoke the
  PAT at `supabase.com/dashboard/account/tokens` and rotate the database
  password under Settings → Database.
- The abandoned Seoul project has been deleted. Only
  `atojvgyxqdbmhhycdcsa` (Frankfurt) remains.
