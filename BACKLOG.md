# START HERE — project status

Short orientation sheet. Full technical detail is in
**[dynamic-guard-scheduler-spec.md](dynamic-guard-scheduler-spec.md) v2.2** — §14 there is the
build status and roadmap.

*Last updated: 8 August 2026*

---

## What this is

A Hebrew, RTL, mobile-first shift scheduler (**סידור אמריקאי**) for a security team at an American
school. Guards submit weekly availability from their phones; a manager sets each guard's **כמות**
(minimum shifts), configures the submission window, manages the team (add/delete employees), and
presses one button to generate; a constraint solver returns a legal roster plus a report of what it
could not achieve; the manager audits, hand-edits if needed, and publishes — with a JPEG export for
the team's WhatsApp group.

Ben (`005396`) is both the manager **and** an active guard.

---

## State: build steps A–J complete, live and in daily use

Full list in spec §14.1. Recent milestones (steps G–J): manual grid editing, editable/deletable
published rosters, Realtime push both directions, image export, free-text submission notes,
per-guard default כמות, full team management (add/delete/edit — delete is a real, irreversible
deletion, not a deactivation), configurable submission window, and a cleanup pass that dropped a
dead column and fixed a seed-data bug that could resurrect a deleted employee (spec §12.6).

**Eleven test suites, all green** — `npm run test:rls` (local, PGlite) + `npm run test:cloud`
(eight suites against the live project) + `npm run test:fixtures` + `solver/tests/test_scheduler.py`
+ `npm run test:compare`.

---

## What is left

1. **Deploy the frontend to Vercel** — the only remaining step that puts this on guards' phones.
2. `100001`–`100007` are sequential placeholders, not real employer-issued badge numbers — low
   priority, nothing depends on the number itself.
3. **Decide open item 6** — should availability be soft? (spec §3.2)

### Done since 8 August (items 4–6 from Ben)

4. **Afternoon short-staffed dash** — done. The "—" per missing slot convention (spec §10.1) now
   covers the afternoon block too (`RosterGrid.tsx`, `exportRoster.ts`), not just morning/night. A
   fully-missing coverage slot (neither a full-block guard nor either handover half) renders as one
   full-width "—", the same convention morning/night already used — it doesn't presume a handover
   shape that was never there. An already-present handover's unpaired half keeps its own existing
   half-width "—", unchanged.
5. **Configurable default morning target** — done (migration 24). `scheduler_settings` gained
   `default_morning_target_slots`, read by `ensure_roster_weeks()` only when it inserts a *new*
   `roster_weeks` row — replacing the old implicit "carry forward from the latest existing week"
   behaviour with an explicit, dashboard-visible toggle (`DefaultMorningTargetSettings.tsx`, next to
   `SubmissionWindowSettings` on `ManagerDashboard`). `WeekControlsPanel`'s per-week 2/3 control still
   overrides one specific week, exactly as before.
6. **Renamed the 7 mock guard accounts to `{שם} - דמה`** — done (migration 25), in both
   `profiles.display_name` and `roster_codes.display_name`. Ben (`005396`, בן) untouched. Rename
   only — the mocked preference data on the current test week is still live and usable; the accounts
   themselves are untouched and Ben will delete them himself via `delete_employee` once real
   registration is complete.

---

## Solver

`VITE_SOLVER_MODE=remote` — generation calls CP-SAT on Render through the `generate-schedule` Edge
Function. Verified end to end: a guard is rejected 403, a manager gets `OPTIMAL` in ~2.5s.

The in-browser mock remains the automatic fallback if Render is unreachable (its free tier sleeps
after 15 minutes idle, ~50s cold start). The mock is always *legal* but never optimal — on the first
real week it left 2 shifts empty where CP-SAT left 0 (spec §9.4). If a roster looks wrong, check
`solver_status`: `MOCK` means the fallback ran.

---

## Live environment

- Supabase project `atojvgyxqdbmhhycdcsa` (eu-central-1 / Frankfurt)
- Credentials in `.env.local` — **gitignored**, never committed
- ⚠️ Outbound Postgres ports (5432/6543) are **firewalled on this machine**. `DATABASE_URL` will not
  work; migrations go over HTTPS through the Supabase Management API via `npm run db:apply`.
- Edge Functions `claim-code` and `generate-schedule` are deployed
- Solver live at `https://guard-solver.onrender.com`; `SOLVER_URL` and `SOLVER_SECRET` are set as
  Supabase Edge Function secrets
- 25 migrations applied, tracked in a `schema_migrations` ledger

### Current database contents

- Weeks `2026-08-02` (locked, archive) and `2026-08-09` (**published** — a real roster is live)
- 8 profiles: Ben plus 7 mock guards, the latter renamed to `{שם} - דמה` (backlog item 6, migration
  25) so their badge codes (`100001`–`100007`) won't collide once Ben registers the team for real
- 8 badge codes total, exactly matching the 8 profiles — the two never-hired placeholder codes
  (`100008`, `100009`) were removed (spec §12.6); there is no longer a gap between "codes seeded"
  and "people registered"

`npm run seed:testweek -- --wipe` removes the mock guards and frees their badge codes -- **do not
run this now that the mocks have been renamed and Ben is keeping them around for testing** — it
will delete data he's deliberately keeping.

---

## Commands

```bash
npm run dev              # Vite dev server on :5173
npm run db:apply         # apply pending migrations (ledger-tracked, idempotent)
npm run db:verify        # RLS + reachability audit
npm run seed:testweek    # load a week of guard availability
npm run preview:week     # read-only: what the MOCK would produce
npm run preview:cpsat    # the same input through CP-SAT
npm run test:cloud       # all eight cloud suites against the live project
```

---

## Three habits worth keeping

**Nothing is trusted on the solver's word.** Both engines hand their assignments to an independent
referee (`src/lib/validate.ts` and its Python twin `solver/verify.py`) which re-derives the coverage
report and objective from scratch. A roster that fails is refused, not saved. Keep it that way — it
is what stops a solver bug hiding behind a flattering report.

**A manager's decision beats automation.** Three bugs came from breaking this: an auto-disable that
let a stranger lock a guard out of registering, a week sweep that silently reverted the manager's
"reopen", and `seed.sql` silently un-deleting an employee a manager had genuinely removed. All three
are documented in spec §12.3 and §12.6. Watch for it — anything that runs automatically (a sweep, a
seed script, a trigger) must never overrule an explicit human action, including a deletion.

**Seed data is bootstrap-only, not an ongoing sync.** `db:apply` reruns `seed.sql` on every
invocation, migration or not. Any future seed data needs the same guard `WHERE NOT EXISTS (...)`
pattern the badge-code seed now uses (spec §12.6) — `ON CONFLICT ... DO NOTHING` looks idempotent but
is not once real deletions are possible: a deleted row stops being a conflict.

---

## Housekeeping at end of project

- Revoke the Supabase personal access token (supabase.com/dashboard/account/tokens)
- Rotate the database password (Settings → Database)

Both appear in the development transcript.
