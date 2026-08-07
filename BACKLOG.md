# START HERE — project status

Short orientation sheet. Full technical detail is in
**[dynamic-guard-scheduler-spec.md](dynamic-guard-scheduler-spec.md) v2.2** — §14 there is the
build status and roadmap.

*Last updated: 7 August 2026*

---

## What this is

A Hebrew, RTL, mobile-first shift scheduler (**סידור אמריקאי**) for a security team at an American
school. Guards submit weekly availability from their phones; a manager sets each guard's **כמות**
(minimum shifts) and presses one button; a constraint solver returns a legal roster plus a report of
what it could not achieve; the manager audits and publishes.

Ben (`005396`) is both the manager **and** an active guard.

---

## State: all five build steps complete

| Step | Scope | State |
|---|---|---|
| A | Schema, RLS, helper functions | ✅ |
| B | Badge code + PIN auth, `claim-code` Edge Function | ✅ deployed |
| C | Preference submission, atomic save | ✅ |
| D | Manager dashboard | ✅ |
| E | Solver contract, twin referees, mock + CP-SAT, generate → publish | ✅ **CP-SAT deployed and live** |
| F1–F5 | Fine-tuning batch | ✅ |

**Eight test suites green.** `npm run test:rls`, `npm run test:cloud`, `npm run test:fixtures`,
`solver/.venv/Scripts/python solver/tests/test_scheduler.py`, `npm run test:compare`.

---

## What is left

1. **Deploy the frontend to Vercel** — the only remaining step that puts this on guards' phones.
2. **Replace placeholder badge codes** `100001`–`100009` with the team's real ones.
3. **Decide open item 6** — should availability be soft? (spec §3.2)

Done: repo pushed to `github.com/BenLachovitz/Work-Organizer`; solver live at
`https://guard-solver.onrender.com`; `VITE_SOLVER_MODE=remote`.

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
- 12 migrations applied, tracked in a `schema_migrations` ledger

### Current database contents

- Weeks `2026-08-02` (current) and `2026-08-09` (next) — the lifecycle keeps exactly these two
- 8 profiles: Ben plus 7 mock guards created for testing
- 68 preference rows + 8 כמות rows on `2026-08-09`, ready to generate against
- No schedule runs (cleared)

`npm run seed:testweek -- --wipe` removes the mock guards and frees their badge codes.

---

## Commands

```bash
npm run dev              # Vite dev server on :5173
npm run db:apply         # apply pending migrations (idempotent)
npm run db:verify        # RLS + reachability audit
npm run seed:testweek    # load a week of guard availability
npm run preview:week     # read-only: what the MOCK would produce
npm run preview:cpsat    # the same input through CP-SAT
npm run test:cloud       # all six cloud suites against the live project
```

---

## Two habits worth keeping

**Nothing is trusted on the solver's word.** Both engines hand their assignments to an independent
referee (`src/lib/validate.ts` and its Python twin `solver/verify.py`) which re-derives the coverage
report and objective from scratch. A roster that fails is refused, not saved. Keep it that way — it
is what stops a solver bug hiding behind a flattering report.

**A manager's decision beats automation.** Two bugs came from breaking this: an auto-disable that
let a stranger lock a guard out of registering, and a week sweep that silently reverted the
manager's "reopen". Both are documented in spec §12.3. Watch for it.

---

## Housekeeping at end of project

- Revoke the Supabase personal access token (supabase.com/dashboard/account/tokens)
- Rotate the database password (Settings → Database)

Both appear in the development transcript.
