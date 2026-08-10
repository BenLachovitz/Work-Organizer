# START HERE — project status

Short orientation sheet. Full technical detail is in
**[dynamic-guard-scheduler-spec.md](dynamic-guard-scheduler-spec.md) v2.7** — §14 there is the
build status and roadmap, §1.7–§1.8 is the changelog for everything since v2.5. This file
deliberately doesn't re-tell what's already shipped and documented there — it's what's still worth
knowing on top of the spec, not a second copy of the build log.

*Last updated: 11 August 2026*

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

## State: build steps A–O complete, live and in daily use

Full list in spec §14.1; changelog for every step is spec §1.1–§1.8. Steps N and O (10–11 August —
manager preference detail/edit window, submission confirmation modal, dark mode; then the
guard-requested shift count in two phases plus two production bug fixes) are all shipped, merged to
`main`, and deployed — nothing mid-flight, no open branches.

**Investigated and rejected:** a tiered כמות penalty — spec §13 item 9, don't re-attempt without a
different underlying mechanism.

**Eleven test suites, all green** (`npm run test:cloud` + `test:fixtures` + `test_scheduler.py` +
`test:compare` — spec §14.2). Gate E's engine fixtures grew from 8 to 10 in step L, then to 13 in
step O.

**A real production bug was found and fixed in step O** (spec §3.10, §1.8 item 47) — worth knowing
if anything about guard-requested shift counts looks off: a guard's request for *fewer* shifts than
configured was, for one deploy, silently ignored whenever coverage benefited from scheduling them
more anyway (identical to pre-feature behaviour). Root cause and fix are in the spec; re-verified
directly against the production run that surfaced it.

---

## What is left

Nothing blocking. Spec §13 has the full open-items list — everything there is either decided or a
deliberately deferred design choice, not a build gap. Two things still open, not build gaps:

- Whether `configured_kamut` itself should act as a soft *ceiling* for **every** guard (not just a
  floor) — surfaced once in v2.4 testing but the segment-weighting fix alone independently resolved
  the case that raised it, so never pursued as a general policy. A related, narrower question is now
  answered (v2.7, spec §3.10): a guard's own *explicit* request for fewer shifts is a real,
  guaranteed ceiling. Extending that to `configured_kamut` for everyone, unconditionally, is still a
  separate, undecided policy question if it comes up again.
- The demo week `2026-08-09` carries hand-set עדיפות marks across the whole active roster (see
  demo data note below) — a deliberate sanity-test dataset, not real guard input. Any
  `requested_shifts` values on that week from v2.7 testing are the same: a controlled snapshot
  comparison, not live guard requests.

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
live database. Since v2.7, `preview-week.mjs` also takes `--request <guard_id>:<n>` (repeatable) to
try a hypothetical `requested_shifts` value for a specific guard against real data — in-memory only,
nothing written — which is how the step O weight measurement (spec §3.10) was done.

**On top of that base availability**, every active guard's multi-option days (any day they marked
more than one shift) also carry a hand-set עדיפות mark, applied by a consistent priority — night
preferred over afternoon, afternoon preferred over morning, whichever the guard actually marked
that day. This is a deliberate sanity-test layer for the preference-strength feature, not real
guard input — don't mistake a generated roster for this week as evidence real guards' preferences
were honoured; it's evidence the *mechanism* works. One exception worth knowing: Shelly's
Wednesday-night availability row was deleted outright (not just left unpreferred) as a data-hygiene
step — she had added it manually *after* the roster was already published once, so it was never
part of a genuine weekly submission, and leaving it in was distorting her כמות math during testing.

---

## Live environment

- Supabase project `atojvgyxqdbmhhycdcsa` (eu-central-1 / Frankfurt)
- Credentials in `.env.local` — **gitignored**, never committed
- ⚠️ Outbound Postgres ports (5432/6543) are **firewalled on this machine**. `DATABASE_URL` will not
  work; migrations go over HTTPS through the Supabase Management API via `npm run db:apply`.
- Edge Functions `claim-code` and `generate-schedule` are deployed
- Solver live at `https://guard-solver.onrender.com`; `SOLVER_URL` and `SOLVER_SECRET` are set as
  Supabase Edge Function secrets
- 33 migrations applied, tracked in a `schema_migrations` ledger

### Current database contents

- Weeks `2026-08-02` (locked, archive), `2026-08-09` (generated — many draft versions accumulated
  during step L/M/O testing against the demo data above, including roster version 30, the run that
  surfaced the step O production bug (spec §3.10); none published), `2026-08-16` (open for
  submissions)
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

## Five habits worth keeping

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

**A "target" is not a ceiling unless something enforces it as one.** Step O's production bug (spec
§3.10, §1.8 item 47): a guard's lowered `effective_kamut` was correctly computed but only ever fed
into the existing soft floor penalty (P2, weight 100 for falling *short*) — nothing penalised
*exceeding* it, so a guard's explicit "give me fewer shifts" request had no actual effect on the
outcome. Easy to miss because `effective_kamut` reads like it should cap the guard. Any future
change meant to make an outcome "guaranteed" or "never exceeded" needs the real hard-constraint
treatment (a `<=` in CP-SAT, a rejected move in the mock, checked in both referees) — a lowered
target alone only ever changes what gets penalised, never what's actually allowed.

---

## Housekeeping at end of project

- Revoke the Supabase personal access token (supabase.com/dashboard/account/tokens)
- Rotate the database password (Settings → Database)

Both appear in the development transcript.
