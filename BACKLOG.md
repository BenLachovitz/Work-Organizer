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

## Live at https://work-organizer-iota.vercel.app/

Deployed via Vercel CLI, GitHub integration now connected (spec §11.2) — a push to `main` deploys
automatically from here on, no manual `vercel --prod` needed for ordinary changes. One gotcha hit
along the way: the project's **Deployment Protection** ("Vercel Authentication") was on by default,
which gated every deployment — including production — behind a Vercel account login, so nobody but
Ben could reach the site. Disabled in Settings.

Also fixed post-launch, testing on Ben's own Android phone (a Samsung, Chrome):

- **Direct load / refresh 404 on any non-root route** (e.g. reloading while looking at "סידור
  שבועי") — `vercel.json` was missing entirely, so with `BrowserRouter`'s client-side routing and no
  SPA rewrite, Vercel 404'd at the edge before React Router loaded. Added a catch-all rewrite to
  `index.html`.
- **Login page vertical centering** looked slightly off — tried `min-h-dvh` → `min-h-svh`
  (`src/pages/Login.tsx`, `src/App.tsx`'s `FullScreenLoader`) and `env(safe-area-inset-*)` padding
  first; those were real fixes but not the actual culprit.
- **The actual bug — horizontal overflow on narrow phones.** The 6-digit code boxes
  (`src/components/auth/CodeInput.tsx`) were fixed at `size-12` + `gap-2`, a hard 328px floor for
  the row alone (fixed-width flex items don't shrink below their set size). Adding the card's and
  page's padding, the floor was 400px — wider than several real Android CSS viewports (360–393px).
  That forced the page to scroll horizontally, which is what exposed a strip of the plain
  `bg-slate-100` body background down one side and threw off centering once scrolled off its
  natural rest position. Fixed by shrinking the boxes (`size-10` + `gap-1.5`) so the row fits from
  ~360px up, and added `overflow-x: hidden` on `html` (`src/index.css`) as a systemic guard against
  the same class of bug recurring anywhere else in the app.

**If a different phone brand still shows something off**, start here: this was tested on one
Android/Chrome device only. `size-10` should hold down to a ~360px CSS viewport (verify with that
phone's actual reported width — Chrome DevTools remote debugging, or just ask what device/browser).
A phone narrower than that, or a very different browser's own chrome/gesture-bar insets, is the most
likely next place `overflow-x: hidden` would be silently clipping something rather than it visibly
breaking — worth checking with DevTools' device toolbar at a few widths (360, 375, 393, 412) before
assuming it's something new.

### Three bugs found testing the admin week cursor (8 August), all fixed

All three traced back to the same root cause. Ben changed the submission-window open-time to an
already-past time (confirmed the admin cursor — migration 26 — advances correctly), then changed it
to a future time expecting the cycle to reverse. It didn't fully: a week (`2026-08-16`) that had been
auto-opened while the cursor was briefly ahead got stuck `open`, sitting in the archive view instead
of reverting.

1. **The archived week kept accepting submissions** (migration 28, 29) — `ensure_roster_weeks()`'s
   open/lock sweep only ever reconciled `(v_current, v_next)`, the currently-tracked pair. The
   moment a week fell out of that pair — which the admin cursor can now cause, since it (unlike the
   calendar-only cursor RLS still uses) isn't guaranteed to move only forward — nothing ever swept it
   again. Migration 28 dropped the pair-scoping entirely; that was too broad on its own (it also
   swept test suites' own future-dated fixture rows, breaking `rls.cloud.test.mjs` — caught before
   push), so migration 29 bounds it to a window around the real calendar week
   (`current_week_start() -7 .. +28`) instead, wide enough for anything the admin cursor could
   legitimately reach given `open_offset_days`' `[1,20]` range, nowhere near two-months-out test
   dates.
2. **Selecting an archived week snapped the picker back to "live weeks"** — `ManagerDashboard.tsx`
   fully unmounted (down to a bare spinner) on every week switch, which reset `WeekControlsPanel`'s
   local archive-toggle state. Fixed by keeping the panel mounted and only spinner-ing the
   week-detail section below it.
3. **Changing the deadline setting didn't affect the currently-open week's countdown** — by design
   (spec §12.5), a week's stored deadline was only ever set once, at creation. Too strict for a week
   nobody has manually decided anything about (`status_overridden_at IS NULL`); migration 27 (later
   folded into 28/29's broader, bounded scope) keeps such a week's deadline live against
   `scheduler_settings` on every `ensure_roster_weeks()` call.

Fixed and verified in that order — 3, then 2, then 1 — at Ben's request, so each fix stayed
independently testable against the live broken state before the next one changed it.

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

Nothing. All three items resolved, deploy live on a stable domain, GitHub auto-deploy connected.

### Resolved

- **Item 1 — deploy to Vercel.** Done, 8 August. Live at the URL above; see the note there on the
  Deployment Protection gotcha.
- **Item 2** (`100001`–`100007` being sequential placeholders) — dropped. Now that the mocks are
  renamed to `{שם} - דמה` (item 6, 8 August), they're clearly-labelled demo accounts rather than a
  real-badge-code question; nothing left to decide.
- **Open item 6 — should availability be soft?** (spec §3.2) — **decided: stays hard.** The solver
  will keep never assigning a guard to a slot they didn't mark; a floor breach is reported, not
  auto-filled, and the manager calls someone by phone, same as before this system existed. On the
  one real dataset tested so far, CP-SAT hit zero floor breaches without needing a soft fallback —
  this was insurance against a scenario that hasn't materialized, not a fix for an observed problem.
  No code change. (Ben, 8 August.)

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
