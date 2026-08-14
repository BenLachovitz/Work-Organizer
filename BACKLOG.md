# START HERE — project status

Short orientation sheet. Full technical detail is in
**[dynamic-guard-scheduler-spec.md](dynamic-guard-scheduler-spec.md) v2.15** — §14 there is the
build status and roadmap, §1.14 is the changelog for everything since v2.9. This file
deliberately doesn't re-tell what's already shipped and documented there — it's what's still worth
knowing on top of the spec, not a second copy of the build log.

*Last updated: 14 August 2026*

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

## State: build steps A–W complete, live and in daily use

Full list in spec §14.1; changelog for every step is spec §1.1–§1.14. Step P (11 August) — per-day
morning target override, a morning-priority coverage weight, the roster view stacking every
published week instead of a selector, and an admin real/test view-mode toggle — is shipped, merged
to `main`, and deployed, alongside a live production bug fix found while testing it (see below).

Step Q (11 August) — **PWA support** (spec §10.4): a web app manifest, a minimal no-cache service
worker (deliberately no offline caching — this app's Realtime/deadline-sensitive data model makes a
caching service worker a real staleness risk, not just an unused feature), and a full icon set
generated from supplied artwork (`materials/Work-Organizer Icon.jpeg`, via
`npm run generate:icons`) — so the app installs to the home screen on Android Chrome and iOS Safari
and launches standalone. Shipped, merged, deployed. **One thing still open**: real "Add to Home
Screen" verification on a physical Android phone and a physical iPhone — not something that can be
checked from a dev machine (Chrome's mobile emulation only resizes the viewport, it doesn't
reproduce a native install banner). Do this before considering Step Q fully done.

Step R (11 August) — **per-day secondary segment target override** (spec §2.4c, migration 37):
generalizes Step P's morning-only per-day override to the other three segments (early afternoon,
late afternoon, night), overridable on any day of the week and lowered to 1, plus a floor-pinning
fix (`min(1, target)`) so an overridden target of 1 is never misreported as a floor breach. Shipped,
merged to `main`, deployed, `package.json`/`GitVersion.yml` bumped to 2.10.0 and tagged `v2.10.0`.
Nothing open — unlike Step Q's PWA, this feature has no device-dependent manual check pending.

Step S (13 August) — **free-text assignment notes** (spec §12.9, migrations 38–39): when manually
editing a generated roster, the manager can attach short free text before and/or after a guard's
name on one specific cell — e.g. "(מ-10:45)" for an early arrival, "(עד 14:00)" for an early
departure — without reshaping the assignment into a different shift type. Threaded through
`RosterEditor`'s `SlotEditor`, the shared `RosterGrid` (manager and guard-facing), the JPEG export,
and the guard's own "המשמרות שלי" list; deliberately solver-blind, same status as
`weekly_submissions.notes`.

Extended same-day (migration 39) with **placeholder rows**: `schedule_assignments.guard_id` is now
nullable, so a note can sit on a cell with no real guard behind it at all — e.g. "Yam is alone in
the morning until 10:45, then Shely joins" as an annotation on the morning block itself, rather than
a second, real assignment for Shely (who's already genuinely assigned elsewhere that day, and adding
her again for real correctly trips the one-shift-per-day rule as the double-booking it would
actually be). Excluded from every hard-rule check and all coverage/target counting.

Migrations applied to the live database, full TypeScript typecheck clean, and `test:cloud` +
`test:fixtures` + `test:rls` all green (including new Gate E (edit) assertions for the note
round-trip, the 40-character cap, clean rollback on a rejected save, placeholders coexisting with
real rows and with each other without collision, and confirmation that a genuine second real shift
for the same guard is still correctly refused). A placeholder chip's dashed outline (Ben's own first
manual test, on the branch) was dropped in a follow-up commit — it now renders exactly like a real
chip, coloured by its shift, with the note text alone carrying the meaning. Shipped, merged to
`main` (`feature/assignment-cell-notes`), and deployed.

Step T (13 August) — **push notifications** (spec §12.10, migrations 40–42, `send-notifications`
Edge Function): a fixed weekly broadcast (Sunday 11:00 Israel time, everyone) announcing that
week's real submission deadline, plus two reminders (~24h and ~2h before the deadline) sent only to
guards who haven't submitted yet. Push-only, by explicit decision — no fallback for a guard who
never installs the app. First use of `pg_cron`/`pg_net` in this project, and the scheduling design
changed twice mid-build, both times because of a real Supabase permission wall rather than a change
of mind (full account in spec §12.10): `ALTER DATABASE ... SET cron.timezone` is rejected outright
on hosted Postgres (`55P02`, needs a restart no client can trigger), so the three-precomputed-
weekly-cron-times design became one 15-minute tick doing pure `TIMESTAMPTZ` comparisons instead —
and `ALTER DATABASE ... SET app.settings.*` for secrets is *also* rejected (`42501`, permission
denied), so those moved from GUCs to an ordinary table with zero RLS policies at all. Worked around
a third platform gap too: `pg_cron` can never run inside Gate A's local PGlite (no background-worker
support, permanent) — migration 41 catches that specific failure in a `DO` block and logs a
`NOTICE` instead of erroring, so every migration after it still applies locally and Gate A keeps
testing them, matching this project's stated principle that migrations are discovered, never
skipped. Two real bugs caught in review before shipping, both asserted explicitly in the new Gate G:
an early draft of `unsubmitted_targets()` filtered to `role = 'guard'`, which would have silently
excluded Ben from his own reminders (he's a manager *and* an active guard, spec §2.1); and the
"find the open week" query used `.maybeSingle()`, which would throw rather than degrade if a
manager's manual override ever left two weeks open at once. `npm:web-push` confirmed to actually
run in Supabase's Deno Edge Function runtime via a standalone smoke test before the real function
was written. VAPID keys generated once locally; secrets deployed via the Supabase CLI
(`SUPABASE_ACCESS_TOKEN` already authenticates it non-interactively — no dashboard clicking needed).
Migrations applied to the live database, full TypeScript typecheck clean, and `test:cloud` +
`test:rls` + `test:fixtures` all green (12 suites now, Gate G new). Shipped, merged, deployed
directly to `main` — Ben's explicit call for this feature, to keep mobile testing simple, backstopped
by the same GitVersion tag discipline for rollback. **Real on-device delivery confirmed the same
day**: an isolated, throwaway test week was used to invoke `send-notifications` directly for both
the broadcast and the `reminder_24h` type (bypassing the 15-minute tick to test immediately), and
Ben confirmed both arrived on his own installed PWA. Nothing left open on this one.

Step U (13 August) — **notification click routing**: tapping a push notification now opens (or
navigates an already-open tab to) `/preferences` directly, instead of just opening the app to
whatever page it happened to be on — all three notification types exist to get a guard to submit,
so all three should land there. Carried in the push payload's `url` field, read by the service
worker's `notificationclick` handler; not hardcoded, so a future notification type pointing
elsewhere needs no new client code. `send-notifications` redeployed with the change.

Step V (14 August) — **manual "roster published" broadcast** (spec §12.10, migrations 43–44):
a manager-only button next to the JPEG export announces a published week to every guard on
demand, via a new `roster_published` push type — deliberately separate from publishing itself,
since a manager sometimes publishes just to check the layout, not to ship it. Unlike the three
cron-driven types, this one can be pressed more than once per week (e.g. after republishing a
correction): `notification_log_sent_once`'s partial unique index was narrowed to exclude it,
keeping the strict once-ever guarantee for the automatic broadcast/reminders unchanged.
`send-notifications` gained a second auth path — a manager's own JWT, checked server-side via
`is_manager()` (never trusting the client), scoped to this one type only, alongside the existing
cron-secret path a browser cannot use. Also shipped in the same migration: `publish_roster(p_run_id)`,
a real RPC replacing the three separate, non-atomic client writes publishing used to do — the one
manager action of its kind that never got the same RPC treatment as its siblings
(`unpublish_run`/`delete_schedule_run`) — and which finally sets `published_at`, a column that
existed on `schedule_runs` from the start but was never once written. One real bug caught by
`test:cloud` before this shipped: narrowing the unique index's predicate silently broke
`claim_notification_send`'s `ON CONFLICT` arbiter for the three existing cron types (`42P10`),
fixed in a same-day follow-up migration (44) rather than editing the already-applied migration 43.
Migrations applied to the live database, `send-notifications` redeployed, full TypeScript typecheck
clean, and `test:cloud` (new Gate G + Gate E assertions) + `test:fixtures` + `test:rls` all green.
Shipped, `package.json`/`GitVersion.yml` bumped to 2.14.0, tagged `v2.14.0`. **One thing still
open**: real on-device push delivery for the new `roster_published` type hasn't been confirmed the
way Step T's three original types were (§12.10) — the automated suite deliberately only exercises
the auth-rejection paths (403/400), for the same reason Gate G never invokes the real function for
a success case: it would broadcast to every real subscribed guard, including Ben's own phone, on
every test run. Do this manually before considering Step V fully done.

Step W (14 August) — **manager notified on guard submit/edit/cancel** (spec §12.10, migration 45):
two new push types, `guard_submitted` (new submission or an edit, distinguished in the copy) and
`guard_cancelled`, sent to every `manager_targets()` row (role-based, not hardcoded to Ben) whenever
a guard saves or cancels their own availability. **Deliberately client-triggered, not a database
trigger** — the original plan called for a trigger on `weekly_submissions`, but implementation
surfaced a real problem first: `test:cloud` calls `save_week_preferences`/`delete_week_submission`
directly, dozens of times per run, against the live project (there is no separate test database
here), so a table-level trigger would have paged Ben's real phone on every future test run. Moved to
firing from `useSavePreferences`/`useDeleteSubmission`'s `onSuccess` instead — test scripts talk to
the RPC over `supabase-js` directly, never through React, so they never reach the code that sends it.
This also excludes the manager's own edit-on-behalf-of path (`manager_save_week_preferences`, a
separate hook in `useManager.ts`) for free, with no `auth.uid()` guard needed, since that path was
simply never wired to notify. `send-notifications` verifies both the caller's identity (their own JWT
must resolve to the `guard_id` being reported — any guard may report only their own event) and the
claimed event itself (a submission row must actually exist for submit/edit, actually not exist for
cancel) server-side, rather than trusting the request body. Neither type is deduped — each real
submit, edit, or cancel is its own distinct, reviewable event.

Migrations applied to the live database, `send-notifications` redeployed, full TypeScript typecheck
clean, and `test:cloud` (10 new Gate G assertions: `manager_targets()` targeting, both types' repeat-
send behaviour, and five auth/verification rejection paths) + `test:fixtures` + `test:rls` all green.
Shipped, `package.json`/`GitVersion.yml` bumped to 2.15.0, tagged `v2.15.0`.

**Real-device testing (same day) immediately found a real bug the automated suite's deliberate
avoidance of the success path had let through**: Ben submitted preferences for a real test employee
and got no notification at all. `notification_log` had zero `guard_submitted`/`guard_cancelled` rows
ever — the request never got far enough to log anything. Root cause: `asCaller.auth.getUser()` was
called with no argument, relying on the manually-injected `Authorization` header being picked up
automatically. That works for `.rpc()`/`.from()` (PostgREST calls, which is why `roster_published`'s
`is_manager()` check was fine) but not for the GoTrue auth client, which has no session of its own —
it needs the token passed explicitly (`getUser(token)`), same as Supabase's own documented Edge
Function pattern. Every real guard's submit/edit/cancel was silently failing the identity check.
Fixed, wrapped in a `try`/`catch` so a malformed token now fails closed (403) rather than crashing
the request (500), redeployed, and confirmed against the live function with the actual
`functions.invoke()` SDK path (not just raw `fetch`, which had misleadingly passed in the original
test): a safe validation path correctly reached 400, and a full send-path run delivered a real push
(`sent: 1, targets: 1`) to Ben's phone. `package.json`/`GitVersion.yml` bumped to 2.15.1, tagged
`v2.15.1`. **Nothing left open on this one** — unlike Steps V/W's original ship, this one now has a
confirmed real on-device delivery, found via exactly the kind of manual test those steps were still
waiting on.

Nothing else mid-flight, no open branches.

**Investigated and rejected:** a tiered כמות penalty — spec §13 item 9, don't re-attempt without a
different underlying mechanism.

**Twelve test suites, mostly green** (`npm run test:cloud` + `test:fixtures` + `test_scheduler.py` +
`test:compare` — spec §14.2). Gate E's engine fixtures grew from 8 to 13 in step L/O, then to 15 in
step P. Gate G (`test:notifications`, step T) is the newest addition. **Gate D has a known,
pre-existing, date-driven flake** — spec §14.2 has the full mechanics;
short version: its dedicated test week (`2026-09-06`) now sits exactly on `ensure_roster_weeks()`'s
sweep-window boundary, so real production traffic mid-test-run can sweep the test's own fixture row.
Not a regression, self-resolves as the calendar moves past mid-September 2026; deliberately left
unfixed (Ben's call, 11 August) rather than touched as part of an unrelated feature branch.

**A real, live production bug was found and fixed in step P**, purely as a side effect of manually
testing the new features in a browser (spec §12.1, §1.9 item 57): `ensure_roster_weeks()`'s
"keep every untouched week's deadline live" step performed an unconditional `UPDATE`, and a
same-value write still broadcasts a Realtime event — which the manager dashboard's own realtime
subscription reacted to by re-triggering the same call, forever, for as long as `/manage` stayed
open. Confirmed live against the production project (roughly one `ensure_roster_weeks()` call every
100ms) before being fixed and re-verified gone.

---

## What is left

Nothing blocking. Spec §13 has the full open-items list — everything there is either decided or a
deliberately deferred design choice, not a build gap. Four things still open, not build gaps:

- **PWA real-device install check** (Step Q, spec §10.4) — everything checkable from a dev machine
  (manifest, service worker activation, icon resolution, `vercel.json` static-asset headers) is
  verified against both `vite preview` and production. Actually adding the app to a home screen on a
  physical Android phone and a physical iPhone still needs Ben to do it himself.
- **Notification click routing confirmation** (Step U, spec §12.10) — the push-send path itself is
  confirmed live (Step T), but tapping a notification and landing on `/preferences` specifically is
  new with this step and hasn't been tapped on a real device yet.
- **`roster_published` real-device delivery confirmation** (Step V, spec §12.10) — same class of gap
  as the two items above: everything checkable without pushing to a real phone (auth paths, schema,
  idempotency) is covered by `test:cloud`; actually pressing the button and confirming it arrives on
  Ben's installed PWA still needs Ben to do it himself.
- ~~`guard_submitted`/`guard_cancelled` real-device delivery confirmation~~ — resolved the same day
  Step W shipped: Ben's own real-device test caught the auth bug above, and the fix was confirmed via
  a live `functions.invoke()` run that actually delivered (`sent: 1, targets: 1`). Nothing open here.
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

**The 7 mock guards are now explicitly flagged** (`is_demo = TRUE` on `profiles`/`roster_codes`,
migration 34, spec §12.8) rather than only identifiable by their `- דמה` display-name suffix. This
is what the admin header's real/test view-mode toggle filters on — display-only, doesn't change who
the solver schedules.

**Weight measured, not assumed — still open for the newest one.** Step L's preference weight and
step O's stretch weight were each verified against live data before shipping (spec §3.8, §3.10). The
new step P `WEIGHTS.morning_priority` bonus (spec §4.2b) shipped at a starting hypothesis of **1**,
not yet measured the same way — worth running the same before/after comparison via
`npm run preview:cpsat` before trusting it as final, the same discipline the habit below describes.

---

## Checking notification history (Step T, spec §12.10)

While testing push notifications, run this in the Supabase SQL editor (Dashboard → project
`atojvgyxqdbmhhycdcsa` → SQL Editor) to see what fired, what was skipped, and why — most recent
first:

```sql
SELECT
  nl.notification_type,
  COALESCE(p.display_name, CASE WHEN nl.guard_id IS NULL THEN 'כלל המערכת' ELSE '(מדריך מחוק)' END) AS target,
  nl.week_start,
  nl.intended_at AT TIME ZONE 'Asia/Jerusalem' AS intended_local,
  nl.sent_at     AT TIME ZONE 'Asia/Jerusalem' AS sent_local,
  nl.status,
  nl.detail,
  nl.created_at  AT TIME ZONE 'Asia/Jerusalem' AS logged_local
FROM notification_log nl
LEFT JOIN profiles p ON p.id = nl.guard_id
ORDER BY nl.created_at DESC
LIMIT 200;
```

To trigger a send immediately instead of waiting for the next real cron tick (fires every 15
minutes) — useful for testing faster:

```bash
curl -X POST "https://atojvgyxqdbmhhycdcsa.supabase.co/functions/v1/send-notifications" \
  -H "x-cron-secret: <the CRON_SHARED_SECRET value>" \
  -H "Content-Type: application/json" \
  -d '{"type":"broadcast"}'   # or "reminder_24h" / "reminder_2h"
```

`status` values: `sent`, `skipped_already_sent` (idempotency did its job), `skipped_out_of_window`
(a reminder fired outside its ±20-minute tolerance — check `intended_at` vs. now),
`skipped_no_subscription` (the target guard hasn't enabled notifications), `skipped_no_open_week`
(nothing is currently open for submissions), `failed` (every one of that guard's subscriptions
rejected the push — often a stale subscription that's already been pruned by the time you look).

---

## Live environment

- Supabase project `atojvgyxqdbmhhycdcsa` (eu-central-1 / Frankfurt)
- Credentials in `.env.local` — **gitignored**, never committed
- ⚠️ Outbound Postgres ports (5432/6543) are **firewalled on this machine**. `DATABASE_URL` will not
  work; migrations go over HTTPS through the Supabase Management API via `npm run db:apply`.
- Edge Functions `claim-code`, `generate-schedule`, and `send-notifications` are deployed
- Solver live at `https://guard-solver.onrender.com`; `SOLVER_URL` and `SOLVER_SECRET` are set as
  Supabase Edge Function secrets
- `pg_cron`/`pg_net` enabled (first use in this project, spec §12.10); one job, `notification_tick`,
  fires every 15 minutes. `CRON_SHARED_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and
  `VAPID_SUBJECT` are set as Supabase Edge Function secrets; the matching `notify_url`/`cron_secret`
  pair lives in the `notification_secrets` table (not a GUC — see spec §12.10 for why), set via a
  plain `UPDATE`, not committed anywhere
- 45 migrations applied, tracked in a `schema_migrations` ledger

### Current database contents

- Weeks `2026-08-02` (locked, archive), `2026-08-09` (generated — many draft versions accumulated
  during step L/M/O testing against the demo data above, including roster version 30, the run that
  surfaced the step O production bug (spec §3.10); none published), `2026-08-16` (open for
  submissions, morning target 3)
- 9 profiles: Ben, the 7 mock guards (`{שם} - דמה`, now also flagged `is_demo = TRUE`), and one real
  team member (עידן) who has already claimed their real badge code
- 16 badge codes: the 8 original (Ben + 7 mocks) plus 8 real codes Ben has started registering for
  the actual team (one claimed so far)

`npm run seed:testweek -- --wipe` removes the mock guards and frees their badge codes -- **do not
run this** — the mocks are renamed and Ben is deliberately keeping them, and real registrations are
now in progress alongside them.

---

## Versioning (GitVersion.yml, introduced Step Q)

`GitVersion.yml` at the repo root is the single source of truth for "what version are we at" — kept
in step by hand with `package.json`'s `version` and an annotated `vX.Y.Z` git tag on the commit that
ships each version. There's no CI pipeline running the actual GitVersion.Tool CLI yet, so this is a
manual-but-disciplined convention, not an automated one: **before the commit that ships a version,
bump `next-version` in `GitVersion.yml` and `version` in `package.json` together, then tag the
commit** — that trio is what actually enables rollback (`git checkout vX.Y.Z` reproduces exactly the
state that version describes), matching the spec's own version history. Currently at **2.15.1**
(fix: guard_submitted/guard_cancelled auth was silently failing for every real guard), tagged
`v2.15.1`.

## Commands

```bash
npm run dev              # Vite dev server on :5173
npm run db:apply         # apply pending migrations (ledger-tracked, idempotent)
npm run db:verify        # RLS + reachability audit
npm run seed:testweek    # load a week of guard availability
npm run preview:week     # read-only: what the MOCK would produce
npm run preview:cpsat    # the same input through CP-SAT
npm run test:cloud       # all nine cloud suites against the live project
npm run generate:icons   # regenerate public/icons/* from materials/Work-Organizer Icon.jpeg
```

---

## Six habits worth keeping

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
solve real data before and after, and look at what specifically moved. Step P's `morning_priority`
bonus (spec §4.2b) shipped without this measurement yet — flagged above, still open.

**A "target" is not a ceiling unless something enforces it as one.** Step O's production bug (spec
§3.10, §1.8 item 47): a guard's lowered `effective_kamut` was correctly computed but only ever fed
into the existing soft floor penalty (P2, weight 100 for falling *short*) — nothing penalised
*exceeding* it, so a guard's explicit "give me fewer shifts" request had no actual effect on the
outcome. Easy to miss because `effective_kamut` reads like it should cap the guard. Any future
change meant to make an outcome "guaranteed" or "never exceeded" needs the real hard-constraint
treatment (a `<=` in CP-SAT, a rejected move in the mock, checked in both referees) — a lowered
target alone only ever changes what gets penalised, never what's actually allowed.

**A same-value write still broadcasts a change — audit anything realtime-adjacent for this.** Step
P's production bug (spec §12.1, §1.9 item 57): `ensure_roster_weeks()`'s deadline-refresh `UPDATE`
had no guard checking whether the computed value actually differed from what was stored, so it
rewrote the same value on every call. Postgres still performs a physical row write for a same-value
`SET`, and Realtime broadcasts that as a genuine change regardless — which a subscriber reacting to
it by re-invalidating and re-fetching turned into an infinite loop, live, in production. Any write
inside a function a realtime-subscribed table's listener can indirectly re-trigger needs a value
guard (`WHERE ... IS DISTINCT FROM ...`), the same discipline the two status-reconciliation `UPDATE`s
in that same function already used correctly — one unguarded write among several guarded ones was
enough.

---

## Housekeeping at end of project

- Revoke the Supabase personal access token (supabase.com/dashboard/account/tokens)
- Rotate the database password (Settings → Database)

Both appear in the development transcript.
