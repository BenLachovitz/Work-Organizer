# START HERE — project status

Short orientation sheet. Full technical detail is in
**[dynamic-guard-scheduler-spec.md](dynamic-guard-scheduler-spec.md) v2.4** — §14 there is the
build status and roadmap, §1.5 is the changelog for everything since v2.3.

*Last updated: 10 August 2026*

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

## Live at https://work-organizer-iota.vercel.app/

Deployed via Vercel CLI, GitHub integration connected — a push to `main` deploys automatically.
Production alias above (Settings → Domains); don't bookmark the per-deployment hashed URLs, they
change every build. Full deploy story, including two one-time setup gotchas (Deployment Protection
gating the whole site, and a `vercel link` mode issue), in spec §11.2.

Mobile bugs found and fixed testing on Ben's own Android/Chrome: SPA 404 on refresh (`vercel.json`
was missing), the login page's viewport-height centering, and the real root cause of both — a
horizontal-overflow bug from the 6-digit code boxes not fitting narrow phones, which also exposed a
systemic gap (no `overflow-x: hidden` anywhere) now closed. If a *different* phone brand still shows
something off, that gap analysis and what to check next is in spec §1.4 item 32's trail and the git
history around `CodeInput.tsx` / `src/index.css` — this hasn't been re-tested on iOS or other brands.

---

## State: build steps A–L complete, live and in daily use

Full list in spec §14.1. Step K (8 August) covered the Vercel deploy, the admin-cursor mechanism,
guard self-cancel, and mobile fixes. **Step L (9–10 August)** shipped two things, built on separate
branches and merged together before deploying:

1. **Two-level preference strength** (`יכול`/`עדיפות`, spec §3.8, migration 31) — a guard can flag
   an already-marked slot as עדיפות; both solver engines add a small measured bonus (+2, on top of
   the existing flat +1) for honouring it. The weight was **measured against live data before
   shipping**, not assumed: 50 (enough to reliably win an ordinary coverage trade-off) fully
   satisfied one guard's preference but cost two extra 8-hour-rest occurrences elsewhere for no
   change in total coverage; 2 got 4 of 5 preferred shifts at zero cost anywhere, so 2 shipped.
   Free-text extraction from the existing notes field (§3.6) was considered and rejected first —
   Hebrew has no fixed phrasing, and a bad parse would be invisible to the guard.
2. **Coverage gaps weighted by segment length** (spec §4.2a) — `target_gap`/`floor_gap` used to
   count a missing guard the same on an 8-hour segment (morning/night) as a 4-hour one (either half
   of the afternoon split), so the solver was provably indifferent between leaving an 8-guard-hour
   hole and a 4-guard-hour one — confirmed by solving the same real week twice at identical weights
   and getting two different Saturday layouts with an identical score. `segmentWeight()` scales
   each gap by the segment's length (8h segments count double); verified deterministic on live data
   after the fix where it wasn't before.

Both were found and fixed by generating against the real live dataset for week `2026-08-09`
repeatedly, not in the abstract — the segment-weighting bug in particular was only visible by
noticing the Saturday layout wasn't stable across identical repeated generations.

**Investigated and rejected (unchanged from before):** a tiered כמות penalty — see spec §13 item 9,
don't re-attempt without a different underlying mechanism.

**Thirteen test suites, all green** — the eleven from before, plus two new golden fixtures (a
segment-weight tie-break and a preference tie-break) added to Gate E, each empirically constructed
and verified against a hand-patched "before the fix" baseline to confirm the tie it tests was real.

---

## What is left

Nothing blocking. Spec §13 has the full open-items list — everything there is either decided or a
deliberately deferred design choice, not a build gap. Two things Ben deferred deliberately during
step L testing, not build gaps:

- Whether `configured_kamut` should act as a soft *ceiling* (not just a floor) — surfaced once but
  the segment-weighting fix alone independently resolved the case that raised it. Not pursuing
  unless a real case turns up where segment-weighting alone doesn't.
- The demo week `2026-08-09` now carries hand-set עדיפות marks across the whole active roster
  (night preferred over afternoon, afternoon over morning, wherever a guard has both marked the
  same day) — a deliberate sanity-test dataset for step L, not real guard input. See the demo data
  note below before reading a generated roster for that week as a preference-satisfaction demo.

---

## Solver

`VITE_SOLVER_MODE=remote` — generation calls CP-SAT on Render through the `generate-schedule` Edge
Function. Verified end to end: a guard is rejected 403, a manager gets `OPTIMAL` in ~2.5s.

The in-browser mock remains the automatic fallback if Render is unreachable (its free tier sleeps
after 15 minutes idle, ~50s cold start). The mock is always *legal* but never optimal. If a roster
looks wrong, check `solver_status`: `MOCK` means the fallback ran.

**Demo data note:** the 7 mock guards' preferences for week `2026-08-09` were replaced with Ben's
real WhatsApp-sourced availability from the team, so testing against that week reflects genuine
scheduling tension rather than synthetic data. `npm run preview:cpsat` (after dumping the week via
`preview-week.mjs --dump`) is the fastest way to see a fresh CP-SAT result without writing to the
live database.

**Step L addition:** on top of that base availability, every active guard's multi-option days
(any day they marked more than one shift) now also carry a hand-set עדיפות mark, applied by a
consistent priority — night preferred over afternoon, afternoon preferred over morning, whichever
of those the guard actually marked that day. This is a deliberate sanity-test layer for the
preference-strength feature (step L above), not real guard input — don't mistake a generated
roster for this week as evidence real guards' preferences were honoured; it's evidence the
*mechanism* works. One exception worth knowing: Shelly's Wednesday-night availability row was
deleted outright (not just left unpreferred) as a data-hygiene step — she had added it manually
*after* the roster was already published once, so it was never part of a genuine weekly
submission, and leaving it in was distorting her כמות math during testing.

---

## Live environment

- Supabase project `atojvgyxqdbmhhycdcsa` (eu-central-1 / Frankfurt)
- Credentials in `.env.local` — **gitignored**, never committed
- ⚠️ Outbound Postgres ports (5432/6543) are **firewalled on this machine**. `DATABASE_URL` will not
  work; migrations go over HTTPS through the Supabase Management API via `npm run db:apply`.
- Edge Functions `claim-code` and `generate-schedule` are deployed
- Solver live at `https://guard-solver.onrender.com`; `SOLVER_URL` and `SOLVER_SECRET` are set as
  Supabase Edge Function secrets
- 31 migrations applied, tracked in a `schema_migrations` ledger

### Current database contents

- Weeks `2026-08-02` (locked, archive), `2026-08-09` (generated — a fresh draft against the real
  demo data above), `2026-08-16` (open for submissions)
- 9 profiles: Ben, the 7 mock guards (`{שם} - דמה`), and one real team member (עידן) who has already
  claimed their real badge code
- 16 badge codes: the 8 original (Ben + 7 mocks) plus 8 real codes Ben has started registering for
  the actual team (one claimed so far)

`npm run seed:testweek -- --wipe` removes the mock guards and frees their badge codes -- **do not
run this** — the mocks are renamed and Ben is deliberately keeping them, and real registrations are
now in progress alongside them.

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

**A manager's decision beats automation.** Several bugs across this project's history came from
breaking this rule in one direction or another — an auto-disable that locked a guard out, a week
sweep that reverted a manual reopen, `seed.sql` un-deleting an employee, and most recently a week
getting stuck open after the admin cursor moved past it (spec §12.1, §12.3, §12.6). Watch for it —
anything that runs automatically (a sweep, a seed script, a trigger) must never overrule an explicit
human action, including a deletion, and must still eventually reconcile state it's responsible for
even after that state falls outside whatever it was originally scoped to watch.

**Seed data is bootstrap-only, not an ongoing sync.** `db:apply` reruns `seed.sql` on every
invocation, migration or not. Any future seed data needs the same guard `WHERE NOT EXISTS (...)`
pattern the badge-code seed now uses (spec §12.6) — `ON CONFLICT ... DO NOTHING` looks idempotent but
is not once real deletions are possible: a deleted row stops being a conflict.

**Objective weights are measured against live data, not assumed.** Step L's preference weight
(spec §3.8) was tried at 50 before shipping at 2, specifically because 50 was measured to cost two
extra 8-hour-rest occurrences elsewhere in the roster for a gain that 2 achieved almost as well at
zero cost. The segment-weighting fix (§4.2a) was verified the same way: the tie it targets was
confirmed real by temporarily patching the weighting back to flat and watching the solver land on
the worse option in most trials, before trusting that the fix's determinism was actually the fix
working and not a coincidence. A weight change that "should" help is a hypothesis, not a result —
solve real data before and after, and look at what specifically moved.

---

## Housekeeping at end of project

- Revoke the Supabase personal access token (supabase.com/dashboard/account/tokens)
- Rotate the database password (Settings → Database)

Both appear in the development transcript.
