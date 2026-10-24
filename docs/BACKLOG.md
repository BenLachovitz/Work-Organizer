# START HERE — project status

Short orientation sheet. Full technical detail is in
**[dynamic-guard-scheduler-spec.md](dynamic-guard-scheduler-spec.md) v2.26.1** — §14 there is the
build status and roadmap, §1.17–§1.29 is the changelog for everything since v2.15. This file
deliberately doesn't re-tell what's already shipped and documented there — it's what's still worth
knowing on top of the spec, not a second copy of the build log.

*Last updated: 21 October 2026*

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

## State: build steps A–AF complete, live and in daily use

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

Step X (14 August) — **passkey (Face ID / fingerprint) login + remember-me** (spec §8): guards can
now register a device passkey from Preferences and use it instead of typing their badge code + PIN.
Built entirely on `@supabase/supabase-js`'s **native, experimental Passkey/WebAuthn API**
(`registerPasskey()`, `signInWithPasskey()`, `auth.passkey.{list,update,delete}`) discovered mid-plan
in the already-installed `^2.112.2` — GoTrue does the whole ceremony and stores credentials itself,
so unlike every other feature in this project's history, **this one needed zero new migrations and
zero new Edge Functions**, just `experimental: { passkey: true }` on the client and UI wiring.

A device with a registered passkey is gated behind it on every fresh app load (not on every
background/foreground cycle — Ben's call): a local-only `wo.hasPasskey` flag, set after a successful
`registerPasskey()` on that device, makes `AuthContext`'s bootstrap effect skip silently resuming the
persisted session and instead surface a new `'locked'` status, which `Login.tsx` renders as an unlock
screen calling `signInWithPasskey()`. The underlying session is left untouched until that succeeds,
so a cancelled/failed ceremony always falls back to normal badge-code + PIN — passkey is additive,
never a lockout. Guards *without* a passkey get the persistence the badge-code flow already had
implicitly (`persistSession: true` was always-on, no toggle) made explicit and controllable: a new
`wo.rememberMe` flag (default on, so nobody's current behaviour changes unless they opt out) drives a
custom switchable storage adapter in `src/lib/supabase.ts` that delegates to `localStorage` or
`sessionStorage` per call, with a Preferences toggle that migrates the live session between the two
immediately rather than forcing a logout.

**One planning assumption corrected before shipping**: the plan initially expected `http://localhost:5173`
could sit alongside the production origin in Supabase's Relying Party Origins list for local testing.
It can't — WebAuthn's same-origin/domain-suffix check is enforced by the *browser*, not just
Supabase's server, so a `localhost` origin is simply incompatible with a production RP ID, and a
non-`localhost` LAN IP (what a phone actually hits against `npm run dev`) fails WebAuthn's HTTPS
requirement regardless. RP ID was set to the real production domain
(`work-organizer-iota.vercel.app`) with no localhost origin — the passkey ceremony itself can only be
verified against the live deployment, the same class of real-device-only check as the PWA install
verification (Step Q) and push notifications (Steps T/V/W).

Full TypeScript typecheck clean and `test:cloud` all green (192 assertions, unchanged from before this
step) — expected, since nothing backend changed; this is a pure regression check, not real coverage of
the new code. **There is no automated coverage of the passkey/remember-me code itself**: this project
has no frontend test runner, and WebAuthn ceremonies can't be scripted headlessly without a virtual
authenticator, which is a bigger addition than this feature justifies right now. Shipped,
`package.json`/`GitVersion.yml` bumped to 2.16.0, tagged `v2.16.0`.

**Step X revised, same day — real-device testing changed the design.** Registering a passkey on
Ben's Android phone worked exactly as coded, but exposed what the native Supabase Passkey API
actually is: a true, **discoverable, OS-synced passkey**, shown in the phone's system "Passwords &
passkeys" list and eligible to sync to Ben's Google account — not the app-scoped, device-only
credential this was meant to be. WebAuthn supports that directly (`residentKey: 'discouraged'`
produces a non-resident credential that doesn't sync and isn't offered through the OS account-picker
UI), but Supabase's native Passkey API doesn't expose that option — it's deliberately built only for
true discoverable passkeys. **v2.16.0's mechanism was replaced wholesale** with a from-scratch
WebAuthn implementation (`@simplewebauthn/browser` client-side, `@simplewebauthn/server` in a new
`webauthn` Edge Function, migration 46's `webauthn_credentials`/`webauthn_challenges` tables) —
undoing the "zero backend code" property v2.16.0 had, which was always the trade-off for using
Supabase's native API in the first place. The UX already validated in v2.16.0 (restart-only lock
gate, additive-never-a-lockout, default-on remember-me for guards without a passkey) carried over
unchanged; only the credential mechanism underneath it changed.

The one real design consequence: a non-discoverable credential means the server must know which
credential to challenge before the WebAuthn ceremony starts, so sign-in lost the "no username
needed" property true passkeys have. Solved with a local-only `wo.webauthnGuardId` (renamed from
`wo.hasPasskey`) that identifies which guard registered on this specific device — sent to the new
Edge Function only as a hint for building `allowCredentials`, never as a trust boundary; the actual
authorization is the cryptographic signature checked server-side against that guard's stored public
key. `register-*` actions verify the caller's own identity from their own JWT using the exact
`asCaller` + `getUser(token)` pattern `send-notifications` already established (and the exact lesson
v2.15.1 had to learn the hard way about `getUser()` needing its token passed explicitly). A
successful sign-in mints a real Supabase session with no password involved:
`admin.generateLink({ type: 'magiclink' })` returns a token without ever sending mail, immediately
exchanged server-side via `verifyOtp({ token_hash, type: 'magiclink' })` for a real session, whose
tokens alone are handed back to the browser to install with `supabase.auth.setSession()`.

RP ID/origin moved from a Supabase Dashboard setting (pinned to one value for the whole project) to
a hardcoded allowlist inside the Edge Function itself, keyed off the request's `Origin` header:
the real production origin, plus `http://localhost:5173` as a second, entirely separate RP for local
dev testing — something the native-API approach could never offer, since a credential registered
under one RP ID simply doesn't verify under another. The Supabase Dashboard's passkey toggle from
earlier the same day is unused now and can be left as-is.

Known, stated platform limit, not a bug: Android honours `residentKey: 'discouraged'` and never
syncs the credential; **Apple's platform authenticator can still create a synced iCloud Keychain
passkey even when asked for `discouraged`** — "never synced" is a strong guarantee on Android and
only a best-effort one on iPhone. Confirmed against real WebAuthn behaviour before committing to the
design, not assumed.

New **Gate H** (`test:webauthn`, `supabase/tests/webauthn.cloud.test.mjs`, 22 assertions): RLS on
both new tables (an owner can read/rename/delete only their own credential row; a different guard
gets nothing; a manager can read any row; direct client `INSERT` is rejected outright — no grant
exists, only the Edge Function's service-role client may ever create a row; `webauthn_challenges` is
completely unreachable via PostgREST regardless of role), and the Edge Function's auth/verification
paths — missing/malformed caller JWT, an origin outside the allowlist, a `guard_id` with no
credentials, a malformed `guard_id`, and a bogus credential response rejected cleanly (400, not a
crash) on both `register-verify` and `auth-verify`, including proof that a consumed challenge cannot
be replayed. Same deliberate scope as Gate G never invoking `send-notifications` for a real push:
a genuine end-to-end ceremony still needs a physical authenticator or a browser's virtual-
authenticator API, neither of which this suite uses — what IS exercised for real is
`generateRegistrationOptions()`/`generateAuthenticationOptions()` actually running against the live
Deno Edge Function runtime and producing well-formed output, which doubles as the "confirm a new
runtime dependency actually works before trusting it" smoke test `send-notifications` set the
precedent for with `npm:web-push` (spec's Step T account).

Full TypeScript typecheck clean, `test:cloud` all green (10 suites, 214 assertions — Gate H is new).
Shipped, `package.json`/`GitVersion.yml` bumped to 2.17.0, tagged `v2.17.0`. **Still open, same as
v2.16.0 left it**: real-device confirmation that registering now produces a credential which does
*not* appear in the phone's system Passwords & passkeys list, and that the restart lock screen's
`signInWithPasskeyDevice()` unlock actually works end to end.

Step X, one more revision (14 August) — **proactive passkey-setup nudge**: registering a passkey
needs an active session (`register-options`/`register-verify` resolve the guard from their own JWT),
so the setup step can never live ON the login screen itself — a guard has to be signed in first,
which was the actual answer to "why does this only live in Preferences." But leaving it *only*
reachable from Preferences meant a guard would likely never discover it at all. Added a dismissible
`PasskeyPrompt` card to `GuardHome` (`src/pages/GuardHome.tsx`), the guard's first screen after
login — same established pattern as the existing push-notification enable-prompt card right above
it (`NotificationPrompt`, spec §12.10): shown only while the device supports WebAuthn and this guard
has no passkey on it yet, "לא עכשיו" hides it for good via a localStorage flag, and Preferences
remains the permanent place to add/rename/remove a passkey afterward (e.g. after getting a new
phone) rather than only a first-run entry point. `package.json`/`GitVersion.yml` bumped to 2.17.1,
tagged `v2.17.1`.

Step X, one more revision (14 August) — **24-hour grace window on the restart-lock gate**. Real-
device testing found the gate far too aggressive: every JS boot, including a plain browser refresh,
looks identical to `AuthContext`'s bootstrap effect — there is no lighter-weight signal for "genuine
reopen after time away" versus "same session, page just reloaded," so gating on *every* boot meant
re-prompting on every refresh, not just an actual restart days later. Fixed with a new
`wo.webauthnUnlockedAt` timestamp (`src/lib/supabase.ts`): the lock screen is skipped whenever a real
`signInWithPasskey()` (or a fresh registration) succeeded within the last 24 hours, and shown
otherwise. Deliberately **only** ever set by an actual biometric verification, never extended by a
mere silent resume — a device opened once a day without ever needing to unlock again would defeat
the point of gating it at all. 24h chosen over a 7-day or "only on session loss" alternative — Ben's
call, weighed as balancing routine daily use against how long a lost/stolen phone would stay
unlockable on the persisted session alone before the biometric check matters again.
`package.json`/`GitVersion.yml` bumped to 2.17.2, tagged `v2.17.2`.

Step X, one more revision (14 August) — **dropped the "locked" screen entirely**. Ben's call after
using it for real: a separate unlock UI felt inconsistent with the rest of the app, and he wanted one
plain, familiar screen rather than a second "locked" identity. `AuthStatus` loses its `'locked'`
member; when the passkey grace window has expired, `AuthContext`'s bootstrap effect now calls
`supabase.auth.signOut({ scope: 'local' })` and lands on the ordinary `signedOut` state — the exact
same Login page every signed-out guard already sees, which already puts the passkey sign-in button
up front (Step X's original build). `scope: 'local'` matters: this only clears the current device's
stored session: an automatic, per-device timeout must never revoke a session this guard has active
elsewhere just because one phone's grace window lapsed. `PasskeyLockScreen` and the `useCodeInstead`
escape hatch it needed are gone along with it — nothing replaces them, since the normal Login page
already covers the same ground. `package.json`/`GitVersion.yml` bumped to 2.17.3, tagged `v2.17.3`.

Step X, one more revision (14 August) — **login UX reworked per Ben's direction, and the
Preferences management card is gone**. Three changes, all from the same conversation:

1. **Remember-me moved from Preferences to the Login page itself** — under the personal PIN
   `CodeInput` on both the `pin` and `setPin` steps (not under the badge code step, which doesn't
   yet identify anyone). `getRememberMe()`/`setRememberMe()` (`src/lib/supabase.ts`, unchanged since
   Step X's original build) are called the instant the toggle flips, before the guard even submits —
   the switchable storage adapter only reads the flag at the moment a session is actually written, so
   by the time `signIn()`/`claim()` succeeds moments later, the new session already lands in the
   right place with no separate "apply after login" step needed.
2. **The passkey management card dropped entirely** — Ben's view: nobody needs to *delete* a
   passkey, so the whole list/rename/remove UI was redundant. `usePasskey.ts` and
   `src/lib/webauthn.ts` lost `remove`/`rename` (and the now-pointless `PasskeyRow` list — replaced
   by a single `hasRegisteredPasskey()` existence check, since nothing ever needed the actual rows
   once nothing renders them). The DB-level RLS UPDATE/DELETE policies on `webauthn_credentials`
   (migration 46) are untouched — self-scoped to a guard's own row regardless, so leaving them is
   harmless — this was a UI decision, not a request to lock the table down further.
3. **The Login page's passkey button became hybrid**, matching the pattern nearly every consumer
   app with biometric login uses: a purely local, instant check for whether this device already has
   a credential (`getPasskeyGuardId()`). If yes, the button runs the real sign-in ceremony exactly as
   before. If not — which used to be impossible to reach since the button was hidden in that case —
   it now falls through to the ordinary badge-code + PIN login and sets a one-shot
   `wo.passkeySetupIntent` flag (`markPasskeySetupIntent()`/`consumePasskeySetupIntent()`,
   sessionStorage, consumed at most once). `GuardHome`'s existing `PasskeyPrompt` nudge (Step X's
   earlier revision) checks that flag on mount and force-shows itself for this one occurrence even if
   previously dismissed — the guard just explicitly asked for it again by tapping the button, so a
   past "not now" shouldn't stand in the way. This also closes the gap the management-card removal
   opened: with no Preferences fallback and a nudge that dismisses forever, a guard who skipped the
   home-screen prompt now has this button as a second, always-available way back in.

Full TypeScript typecheck clean, `test:cloud` all green (unchanged, 10 suites/214 assertions — no
backend touched by any of this). `package.json`/`GitVersion.yml` bumped to 2.18.0, tagged `v2.18.0`.

Step X, one more revision (14 August) — **the hybrid flow above wasn't actually fluent**. Real-device
testing (Ben) found two problems with the 2.18.0 build: tapping the passkey button showed the "log in
with your code first" text but never visibly moved focus into the code input, and after logging in
nothing happened automatically — the setup only ever started if he found and tapped the separate
GuardHome nudge card. Both traced back to the same root cause done differently than intended:

1. **Focus.** `CodeInput`'s `autoFocus` only fires once, on mount — clicking the passkey button
   re-renders the same already-mounted `Login`, so it never refires, and mobile browsers generally
   suppress even a genuine mount-time `autoFocus` keyboard pop-up outside a real user gesture anyway.
   `CodeInput` gained an imperative handle (`forwardRef` + `useImperativeHandle`, exposing `focus()`)
   so `tryPasskey()`'s no-passkey branch can force focus into the code input from directly inside the
   click handler — a real user gesture mobile browsers do honour.
2. **Auto-setup.** The previous design deferred registration to a `wo.passkeySetupIntent`
   sessionStorage flag consumed by GuardHome on mount, requiring one more tap on its nudge card to
   actually fire the WebAuthn ceremony. Replaced with a direct call: `submitPin`/`submitNewPin` now
   call a new `maybeAutoRegisterPasskey()` immediately after a successful `signIn()`/`claim()`, in the
   very same async chain as the PIN submit button's click — the ceremony needs to run reasonably close
   to a genuine user gesture or the browser silently refuses it, and by the time GuardHome mounts on a
   fresh navigation that gesture is long gone. Best-effort: any failure or cancellation is swallowed
   silently, since GuardHome's passive nudge card (untouched, same as before) remains as a fallback
   either way. `markPasskeySetupIntent`/`consumePasskeySetupIntent` and the sessionStorage flag they
   drove are gone — no longer needed now that the whole thing happens inline, same click, no
   deferral. The result: tap the passkey button with nothing set up → keyboard pops open on the code
   input → log in normally → the Face ID/fingerprint prompt appears on its own, no second tap.

Full TypeScript typecheck clean, `test:cloud` all green (unchanged — still no backend involved).
`package.json`/`GitVersion.yml` bumped to 2.18.1, tagged `v2.18.1`.

Nothing else mid-flight, no open branches.

Step Y (14 August) — **removed the header bell icon that let a guard mute/disable push
notifications** (spec §12.10). Ben's call: these notifications carry real schedule-affecting
updates (submission deadlines, roster publishes), and he doesn't want anyone able to silence them
through the app for any reason. Went further than just hiding the button — the underlying disable
capability is gone too, not merely unreachable: `useNotifications.ts` lost `disable`/`toggle` in
favor of a single `enable`, and `src/lib/push.ts` lost `unsubscribeFromPush()` entirely, since
nothing calls it anymore. `GuardHome`'s existing one-time enable-prompt card (unchanged in shape,
just now calls `enable` directly instead of `toggle`) is the only in-app notification control left,
and it was already enable-only in practice — it only ever renders while
`Notification.permission === 'default'`, so by the time a guard could want to disable something,
the card is already gone.

Worth being upfront about the actual limit here: this removes the *in-app* way to mute
notifications. It was never possible, and still isn't, for a web app to prevent a guard from
disabling notifications for the PWA at the OS/browser level (phone Settings → Notifications, or the
browser's own site-permission UI) — that control has never belonged to this app and no code change
here or anywhere else could take it away. What this change removes is the easy, one-tap in-app path
that made muting them a casual, low-friction choice.

Full TypeScript typecheck clean, `test:cloud` all green (10 suites unchanged — no backend touched;
one run hit a known-flaky realtime websocket-timing assertion that passed clean on its own and on
a full re-run immediately after, not a regression). `package.json`/`GitVersion.yml` bumped to
2.19.0, tagged `v2.19.0`.

**Investigated and rejected:** a tiered כמות penalty — spec §13 item 9, don't re-attempt without a
different underlying mechanism.

**Thirteen test suites, mostly green** (`npm run test:cloud` + `test:fixtures` + `test_scheduler.py` +
`test:compare` — spec §14.2). Gate E's engine fixtures grew from 8 to 13 in step L/O, then to 15 in
step P. Gate H (`test:webauthn`, step X's revision) is the newest addition. **Gate D has a known,
pre-existing, date-driven hazard, not merely a flake** — spec §14.2 has the full mechanics, and
Step AE below has the full account of what it actually did on 3 September 2026: its dedicated test
week (`2026-09-06`) was chosen as "well clear of the live weeks" back in August, but a hardcoded
calendar date doesn't stay clear as the calendar advances — its `setup()`'s unconditional `DELETE`
against that date reached real, live data once it became the real "next week," not just the
originally-documented risk of real traffic sweeping the test's own fixture row.
**Check `2026-09-06`/`2026-07-19` against real `roster_weeks` rows before running Gate D or
`test:cloud`** — this is not optional housekeeping, see Step AE.

**A real, live production bug was found and fixed in step P**, purely as a side effect of manually
testing the new features in a browser (spec §12.1, §1.9 item 57): `ensure_roster_weeks()`'s
"keep every untouched week's deadline live" step performed an unconditional `UPDATE`, and a
same-value write still broadcasts a Realtime event — which the manager dashboard's own realtime
subscription reacted to by re-triggering the same call, forever, for as long as `/manage` stayed
open. Confirmed live against the production project (roughly one `ensure_roster_weeks()` call every
100ms) before being fixed and re-verified gone.

Step Z (20 August) — **per-week 12h/11h double-shift display setting** (spec §2.4d, migration 47):
`WeekControlsPanel` gained a two-button toggle, styled identically to the existing morning-target
2/3 toggle, that shortens the handover-boundary TEXT next to a day12/night12 guard's name by one
hour — "עד 17:45" instead of "עד 18:45", "מ 19:45" instead of "מ 18:45". Deliberately invisible to
the solver and both referees: the shift is still scheduled, and counted against every coverage/
kamut/rest rule, as a full 12 hours regardless of this setting — only the text changes. Ben's
caveat, also implemented: on any specific assignment where that guard is the day's *only* real
coverage of the segment the shortened hour would come out of (S2's last hour for day12, S3's first
hour for night12), the text stays at the full 12h boundary instead, so the roster never implies an
hour with literally nobody there. `isDoubleShiftShortened()`/`doubleShiftSuffix()`/
`doubleShiftLabel()` (`src/lib/shifts.ts`) compute this once, generically over any
`{ shift, guard_id }`-shaped row matched by object reference, so the identical logic runs against
both `ScheduleAssignment` and `RosterEditor`'s own `DraftAssignment` shape — threaded through
`RosterGrid` (manager and guard, shared), `RosterEditor`'s live-edit chips, the JPEG export
(`exportRoster.ts`), and the guard's own "המשמרות שלי" list. Nothing solver-side changed — no new
fixture, no new referee logic — since the setting never reaches `SolverInput`.

Migration applied to the live database, full TypeScript typecheck clean, and `test:cloud` (new Gate
D assertions: manager sets/reads the value, a guard is rejected by RLS, an out-of-range value is
rejected by the CHECK) + `test:fixtures` + `test:rls` all green. Shipped, `package.json`/
`GitVersion.yml` bumped to 2.20.0, tagged `v2.20.0`. Nothing left open — purely a display feature,
no real-device-only check applies the way the PWA/notification/passkey items below do.

Step Z, one more revision (20 August) — **JPEG preview/download no longer gated to published runs**
(spec §10.2, item 76): `RosterExport` used to render only when `latestRun.is_published`, on the
reasoning that a draft image in the group chat is indistinguishable from a promise once it's out
there. Ben's explicit call: he wants the preview/download button available for whichever version is
selected in `RunVersions` — draft or published — without publishing first. The gate in
`ManagerDashboard.tsx` dropped `latestRun.is_published &&`, keeping only `!editing` (a mid-edit
export would be a stale picture of what's on screen before the edit is saved). `RosterPublishNotify`
right below it — the push announcement to every guard's phone — is a materially different action and
stays published-only, untouched. Deliberately no draft watermark on the exported image itself — Ben's
choice, no visual difference from a published export. `package.json`/`GitVersion.yml` bumped to
2.20.1, tagged `v2.20.1`.

Step AA (20 August) — **manager-triggered guard PIN reset** (spec §12.4, new `reset-pin` Edge
Function): Hodaya forgot her PIN and the "problem logging in? contact the manager" dead-end text on
the Login page had nothing behind it — there was never a self-service "forgot PIN" flow to route
around, badge code + PIN is the whole credential and the PIN is literally her GoTrue password.
Deleting and re-registering her wasn't an option either: `profiles.id IS auth.users.id`, FK'd
`ON DELETE CASCADE`, so deleting the `auth.users` row to free the badge code for re-claiming would
have taken her `profiles` row — and every `schedule_assignments`/`weekly_submissions` row hanging off
her `guard_id` — down with it, exactly the history-erasing outcome `delete_employee` causes on
purpose elsewhere. The clean path is resetting the PASSWORD on her *existing* `auth.users` row in
place, via the same `admin.auth.admin.updateUserById()` service-role call `claim-code` already uses
to create one — nothing else touched. New `reset-pin` Edge Function, deployed WITHOUT
`--no-verify-jwt` (unlike `claim-code`'s deliberately public design): the platform itself rejects an
unauthenticated call before the function's own code runs, and the code re-checks `is_manager()`
server-side on top of that, same two-layer pattern `generate-schedule` already established. New
"שכח/ה PIN - איפוס" button on `TeamManagement.tsx`'s per-employee row (`useResetGuardPin` in
`useTeam.ts`) lets the manager type in a new 6-digit PIN and hand it to the guard directly.

Verified end-to-end against the live project with a disposable test guard (not Hodaya's real
account): a guard's own JWT is rejected (403), a too-short PIN is rejected (400), a manager's reset
succeeds, the OLD PIN stops signing in immediately, the NEW one signs in, and the guard's `profiles`
row (id, employee_code) is provably unchanged throughout. `package.json`/`GitVersion.yml` bumped to
2.20.2, tagged `v2.20.2`.

Step AB (22 August) — **self-service forgot-PIN via WhatsApp OTP** (spec §12.12, migrations 48–49,
new `whatsapp-pin-reset` Edge Function): Step AA's manual reset worked, but Ben wanted a REAL
"forgot password" system on the guard's own side — "instead of what we currently have, not in
addition to it." No email or phone number existed anywhere in this schema before this — the only
"email" in the whole system is the synthetic `{code}@guards.local` GoTrue login, unreachable by
anyone — so a genuine self-service flow needed a real contact channel first. Ben's own idea, once
asked what he had in mind: he already has every employee's real phone number and wants to use Meta's
WhatsApp Business Cloud API to send a verification code.

`phone_number` (migration 48) added to `roster_codes`/`profiles`, following the exact dual-column
pre-claim/post-claim shape `default_kamut` and `is_demo` already established, carried across at
claim time by a dedicated `copy_phone_number()`/`trg_profiles_phone_number` trigger. **Required**
when a manager adds a new employee (`AddEmployeeCard`), **optional and editable** for an existing
one (`EmployeeRow`'s new phone toggle panel, same interaction shape as the existing PIN-reset one) —
an existing guard with none on file simply keeps relying on Step AA's manual fallback until one is
set. Deliberately **no uniqueness constraint** — Ben's explicit instruction: he'll test with several
mock employees sharing his own real phone number first, and will ask for the constraint once that
testing is done.

New `whatsapp-pin-reset` Edge Function (not a third action bolted onto `claim-code` — a
categorically bigger addition than anything added to that function since it was written, and it
doesn't fit `reset-pin`'s manager-JWT auth model either), deployed `--no-verify-jwt` like
`claim-code` since the guard has no session yet — now the **second** publicly-reachable
unauthenticated write path in the system. Three actions: `otp_request` (looks up the phone on file,
sends a 6-digit WhatsApp code, stores its SHA-256 hash — rate-limited by reusing
`claim_rate_ok`/`record_claim_attempt` unmodified, migration 49 widening `claim_attempts.action` to
add `'otp_request'`), `otp_verify` (5 wrong guesses kills that specific code — a per-row attempt
counter, a different job from `claim_attempts`' rolling per-code/IP window — a correct guess mints a
one-time `verify_token`), `otp_complete` (requires that token, resets the password via the same
`admin.auth.admin.updateUserById()` call Step AA's `reset-pin` already uses, consumes the OTP row).
New `pin_reset_otps` table (migration 49) follows the exact "fully sealed" RLS shape
`webauthn_challenges`/`notification_secrets` already use — zero policies, `REVOKE ALL`, unreachable
via PostgREST regardless of role.

One real ordering bug caught and fixed before shipping: the first draft checked whether
`WHATSAPP_*` secrets were configured *before* checking whether the guard even has a phone number on
file — meaning, with Meta not yet configured (see below), every `otp_request` would return the same
generic "not configured" error regardless of the actual reason, masking the more specific "no phone
on file" case and making it untestable until Meta setup was complete. Reordered so the business-logic
check (does this guard have a phone?) runs first — simply the more correct order regardless of the
Meta-configuration timing, and confirmed against production immediately after (Ben's own account,
`005396`, correctly returns "no phone on file" rather than the generic config error).

Login.tsx's old dead "החלפת קוד עובד" button — which did nothing but reset local state back to the
code-entry step — is gone from the `'pin'` step, replaced by two honest, separate actions: a small
"→ קוד אחר" back-link moved to the top (for "this isn't my code"), and a real "שכחתי סיסמה" button
(for "this is my code, I forgot the PIN") that fires the OTP request immediately on tap and walks
through two new steps — `'otpVerify'` (enter the code, unmasked since it's read off WhatsApp rather
than recalled) and `'otpNewPin'` (choose a new PIN, exactly `'setPin'`'s shape, factored into a
shared internal `PinChooser` component used by both). A successful reset signs the guard in
immediately, same as `claim()` already does for first-time registration. `invokeClaimCode`
(`AuthContext.tsx`) and `invokeResetPin` (`useTeam.ts`) — already near-identical copies of the same
Edge-Function-error-unwrapping logic — were extracted into one shared `invokeEdgeFunction()`
(`src/lib/edgeFunctions.ts`) rather than adding a third copy for this feature.

New Gate I (`npm run test:whatsapp`, `supabase/tests/whatsapp-pin-reset.cloud.test.mjs`, 19
assertions) — same deliberate scope as Gate G never invoking `send-notifications` for a real push: a
real WhatsApp send costs money and must never fire inside `test:cloud`. `otp_verify`/`otp_complete`
are exercised for real by seeding a `pin_reset_otps` row directly via SQL with a known OTP's hash
(correct/wrong/expired/5-guess-lockout/replay-after-consumption); `otp_request` is exercised for
real on the one path reachable without touching Meta (a claimed guard with no phone on file) — the
same path that doubles as confirmation of the ordering fix above. Migrations applied to the live
database, full TypeScript typecheck clean, `test:cloud` (11 suites now, Gate I new) + `test:fixtures`
+ `test:rls` all green. `package.json`/`GitVersion.yml` bumped to 2.21.0, tagged `v2.21.0`.

**Not yet live** — Meta WhatsApp Business setup (a verified Business Account, a WhatsApp Business
Account, a phone number, a permanent System User access token, and a message template approved in
the Authentication category) is entirely manual, on Ben's side; nothing here can do it. Until three
secrets (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAME`) are set, every
`otp_request` for a guard who does have a phone on file returns a clean `NO_WHATSAPP` error — Step
AA's manual `reset-pin` covers every guard regardless in the meantime. Once Meta setup is done, a
real end-to-end send needs confirming by hand once, the same class of real-device-only check push
notifications and passkey ceremonies each needed.

Step AB, revised (22 August, same day) — **forgot-PIN OTP delivery pivots from WhatsApp to a push
notification** (spec §12.12, migrations 49–50, `whatsapp-pin-reset` renamed `request-pin-reset`).
Before any real WhatsApp message was ever sent, Ben went to actually do the Meta setup above and
found his Facebook account restricted from Meta Ads over a disputed fraudulent charge from years
earlier (someone else had used the account; Ben isn't paying a bill he doesn't own). Walked through
the options together: trying the existing restricted account first (confirmed dead — Meta requires a
Business Portfolio to attach WhatsApp to an app at all, and "Create an app without a use case"
doesn't route around it either, checked directly rather than assumed), a new Business Portfolio under
a different admin, or a third-party provider. **Ben's call**: drop Meta entirely and deliver the OTP
through this app's own already-working push notification system instead — no external account to
unblock, no new dependency, reuses `send-notifications` (spec §12.10), already live in production.

`phone_number` (migration 48) is **fully reverted** (migration 50: both columns, the
`copy_phone_number` trigger, and `roster_code_status` rebuilt without it) — it existed for no reason
other than feeding the WhatsApp call, and nothing else in the project ever touched it, so there was
nothing to preserve. `AddEmployeeCard`'s required phone field and `EmployeeRow`'s phone-edit panel
are gone from `TeamManagement.tsx` along with it. The OTP mechanics themselves — `pin_reset_otps`'s
hash/attempts/expiry/`verify_token` shape, `claim_attempts`' widened `'otp_request'` action — are
**unchanged**; only the delivery channel moved, and the guard-facing Login.tsx flow (tap "שכחתי
סיסמה" → enter the code → choose a new PIN) needed **zero changes at all**, since it was always
delivery-channel-agnostic by construction.

`whatsapp-pin-reset` renamed `request-pin-reset` (old function deleted from Supabase, new one
deployed `--no-verify-jwt` in its place). `otp_request` now: resolves the guard's id from
`employee_code`, confirms at least one live `push_subscriptions` row exists for them (else a clean
404 — the new equivalent of "no phone on file"), generates and stores the OTP exactly as before, then
calls `send-notifications` **server-to-server** — the identical `x-cron-secret` mechanism
`notification_tick` already uses (reads `notify_url`/`cron_secret` straight from
`notification_secrets`) — with a brand-new `pin_reset_otp` type. That type is cron-secret-**only**,
like the original three cron types, not JWT-reachable at all like `roster_published`/
`guard_submitted` are: its one legitimate caller has no session to present a JWT with in the first
place. If nothing actually delivers (`sent < 1` — e.g. a subscription exists but is dead),
`otp_request` deletes the now-useless OTP row and returns a clean, honest error rather than a false
"ok" that a guard would wait forever on. The plaintext OTP is never written into
`notification_log.detail` — it already lives, hashed, in `pin_reset_otps`.

**The one real trade-off, worth being upfront about**: delivery now needs an *existing* push
subscription on the device she's using, where a phone number worked regardless of device or app
state. In practice this rarely bites — every real guard already uses the app weekly and gets nudged
to enable notifications early, and a forgotten-PIN guard is almost always on the same phone she
always uses. Anyone it doesn't cover — no subscription anywhere, or an unfamiliar device — gets
routed to Step AA's manager fallback, same two-tier shape the WhatsApp design already had.

New Gate I rebuilt (`npm run test:pinreset`, `supabase/tests/request-pin-reset.cloud.test.mjs`, 23
assertions, replacing the WhatsApp-era file 1:1 in scope): `otp_verify`/`otp_complete` unchanged in
coverage (seeded OTP row, correct/wrong/expired/lockout/replay). `otp_request` now covers two paths
that never reach a real device instead of one — a guard with zero subscriptions (clean 404), and a
guard with a deliberately bogus subscription, where `send-notifications` genuinely attempts delivery
and genuinely fails, proving `otp_request` reports that honestly (502) and cleans up rather than
leaving a dangling row. New: `notification_log` accepts `pin_reset_otp` and is asserted to never
contain the plaintext code. Migrations applied to the live database, full TypeScript typecheck clean,
`test:cloud` (11 suites, Gate I rebuilt) + `test:fixtures` + `test:rls` all green — including a
same-run confirmation that redeploying `send-notifications` without re-passing `--no-verify-jwt`
preserved its existing platform-level JWT setting (checked directly against production: an
unauthenticated call still reaches the function's own code and gets its own `403`, not the platform's
generic 401, proving the cron-secret path used by `pg_cron` was never at risk). `package.json`/
`GitVersion.yml` bumped to 2.22.0, tagged `v2.22.0`. **Fully live** — unlike the WhatsApp version,
nothing external is left to configure; one real-device push-delivery confirmation is the only thing
still open, tracked below.

Step AB, fully reverted (22 August) — **a production session-persistence regression, with no
confirmed cause, led to pulling the whole self-service forgot-PIN feature back out**. Within the
same day v2.22.0 shipped, Ben reported that refreshing the page anywhere in the app was signing him
back out to the Login screen — on every refresh, on every page, on more than one device, including
one with no passkey registered at all (directly ruling out the passkey restart-lock gate, §8/§12.11,
as the cause, since a device with no passkey can't reach that code path). A full diff of every file
changed since the last confirmed-stable point (Step AA, v2.20.2 — 15 files) turned up nothing
touching session storage, the Supabase client config, or the passkey ceremony. Vercel's deployment
health, environment variables, and production bundle hashes were all checked and came back clean.
**No root cause was ever conclusively identified.** Rather than keep debugging a live regression
against production with an unconfirmed cause, Ben's call: revert the entire feature — both the
WhatsApp attempt (Step AB) and the push-notification redesign (Step AB revised) — back to exactly
Step AA's state, and revisit self-service PIN recovery later, in isolation, if at all.

`AuthContext.tsx`, `useTeam.ts`, `Login.tsx`, `TeamManagement.tsx`, and `send-notifications` were
restored file-for-file to their Step AA (v2.20.2) content (`git checkout 9601093 -- <path>`) —
`otpVerify`/`otpNewPin`/`PinChooser` gone from Login, the shared `invokeEdgeFunction` helper gone,
phone-number UI gone, `pin_reset_otp` gone from `send-notifications`. `src/lib/edgeFunctions.ts`,
`supabase/functions/request-pin-reset/`, and `supabase/tests/request-pin-reset.cloud.test.mjs` were
deleted outright — none of them existed at Step AA. `request-pin-reset` was deleted from Supabase
(confirmed gone via a `404` on a direct curl); `send-notifications` was redeployed with the reverted
code (confirmed its `--no-verify-jwt` cron-secret path survived the redeploy: a bad secret still
returns this function's own `403`, not the platform's generic `401`).

**Migrations 48–50 were deliberately left in the repo, not deleted or rewritten** — they genuinely
ran against the live database, and this project's standing discipline is that migrations are
discovered, never edited after the fact. A new migration 51 reverses their net effect instead: drops
`pin_reset_otps`, and restores `claim_attempts.action`/`notification_log.notification_type`'s two
`CHECK` constraints to their pre-feature shape (first deleting the handful of test rows logged under
the now-disallowed values, since adding a `CHECK` validates every existing row). `phone_number`
needed no further reversal — migration 50 had already fully reverted it during the WhatsApp→push
pivot, before this regression was even found. Applied cleanly to the live database on the second
attempt (the first hit exactly the constraint-violation-from-leftover-test-rows issue the `DELETE`s
above were added to fix).

Full TypeScript typecheck clean, `npm run build` clean — and notably produced **byte-identical
bundle hashes** to an earlier confirmed Step AA build (`TeamManagement-*.js`, `ManagerDashboard-*.js`,
etc.), strong independent evidence the revert was faithful. `test:cloud` (back to ten suites — Gate I
and `test:pinreset` removed along with the feature) all green except Gate D's known pre-existing
date-collision flake (unrelated, see below) and one realtime assertion that was flaky on the first
run and passed clean on an isolated re-run. `test:rls` (55/55) and `test:fixtures` (104/104) both
green. `package.json`/`GitVersion.yml` bumped to 2.22.1, tagged `v2.22.1`.

**Important, and worth being honest about**: this is a pragmatic mitigation, not a confirmed fix —
the actual root cause of the session bug was never found, only a broad set of candidate causes ruled
out. If the bug persists after this revert ships, that's significant new evidence the cause lies
somewhere this session's changes never touched at all.

Step AC (27 August) — **fixed a stale-past-week leak in the guard-facing roster views**: `Auth`Context
aside, `useVisibleRosters()` trusted RLS alone to scope published runs to "current + next," but the
`is_manager()` RLS branch has no date floor at all, by design, since that's what lets the
manager-only archive (spec §7) work at all. Ben is both manager and an active guard, so his own
`/roster` and `/` (GuardHome) pages were silently inheriting the archive's unbounded read instead of
degrading to just the current week whenever next week wasn't published yet — and the extra week was
mislabelled "next week" regardless of whether it was actually in the future. New
`guardVisibleWeekFloor()` (`src/lib/dates.ts`), a client-side mirror of the database's
`guard_visible_from()`, filters `useVisibleRosters()` to it; `RosterView.tsx`/`GuardHome.tsx` also
stopped assuming "not current" means "next." `package.json`/`GitVersion.yml` bumped to 2.22.2, tagged
`v2.22.2`.

Step AD (3 September) — **a placeholder row can optionally occupy a coverage slot** (spec §12.9,
migration 52): a placeholder (Step S, migration 39) was always excluded from every hard-rule check
and all coverage counting, unconditionally — right for a pure annotation, but there was no way to say
"someone genuinely covers this slot, I don't want to name who" without the roster reading as
short-staffed underneath a note that said otherwise. New `schedule_assignments.occupies_slot`,
meaningful only when `guard_id IS NULL` (CHECK-enforced FALSE on any real row — one already occupies
its own slot), defaults FALSE so every existing placeholder is unaffected. When set, the placeholder
counts toward that segment's floor/target/ceiling like a real assignment while staying invisible to
H1–H5/H7 and any guard's own כמות — `validate.ts`'s referee gained its first-ever `guard_id === null`
branch, since `coverageBySegment()` already summed guard-agnostically and only the guard-specific
loops needed an explicit skip. New per-row "תופס משבצת בכיסוי" checkbox in `RosterEditor.tsx`,
shown only on a placeholder row and reset the moment it's switched to a real guard. Confirmed with
Ben up front: a placeholder still requires at least one note regardless of the flag — occupying a
slot doesn't relax `placeholder_needs_a_note`. New referee-only checks in `run-fixtures.mjs` and Gate
E (edit) assertions in `edit.cloud.test.mjs`; full browser walkthrough against a disposable,
fully-cleaned-up test fixture confirmed the editor and grid tone both behave correctly.
`package.json`/`GitVersion.yml` bumped to 2.23.0, tagged `v2.23.0`.

Step AE (3 September) — **afternoon block segment shifts** (spec §12.13, migration 53): the afternoon
block is really two coverage segments, S2 (early) and S3 (late), but the only way to occupy just one
manually was a 12h `day12`/`night12` shift that also commits the guard to the morning or night — the
full 8h `afternoon` shift always covers both halves, with no way to scope it down. Two new
manual-edit-only shift types, `afternoon_early` (covers S2) and `afternoon_late` (covers S3), added to
the shift catalogue (`src/lib/shifts.ts`) exactly like the original five — coverage counting, rest-hour
derivation, and eligibility all fell out for free, since none of that is hardcoded to five values.
Migration 53 is two bare `ALTER TYPE shift_type ADD VALUE` statements, the first time this enum has
ever been extended. **One real bug caught before shipping**: `mockSolver.ts`'s candidate-move search
also iterates the shift catalogue generically, so it started proposing the new manual-only types on
its own the moment they existed — caught by a changed golden-fixture assignment count on a re-run,
before a dedicated test even existed for it. Fixed with a new `SOLVER_SHIFT_TYPES` constant (the
original five only, mirroring `solver/models.py`'s own independent, untouched list) swapped into
`mockSolver.ts`; confirmed fixed via `test:compare` regaining exact mock/CP-SAT parity on every
fixture. `RosterGrid.tsx`/`exportRoster.ts`'s existing day12/night12 handover-pairing widened to pair
the new types the same way — `exportRoster.ts` also had a latent hardcoded `'day12'`/`'night12'`
shift literal fixed while widening it, or a genuine half-shift row would have exported with the wrong
colour. New referee-only checks and Gate E (edit) assertions; full browser walkthrough (editor, the
read-only roster grid, and the JPEG export) all confirmed rendering correctly against a disposable,
fully-cleaned-up test fixture. Both Step AD and AE shipped on the same `feature/placeholder-occupies-
slot` branch and merged to `main` together. `package.json`/`GitVersion.yml` bumped to 2.24.0, tagged
`v2.24.0`.

**A real incident happened between Step AD and Step AE, worth recording plainly**: verifying Step AD
included running `npm run test:cloud`, which chains through Gate D
(`supabase/tests/manager.cloud.test.mjs`). Gate D's fixture week, `2026-09-06`, was "well clear of the
live weeks" when that test was written in August — by 3 September it had become the real, live "next
week" real guards were submitting to. Gate D's `setup()` runs `DELETE FROM roster_weeks WHERE
week_start IN (...)` against that date unconditionally, first thing, before any assertion — which
cascades to every real row tied to it: submissions, preferences, the generated draft roster, and its
assignments. This project has no separate test database and no PITR on its Supabase plan, so none of
it was recoverable from a backup; the fix was asking every guard to manually resubmit. The previously-
documented "Gate D flake" (above, and spec §14.2, both now corrected) undersold this — it described
real traffic sweeping the *test's* fixture row, not the test's own `DELETE` reaching *real* data,
which is what actually happened. **Before running Gate D, or `test:cloud`, check its fixture dates (`2026-09-06`,
`2026-07-19`) against real `roster_weeks` rows first** — this now happens as a matter of course before
any cloud test runs in this project, not just for Gate D. The real fix — computing fixture dates
relative to "today" instead of a hardcoded calendar date, across every cloud test file that has one —
is still open.

Step AF (16 September 2026) — **Yom Kippur special-coverage feature** (spec §12.14, migrations
54–56): Yom Kippur is a driving-prohibited holiday, so 2–3 guards need to cover an unbroken block
from Kippur eve's early afternoon through the end of Kippur day itself, excluding that final night.
Two new manual-edit-only shift types, `kippur_day1` (S2+S3+S4) and `kippur_day2` (S1+S2+S3), one row
per calendar day each — `schedule_assignments`' own `one_shift_per_guard_per_day` index rules out
representing the block as two ordinary same-day rows, which is why this needed new shift types
rather than reusing existing ones. That same one-row-per-day shape is what makes the pair land as
exactly 2 shifts against a guard's weekly total for free, with zero new kamut/`max_shifts`
accounting — the existing generic per-row counting already produces it.

Real Hebrew-calendar detection (`src/lib/holidays.ts`, `@hebcal/hdate`) finds whichever roster week
contains Yom Kippur each year — confirmed empirically against 40 years of dates (2020–2060) rather
than assumed, which is also how the Saturday-Kippur limit below was found. A standing settings
toggle (`scheduler_settings.kippur_handling_enabled`) turns the feature on once; a new manager-
dashboard panel (`KippurPanel.tsx`) then surfaces automatically on the detected week with a 2/3
guard-count toggle and a guard picker, each candidate checked against whether they've actually
submitted the required availability — saving is **hard-blocked** (Ben's explicit call) until every
pick is valid. `useGenerateSchedule.ts` then writes the pair automatically for every configured
guard on every future generation of that week, with the solver told to solve around the pinned block
(availability hidden for the two Kippur dates, segment targets reduced by the guard count) rather
than anything requiring manual roster editing.

A narrowly-scoped rest exemption allows the 0h gap between the two halves for the same guard, proven
narrow by a referee-only test showing a different 0h pairing landing on `kippur_day2` is still
hard-blocked. Two real bugs caught before shipping by reasoning through the design rather than by a
failed run: H1 needed generalizing to check TWO base shifts per Kippur type, not one
(`requiredBases()`), and `segmentFloors()`'s morning-floor formula assumed morning is always 2 or 3,
which broke the moment a Kippur-adjusted input needed to legitimately drive it to 0.

**A real production bug was found and fixed the same way Step P's and Step W's were — by testing
against the live system, not a disposable fixture**: generating against the actual 2026-09-20 week
(this year's real Kippur week) failed outright, because that week already had S3/S4 overridden to 1
for every day — a genuine, pre-existing setting unrelated to Kippur — and the 2 configured Kippur
guards' own guaranteed coverage alone already exceeded that lower ceiling, regardless of anything the
solver did. Fixed by computing one effective target per affected segment
(`max(configured target, Kippur guard count)`) and building two adjusted views of the solver input
(`withKippurAdjustments()`): the solver only sees the remainder left to fill, but the referee's
ceiling is raised to match what the block actually guarantees — a segment target was never meant to
evict guards who are mandatorily present. Reproduced as a permanent regression test
(`run-fixtures.mjs`) rather than left as a one-off fix.

**Formerly a known, permanent limit — resolved in Step AG (v2.26.0), see below**: Yom Kippur can fall
on a Saturday (confirmed empirically, never on a Sunday or Friday), and until Step AG this app
hard-locked the weekend morning target to 2, unoverridable by design — unlike S2/S3/S4, which have no
such lock. In a year Kippur falls on a Saturday, a 3-guard block alone would exceed that fixed
ceiling with no override available; 2 guards worked fine that year, a manager wanting 3 would need to
place the third guard by hand.

Built on `feature/yom-kippur-coverage`, both DB migrations and the ceiling fix verified against the
live project before merging. Migrations 54–56 applied to the live database, full TypeScript
typecheck clean, `test:fixtures` (119, up from 112 — 5 new Kippur referee-only checks including the
production-bug regression) + `test_scheduler.py` (108, unchanged) + `test:compare` (mock/CP-SAT
parity holds) + `test:rls` (55) all green. `package.json`/`GitVersion.yml` bumped to 2.25.0, tagged
`v2.25.0`. Not yet confirmed by an actual second live generation of the 2026-09-20 week after the
fix — the fix is regression-tested, not yet re-run live.

Step AG (23 September 2026) — **per-day morning target override widened to any day and value 1**
(spec §2.4b, migration 57): the manager wanted morning to get the same every-day, as-low-as-1
flexibility S2/S3/S4 already had (§2.4c) — a genuinely short-staffed day should be expressible for
morning too, weekday or weekend, without touching the week's own baseline. `weekly_morning_target_overrides`'s
two CHECKs widen from `day_index BETWEEN 1 AND 5` / `morning_target_slots IN (2, 3)` to `BETWEEN 0 AND
6` / `IN (1, 2, 3)`. The week-level baseline toggle (`roster_weeks.morning_target_slots`) is
deliberately untouched — still a strict 2-or-3, weekday-only choice; only the per-day exception table
got wider.

`morningTargetForDay()` (`src/lib/shifts.ts`, mirrored in `solver/models.py`) now checks the override
map on every day before falling back to the weekday-baseline-vs-flat-2 split, instead of skipping the
lookup outright on a weekend day — the hard lock lived in that early-return, not just in the CHECK
constraints. `segmentFloors()`'s S1 floor formula needed no change at all: `morning === 3 ? 2 :
Math.min(1, morning)` already produces the correct floor (1) for a value of 1, the same `min(1,
target)` clamp S2/S3/S4 already use — confirmed by inspection before writing any code, rather than
assumed.

As a direct side effect, this resolves the Yom Kippur-on-a-Saturday limit documented just above:
`withKippurAdjustments()` (`useGenerateSchedule.ts`) previously skipped its effective-target-raise
step for morning specifically on a weekend Kippur day, since writing an override there used to be
pointless. That skip was removed — it now behaves exactly like it always has for S2/S3/S4 — so a
3-guard Kippur block on a Saturday now flows through generation once the manager overrides that
Saturday's morning target to 3 first, rather than needing the third guard placed by hand.

**One real correctness gap found and fixed before shipping**: `ManagerDashboard.tsx`'s override-save
normalisation (equal-to-baseline clears the override row, the same sparse-by-design convention every
other override table uses) compared the selected value against `week.morning_target_slots`
unconditionally. That's right for a weekday, but a weekend day's true baseline is always the flat 2,
not the week setting — once weekends became overridable at all, setting one back to 2 would otherwise
have stored a redundant explicit row instead of clearing it. Fixed by computing the correct per-day
baseline (`isWorkingDay(dayIndex) ? weekSetting : 2`) before comparing.

New golden fixture 17 (`solver/tests/fixtures/17-morning-override-any-day-value-one.json`) covers all
three cases in one scenario: a weekday overridden to 1 (ceiling caps at 1, no spurious floor breach),
a weekend day (Saturday) overridden to 3 (previously impossible, now reaches 3), and an unoverridden
weekend day (Sunday) still defaulting to the flat ceiling of 2 — mirrored in both `run-fixtures.mjs`
and `test_scheduler.py`. New Gate D assertions (`manager.cloud.test.mjs`): a manager overriding a
weekend day to 3 and to 1, an out-of-range override value (4) and an out-of-range day_index (7) still
rejected by the widened CHECKs, and a guard write still rejected by RLS. Migration 57 applied to the
live database, full TypeScript typecheck clean, `test:fixtures` (128, up from 119) +
`test_scheduler.py` (117, up from 108) + `test:compare` (mock/CP-SAT parity holds, fixture 17 ties
exactly) all green. `package.json`/`GitVersion.yml` bumped to 2.26.0, tagged `v2.26.0`.

**v2.26.1 (21 October 2026) — bug fix: remote generation silently fell back to the mock** (spec
§1.29, §2.8). Symptom: Generate produced a roster, but with the in-browser mock engine rather than
CP-SAT. It looked like a Render outage, and a manual Render redeploy that same day also failed.
That failure was a red herring: Render spent ~15 minutes provisioning before running `uvicorn` and
hit its own 15-minute deploy timeout three seconds before the server bound its port. The
already-live instance was healthy and running current code the whole time.

The real cause was in the request. The browser's Network tab showed the edge function's 502 body:
the solver had answered 422 because of `carry_in["null"] = "afternoon_early"`. `carry_in_shifts()`
returns every row on the previous week's published Saturday. Since v2.23.0 that can include a
placeholder row (`guard_id` NULL, which becomes the key `"null"` in a JS map). Since v2.24.0 and
v2.25.0 it can include the manual-only types `afternoon_early`/`afternoon_late` and
`kippur_day1`/`kippur_day2`. The Python `ShiftType` accepts only the five solver types. The zod
`solverInputSchema.carry_in` accepts all nine, so the client let the payload through. The edge
function returned a 502 and `useGenerateSchedule.ts` fell back to `mockSolve()` with nothing but a
`console.warn`. Any week following a Saturday with one of those rows would hit this.

Fix: `toSolverCarryIn()` (`src/lib/shifts.ts`), applied only to the remote payload. It drops the
placeholder key and maps each manual-only type onto the solver type with the same end time
(`afternoon_early → day12`, `afternoon_late`/`kippur_day2 → afternoon`, `kippur_day1 → night`).
Carry-in only feeds rest, and rest depends only on the previous shift's end, so the mapping is
lossless. The referee, mock and editor keep the exact types. Verified the patched payload passes
the live solver's validation, `test:fixtures` (128) and typecheck green, and confirmed working in
production by Ben. A follow-up audit compared every other contract field between zod and pydantic
and found no other mismatch. The Kippur-adjusted overrides stay within 0–3. Code in `680eba3`;
`package.json`/`GitVersion.yml` bumped to 2.26.1, tagged `v2.26.1`.

**Lesson worth keeping:** when a manual-only shift type or a placeholder is added, check every
place the solver *reads* data, not just what it may *assign*. Excluding a type from
`SOLVER_SHIFT_TYPES` stops the engines from proposing it, but it does nothing to stop it arriving
as input.

---

## What is left

Nothing blocking. Spec §13 has the full open-items list — everything there is either decided or a
deliberately deferred design choice, not a build gap. Seven things still open, not build gaps
(self-service forgot-PIN, formerly listed here, was fully reverted — see Step AB, fully reverted,
above — and is not an open item, it's removed):

- **Passkey real-device registration + unlock confirmation** (Step X, spec §8) — now on the rebuilt
  app-scoped WebAuthn mechanism (own `webauthn` Edge Function, not Supabase's native Passkey API; see
  Step X's same-day revision above). Registering from Preferences on a real iPhone/Android, confirming
  the credential does *not* show up in the phone's system Passwords & passkeys list, and confirming
  the app-restart lock screen's unlock actually works can only be tested against the live deployment
  — same class of gap as the PWA/notification items below — and hasn't been done yet.
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
- **Silent mock fallback** (v2.26.1 follow-up, spec §14.3): a remote solver failure only reaches
  `console.warn`, and the edge function's response body, which holds the real error, is thrown
  away. That's how the carry-in bug went unnoticed. It should show the manager a visible warning
  with the body.
- **No TS↔Python contract test** (v2.26.1 follow-up): a small test that every `SHIFT_TYPES` entry
  survives `toSolverCarryIn()` as a value the Python `ShiftType` accepts would catch the next drift
  between `solverContract.ts` and `solver/models.py`.
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
- Edge Functions `claim-code`, `generate-schedule`, `send-notifications`, `webauthn`, and `reset-pin`
  are deployed. (`whatsapp-pin-reset` and its successor `request-pin-reset` existed briefly,
  v2.21.0–v2.22.0, and were both deleted from Supabase when the self-service forgot-PIN feature was
  fully reverted in v2.22.1 — see Step AB, fully reverted.)
- Solver live at `https://guard-solver.onrender.com`; `SOLVER_URL` and `SOLVER_SECRET` are set as
  Supabase Edge Function secrets
- `pg_cron`/`pg_net` enabled (first use in this project, spec §12.10); one job, `notification_tick`,
  fires every 15 minutes. `CRON_SHARED_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and
  `VAPID_SUBJECT` are set as Supabase Edge Function secrets; the matching `notify_url`/`cron_secret`
  pair lives in the `notification_secrets` table (not a GUC — see spec §12.10 for why), set via a
  plain `UPDATE`, not committed anywhere. (The abandoned WhatsApp design's three `WHATSAPP_*`
  secrets were never set and are moot now; `request-pin-reset`'s reuse of this cron-secret pair for
  the `pin_reset_otp` type is moot too — that function is deleted as of the v2.22.1 revert.)
- 56 migrations applied, tracked in a `schema_migrations` ledger

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
state that version describes), matching the spec's own version history. Currently at **2.26.0**
(per-day morning target override widened to any day and value 1, Step AG — matches the every-day,
as-low-as-1 flexibility S2/S3/S4 already had, and resolves the Yom Kippur-on-a-Saturday limit Step AF
left open), tagged `v2.26.0`.

## Commands

```bash
npm run dev              # Vite dev server on :5173
npm run db:apply         # apply pending migrations (ledger-tracked, idempotent)
npm run db:verify        # RLS + reachability audit
npm run seed:testweek    # load a week of guard availability
npm run preview:week     # read-only: what the MOCK would produce
npm run preview:cpsat    # the same input through CP-SAT
npm run test:cloud       # all ten cloud suites against the live project
npm run generate:icons   # regenerate public/icons/* from materials/Work-Organizer Icon.jpeg
```

---

## Seven habits worth keeping

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

**There is no separate test database, so a cloud test's fixture is a real write against production —
read what it actually does before running it.** Step AE's incident (3 September 2026): Gate D
(`manager.cloud.test.mjs`) hardcoded its fixture week to a date that was safely in the future when
the test was written, and its `setup()` unconditionally `DELETE`s `roster_weeks` for that date before
any assertion runs. Nobody revisited that assumption as the calendar advanced; by the time it was
run again, the date had become the real, live "next week," and the test's own `DELETE` reached real
guards' submitted preferences and a generated draft roster — gone, no PITR on this project's plan, no
way back except asking every guard to manually resubmit. A past "known flake, not a regression" note
(this file, and spec §14.2, both corrected after the fact) had already described this exact test as a
risk, but under a milder mechanism than what actually happened — the lesson generalizes past this one
test: before running any cloud test here, check what its `setup()` actually does to data scoped by a
fixed value (a date, an email pattern, an ID range), and don't trust a past characterization of "which
kind of risk" without re-deriving it from the test's current code.

---

## Housekeeping at end of project

- Revoke the Supabase personal access token (supabase.com/dashboard/account/tokens)
- Rotate the database password (Settings → Database)

Both appear in the development transcript.
