# TECHNICAL SPECIFICATION & ARCHITECTURE BLUEPRINT: AUTOMATED SECURITY GUARD SCHEDULER

**Version:** 2.24.0 (build steps A–Y complete plus the double-shift display setting, the
draft-preview export change, manager PIN-reset, a stale-past-week guard-view fix, and two roster-
editor polish items below — an optionally coverage-occupying placeholder and split afternoon-
segment shifts; live and in daily use; deployed to production — the self-service forgot-PIN
feature (§12.12) was fully reverted after a production session-persistence regression, see §14.1
Step AB and §14.3)
**Roster Context:** Flexible team size, 6–12 registered guards, 15 currently active
**Target Roster Week:** Sunday 9 August 2026 – Saturday 15 August 2026
**Document Date:** 3 September 2026

---

## 1. EXECUTIVE SUMMARY

This document specifies the operational rules, database schema, Row-Level Security (RLS) policies, and constraint-programming model for a custom security-guard scheduling application (**סידור אמריקאי**).

Active guards submit weekly availability from their phones, replacing manual WhatsApp coordination. A manager sets a per-week morning capacity target and a per-guard **כמות** (minimum shift target), then triggers a **Google OR-Tools CP-SAT** solver that produces a mathematically optimal, conflict-free draft roster in seconds. The manager audits the draft on a visual grid, hand-edits it where needed, and publishes — pushing the roster to every guard's phone, with a JPEG export for the team's WhatsApp group.

Hosting runs entirely on free tiers: **Vercel** (React frontend), **Supabase** (Postgres + Auth + RLS), and **Render/Railway** (Python solver microservice). Target operating cost: **$0/month**.

### 1.1 Changes in Version 2.0

| #   | Change                                                                               | Rationale                                                                     |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 1   | Coverage remodelled on **time segments**, not shifts                                 | 12h shifts are a _second partition_ of the day, not double shifts             |
| 2   | **12h shifts corrected** to 06:45–18:45 and 18:45–06:45, weight = 1 shift            | Original v1 text implied 16h back-to-back doubles                             |
| 3   | Coverage floors & targets made **soft with weighted penalties**                      | Prevents unexplainable `INFEASIBLE`; 8 guards are structurally under-capacity |
| 4   | **כמות auto-override** to `min(configured, available_days, 5)`                       | Removes the #1 source of solver infeasibility                                 |
| 5   | **Availability is a hard constraint**                                                | A guard is never scheduled on a slot they did not mark                        |
| 6   | Rest rules generalised: **<8h hard-blocked · exactly 8h penalised (−5) · ≥12h free** | Replaces the single No-Clopen rule; No-Clopen now derived                     |
| 7   | **Week-boundary carry-in** from the previous Saturday                                | Closes the cross-week rest loophole                                           |
| 8   | Posts (סריקה/בוטקה/בקרה/שמירה) **removed from the solver**                           | Manager assigns manually post-generation                                      |
| 9   | Schema normalised: JSONB targets → relational table; 12h flags → per-week row        | Restores the FK integrity that motivated choosing Postgres                    |
| 10  | RLS rewritten with `SECURITY DEFINER` helpers                                        | v1 policies were self-blocking and left one table fully open                  |
| 11  | Auth = **6-digit badge code + personal PIN** (set on first login)                    | A 6-digit code alone is not a credential                                      |
| 12  | Solver hosted on **Render/Railway**, not Supabase Edge Functions                     | Edge Functions are Deno; they cannot run Python/OR-Tools                      |

### 1.2 Changes in Version 2.1

| #   | Change                                                                           | Rationale                                                                |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 13  | **US work week**: Saturday and Sunday are the days off; Friday is a working day  | This is an American school, not an Israeli-calendar workplace            |
| 14  | Submission deadline moves to **Wednesday 19:00** Asia/Jerusalem                  | Replaces Thursday 20:00                                                  |
| 15  | Raised morning target (3) applies **Monday-Friday only**; Sat/Sun always 2       | The weekend runs light regardless of the week setting                    |
| 16  | 12h opt-in becomes **per day**, stored as `allows_12h` on the preference row     | A guard willing to do one long day should not have to accept a long week |
| 17  | Weeks are **auto-created** by `ensure_roster_weeks()`; hand-seeded weeks removed | Scaffolding went stale as real dates passed                              |
| 18  | Past weeks are **manager-only**, enforced in RLS                                 | A guard holding the publishable key can query PostgREST directly         |

### 1.3 Changes in Version 2.2

| #   | Change                                                                                       | Rationale                                                                                                            |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 19  | Submission window **opens Saturday 20:00** (`week_start − 8`) and closes Wednesday 19:00     | Gives guards the weekend plus Sun–Wed; keeps exactly two weeks live                                                  |
| 20  | `ensure_roster_weeks()` manages **exactly the current week and the next**                    | An earlier version walked forward until it found an open window, producing a third live week for part of every cycle |
| 21  | Manager status changes go through **`set_week_status()`** and are permanent                  | The automatic sweep was silently reverting them — see §12.3                                                          |
| 22  | Reopening an expired week **extends the deadline**; locking again **clears the extension**   | `is_week_open()` also gates on the deadline, so flipping status alone changed nothing observable                     |
| 23  | Generation orchestrated **client-side**; the Edge Function is a thin secret-holding proxy    | Putting solver logic in Deno would create a third copy of rules that already exist twice                             |
| 24  | A generated roster is **refused if it fails the referee**, never stored on the solver's word | Better a visible failure than a roster that quietly contains a clopen                                                |
| 25  | Roster grid laid out in **three time blocks with an 18:45 handover cell**                    | Matches the spreadsheet the manager already used; segment rows hid that a `day12` guard covers two windows at once   |
| 26  | Grid columns sized from **measured content**, not a fixed guess                              | A hardcoded width fitted one name and clipped the two-name handover to `יו... / ע...`                                |
| 27  | **Image export of a published roster** (§10.2), manager-only                                 | The team coordinates in WhatsApp; a picture is how the roster actually reaches eight phones                          |

### 1.4 Changes in Version 2.3

| #   | Change                                                                                                                                                 | Rationale                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 28  | **The frontend is deployed to Vercel** (§11.2), with GitHub auto-deploy connected                                                                      | Build steps A–J's last blocker; a push to `main` now goes live on its own                                                                                                                                                                                                                 |
| 29  | Manager-facing current/next cursor (`admin_current_week_start()`) now advances on the **configured submission open-time**, not real midnight (§12.1)   | The manager-facing week cycle was previously indistinguishable from the guard-facing calendar cycle; a manager watching the open-time setting expected the whole cycle to move with it                                                                                                    |
| 30  | The admin cursor's week-status sweep is bounded to a **window around the real calendar week**, not scoped to the tracked pair and not unbounded either | A week that briefly became "next" and got auto-opened, then fell out of the tracked pair when the cursor reversed, was never swept again and stayed open forever; the first fix (unbounded) then swept unrelated test fixtures dated months away — bounding it is what's actually correct |
| 31  | A guard can **cancel their own submission outright** (`delete_week_submission`, §3.7), not just edit it down to empty                                  | Spec 3.4's "submitted, empty" is a deliberate "I am unavailable" answer — genuinely withdrawing to "never submitted" needed its own atomic RPC                                                                                                                                            |
| 32  | `AppShell` restructured as a **flex column where only the content area scrolls**, header and bottom nav as ordinary flex children                      | `position: fixed` fought the mobile browser's own dynamic toolbar (shows/hides mid-scroll): the bottom nav could resettle a beat after the page's own scroll position did, reading as a jump that sometimes landed on top of content                                                      |
| 33  | Guard-facing copy no longer names "המנהל" directly; the guard-visible כמות card on the home page was removed                                           | A manager shouldn't read as an authority figure to the people submitting to them; a guard doesn't need to see the shift-count target set for them behind the scenes                                                                                                                       |
| 34  | The preference form **scrolls back to the top** after a successful submit or cancel                                                                    | The submit/cancel buttons sit at the bottom of what can be a long form; the confirmation banner renders at the top and was going unseen                                                                                                                                                   |

### 1.5 Changes in Version 2.4

| #   | Change                                                                                                                                                                                                             | Rationale                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 35  | **Two-level preference strength turned on** (`יכול` / `עדיפות`, migration 31) — the `strength` column reserved since migration 1 is no longer inert; see §3.8                                                      | A guard whose availability skews toward one shift but genuinely prefers another had no way to say so except free text, which the solver deliberately never reads (§3.6) — extracting it from Hebrew free text was assessed and rejected as unreliable and invisible to the guard when it misfired                                                                                                       |
| 36  | **Coverage gaps weighted by segment length**, not a flat per-slot count (`segmentWeight()` / `segment_weight()`, §4.2a) — an S1/S4 (8h) gap now costs double an S2/S3 (4h) gap in the floor/target objective terms | Solving the identical real week twice, at identical weights, produced two different Saturday layouts with the _same_ score — once leaving an 8-guard-hour hole, once a 4-guard-hour one. The objective had no way to prefer the smaller hole; confirmed non-deterministic before the fix (CP-SAT bounced between them across repeated solves), deterministic and always picks the cheaper segment after |

### 1.6 Changes in Version 2.5

| #   | Change                                                                                                                                                                                                                                                                       | Rationale                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 37  | The עדיפות chip (§3.8) now only renders on a day with **more than one** marked shift, and is capped at **N−1 preferred** of N marked shifts that day (1 of 2, 2 of 3)                                                                                                        | With one marked shift there is nothing to prefer it over; with no cap a guard could mark every shift preferred, which is a null signal — the solver would have nothing to favour it over. Both close the same gap: preference only means something as a _relative_ choice                                                           |
| 38  | Guard-facing preference form: the manager-configured כמות number is no longer shown; replaced with a **feasible-shifts estimate** — the best shift count actually achievable from the guard's own marked slots, respecting the same ≥8h rest rule the solver enforces (§3.9) | Consistent with item 33 (v2.3) — a guard doesn't need to see a target set for them behind the scenes. A plain day-count would overstate what a submission can produce (e.g. Sunday night + Monday morning can never both happen, 0h rest) — the guard gets an honest number instead of either the hidden target or a misleading one |

### 1.7 Changes in Version 2.6

| #   | Change                                                                                                                                                                                                                                                           | Rationale                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 39  | **Manager preference detail view + edit-on-behalf-of window** (`GuardPreferenceDetail.tsx`, `GuardPreferenceEditor.tsx`) — a manager can see a guard's actual submitted availability slot-by-slot, not just `TeamTable`'s aggregate counts, and edit it directly | `TeamTable` only ever showed badge counts (12h opt-ins, עדיפות marks); a manager fixing a mistake on a guard's behalf (a guard who can't use the app, a phoned-in correction) had no way to see or change the underlying slots at all                                                                     |
| 40  | The manager-facing editor is a **minimal click-to-toggle grid**, deliberately not a reuse of the guard-facing `WeeklyPreferenceForm`                                                                                                                             | First built by reusing the guard form; rejected as over-complex for what a manager actually needs — clicking the shift cubes and one save button, none of the guard-facing chrome (deadline countdown, feasible-shifts summary, submit-confirmation step) applies when a manager is directly fixing a row |
| 41  | **Confirmation modal before a preference submission is sent** (guard-facing, and the manager-editor's save) — a summary of what is about to be submitted, requiring an explicit confirm                                                                          | A guard tapping "שלח" had no chance to review what they were about to send before it went out; the same review step was extended to the manager's edit-on-behalf-of save for the same reason                                                                                                              |
| 42  | **Dark mode** — system-preference default (`prefers-color-scheme`), with a manual override toggle; Tailwind v4 `@custom-variant dark`, CSS custom properties for shift colours with `.dark` overrides                                                            | Guards use this from their phones at night; forcing a light theme regardless of the phone's own setting was the one piece of UI polish flagged repeatedly                                                                                                                                                 |
| 43  | Dark-mode shift/status colours **softened** (red, green, then orange/light-blue/purple) — less saturated, not desaturated                                                                                                                                        | The first pass read as over-saturated / too vibrant against a dark background once actually used; adjusted by feel rather than a formula, one colour family at a time                                                                                                                                     |
| 44  | Roster JPEG export (`exportRoster.ts`) is **guarded to stay theme-independent** regardless of the viewer's current app theme                                                                                                                                     | The exported image goes to WhatsApp, where it is read by phones in whatever theme they're in — a picture that silently rendered in the exporting manager's dark palette would be a legibility regression for everyone else                                                                                |

### 1.8 Changes in Version 2.7

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                            | Rationale                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 45  | **Guard-requested shift count** (migration 33, §3.10) — a stepper next to the feasible-shifts estimate lets a guard state a preferred shift count for the week, separate from the manager-configured כמות                                                                                                                                                                                         | A guard's כמות was set entirely by the manager; a guard who wanted fewer shifts a given week, or was willing to take more, had no way to say so except a free-text note the solver never reads (§3.6)                                                                                                                                                                  |
| 46  | A request **below** configured wins outright and is **guaranteed** — the guard's own stated ceiling for the week, treated like their own availability (H1), not a manager target                                                                                                                                                                                                                  | "Take what they selected" was the explicit requirement — a target the solver merely aims for (like כמות itself) was measured to be insufficient: a guard who asked for fewer was still handed extra shifts whenever coverage benefited, identical to pre-feature behaviour (see item 47)                                                                               |
| 47  | Fixed: a guard's lower request **wasn't actually a ceiling** at first — `effective_kamut` only ever fed the existing soft floor penalty (P2), never stopped the solver from exceeding it. H4 (§4.1, previously a flat 5-shift constant for every guard) is now a **per-guard `max_shifts` field**, tightened to the guard's own request only when they explicitly asked for fewer than configured | Confirmed against a real production run (roster version 30): stored `effective_kamut` was correctly 1, actual assignment was 2 — the guard's request had no effect on the outcome at all. The "ask for more" path is untouched by this fix and still only ever feeds a soft bonus (item 48), so the two directions stay fully independent                              |
| 48  | A request **above** configured is a **soft, non-guaranteed bonus** (`WEIGHTS.stretch`, mirrors עדיפות's P4b pattern, §4.2) — granted only if the solver can do it at no cost to coverage or rest, capped at whatever is actually feasible from the guard's own marked slots                                                                                                                       | Per Ben's explicit design: the manager's configured כמות stays the "hard" (soft-penalized) target; the extra requested shift is a bonus given only when possible, never forced                                                                                                                                                                                         |
| 49  | A guard already configured at **exactly 5** (the ordinary ceiling) may request a **6th shift** — same soft, non-guaranteed treatment as item 48, exclusive to that one case (§3.10)                                                                                                                                                                                                               | Ben's explicit follow-up requirement, deliberately phased separately from item 48 so the general mechanism could be measured against live data first                                                                                                                                                                                                                   |
| 50  | Fixed: the feasible-shifts estimate (§3.9) had its **own hardcoded 5-shift cap**, left over from before this feature existed, which silently defeated the item 49 allowance at the UI layer even after the solver-side ceiling was correctly raised to 6                                                                                                                                          | `maxFeasibleShifts()` is meant to be a physical fact about the marked slots (7 nights in a row rests fine, so it can legitimately answer 7) — baking a policy ceiling into a "fact" function silently misreported it for the one guard that ceiling doesn't apply to. Now uncapped; callers needing a selectable maximum combine it with the policy ceiling themselves |
| 51  | The requested-shifts stepper **auto-follows** `min(configured, feasible)` live as a guard checks/unchecks boxes, until manually touched at least once                                                                                                                                                                                                                                             | A guard who never interacts with the stepper at all previously kept whatever it was initialised to, only ever clamped downward — never recovering upward if they later marked more days. Easy to just not notice, since nothing about the stepper demands attention the way checking a box does                                                                        |
| 52  | Manager visibility: `TeamTable.tsx` shows a `מבוקש · N` badge per guard alongside the existing עדיפות badge; the manager-editor (item 39) can view **and edit** a guard's requested count on their behalf                                                                                                                                                                                         | Same visibility/edit treatment already established for every other per-guard submission detail (§1.7 item 39)                                                                                                                                                                                                                                                          |

### 1.9 Changes in Version 2.8

| #   | Change                                                                                                                                                                                                                                             | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 53  | **Per-day morning target override** (`weekly_morning_target_overrides`, migration 35, §2.4b) — a manager can raise or lower the Mon-Fri morning target for individual days within one specific week, on top of that week's own uniform 2/3 setting | A holiday week needs a shape the week-level setting alone can't express — e.g. Mon-Wed at 2, Thu-Fri at 3 — without changing the week's baseline for days that aren't exceptional                                                                                                                                                                                                                                                                                       |
| 54  | **Morning-priority coverage weight** (`WEIGHTS.morning_priority`, §4.2b) — an unfilled morning (S1) slot now costs a flat bonus more than an equally-sized unfilled slot elsewhere, in the floor/target penalty terms only                         | Per Ben: the manager's actual preference is a fully-staffed morning over a balanced morning/night when a trade-off is unavoidable — one guard alone at night rather than splitting a flexible guard's availability evenly. Deliberately additive, not a multiplier, like every other weight in the model, and deliberately does not touch a guard's own עדיפות mark (P4b), which only ever breaks a tie the coverage tiers have already left open                       |
| 55  | **Roster view stacks every published week** instead of showing one at a time via a selector (§10.1) — for both guards and the manager                                                                                                              | So a guard (or the manager) sees both the current and next week's roster at once, once both are published, instead of having to flip a selector                                                                                                                                                                                                                                                                                                                         |
| 56  | **Admin real/test view-mode toggle** (`is_demo`, migration 34, §12.8) — a header control, manager/admin-only, filters the manager dashboard's employee lists between real employees and the seeded demo guards                                     | The 7 mock guards (§1.4 item 25's rename) are permanent test fixtures now that real registration is under way; the manager needed a way to see just the real team without the demo noise, without deleting the fixtures he's still using                                                                                                                                                                                                                                |
| 57  | Fixed: `ensure_roster_weeks()`'s "keep every untouched week's deadline live" step (migration 27) was an **unconditional** `UPDATE`, causing a live realtime feedback loop (migration 36, §12.1)                                                    | A same-value `UPDATE` still performs a physical row write, which Realtime broadcasts as a genuine change regardless of whether any column's value actually differs. `useRosterRealtime`'s subscription reacted to that broadcast by invalidating `roster_weeks`, whose query re-calls `ensure_roster_weeks()` — which repeated the same no-op write, forever. Caught live: opening `/manage` fired the RPC roughly every 100ms for as long as the dashboard stayed open |

### 1.10 Changes in Version 2.9

| #   | Change                                                                                                                                                                                                                                            | Rationale                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 58  | **PWA support** (§10.4) — a web app manifest, a minimal no-cache service worker, and a full icon set generated from Ben-supplied artwork, so the app can be added to the home screen on Android (Chrome) and iOS (Safari) and launched standalone | Guards use this from their phones; a real installable icon and name (rather than a browser tab/bookmark) was the one piece of "feels like an app" polish still missing, matching the mobile-first intent stated in §1 |

### 1.11 Changes in Version 2.10

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 59  | **Per-day secondary segment target override** (`weekly_segment_target_overrides`, migration 37, §2.4c) — generalizes item 53's per-day morning override to the other three segments: early afternoon (S2), late afternoon (S3), and night (S4), each independently overridable on **any** day of the week (not just Mon-Fri), lowered to **1** instead of morning's raised-to-3. Overriding a segment's target down to 1 also **pins its floor to `min(1, target)`** instead of leaving it at the flat baseline of 1 | A holiday or short-staffed week sometimes only needs relief outside the morning window — e.g. one guard alone at night is genuinely fine that week — and the morning-only override (§2.4b) had no equivalent for S2/S3/S4. The floor-pinning fix matters on its own: without it, a target correctly lowered to 1 would still report a floor breach the moment exactly 1 guard was assigned, which is the same class of "target isn't what actually gets enforced" bug §1.8 item 47 fixed for כמות — caught and fixed here before shipping, not after, per golden fixture 16 |

### 1.12 Changes in Version 2.11

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 60  | **Free-text assignment notes** (`schedule_assignments.note_before`/`note_after`, migration 38, §12.9) — when manually editing a generated roster, the manager can attach short free text before and/or after a guard's name on one specific cell, e.g. "(מ-10:45)" for an early arrival or "(עד 14:00)" for an early departure, without reshaping the assignment into a different shift type. Rendered everywhere that cell is displayed — the manager's live-edit grid, the shared `RosterGrid` (manager and guard-facing alike), and the JPEG export — and never carried over when the week is regenerated | The segment model (§2.3) answers coverage, not logistics: a guard's real arrival/departure time occasionally differs from what their assigned shift implies, and forcing that into an extra split segment would distort coverage over something that isn't actually a coverage fact. Two independent fields, not one, because the annotation can sit on either side of the name (or both) depending on what it says — same solver-blind, manager-only status as `weekly_submissions.notes` (§3.6) |
| 61  | **Placeholder (guard-less) assignment rows** (`schedule_assignments.guard_id` now nullable, migration 39, §12.9) — a manager can attach a note to a cell with no real guard behind it at all, e.g. "Yam is alone in the morning until 10:45, then Shely joins" as an annotation on the morning block itself, without a second, real assignment for Shely (who may already be genuinely assigned elsewhere that day). Excluded from every hard-rule check and from all coverage/target counting                                                                                                               | Item 60's note only ever rides on a real assignment, which breaks for exactly this case: adding Shely a second time, for real, to say the same thing correctly triggers the one-shift-per-day rule as a genuine double-booking, because that is what it would be. A cell annotation with nobody behind it needed to be expressible as something other than a person — `NULL` is that, and both existing uniqueness constraints already treat it as never colliding with anything                  |

### 1.13 Changes in Version 2.12

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 62  | **Push notifications** (`push_subscriptions`/`notification_log`/`notification_secrets`, migrations 40–42, `send-notifications` Edge Function, §12.10) — a fixed weekly broadcast (Sunday 11:00 Israel time, everyone) announcing that week's submission deadline, plus two reminders (~24h and ~2h before the deadline) sent only to guards who haven't submitted yet. Delivered via Web Push through the service worker already installed for the PWA (§10.4), gated by a bell-icon toggle in the header and a one-time enable prompt on the guard home page | Push-only, by explicit decision — no SMS/email fallback for a guard who never installs the app. First use of `pg_cron`/`pg_net` in this project, since nothing before this ran on a clock — see §12.10 for why the scheduling design changed twice during implementation (two real hosted-Postgres permission walls, not preference) |

### 1.14 Changes in Version 2.13

| #   | Change                                                                                                                                                                                                                               | Rationale                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 63  | **Notification click routing** (§12.10) — tapping any of the three push notifications now opens (or navigates an already-open tab to) `/preferences` directly, instead of just opening the app to whatever page it happened to be on | All three notification types exist to get a guard to submit their availability; landing anywhere else is one extra tap the notification was supposed to save. Carried in the push payload (`url`) rather than hardcoded in the service worker, so a future notification type pointing elsewhere needs no new client code |

### 1.15 Changes in Version 2.14

| #   | Change                                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 64  | **Manual "roster published" broadcast** (migrations 43–44, §12.10) — a manager-only button next to the JPEG export announces a published week to every guard via a new `roster_published` push type, separate from the act of publishing itself, and repeatable per week | A manager sometimes publishes just to check the layout, not to ship it — publish and "tell the team" were conflated in every prior flow. `send-notifications` now accepts a manager's own JWT (checked server-side via `is_manager()`, scoped to this one type only) alongside the existing cron-secret path, so a browser can trigger it. Deliberately **not** deduped like the three cron types: `notification_log_sent_once`'s partial unique index was narrowed to exclude this type, so republishing a correction and announcing again in the same week is allowed |
| 65  | **`publish_roster(p_run_id)` RPC** (migration 43) — replaces three separate, non-atomic client-side table writes with one transactional, manager-gated function (same shape as `unpublish_run`/`delete_schedule_run`), and finally writes `published_at`, a column that has existed on `schedule_runs` since its creation but was never once set | Found while adding the notification button: publishing was the one manager action of its kind never wrapped in an RPC when its siblings were (migration 14) — a network drop between the old three writes could leave a week half-published. No behaviour change for existing callers beyond atomicity and a real timestamp |

### 1.16 Changes in Version 2.15

| #   | Change                                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 66  | **Manager notified on guard submit/edit/cancel** (migration 45, §12.10) — two new push types, `guard_submitted` (new submission or an edit, distinguished in the copy) and `guard_cancelled`, sent to every `manager_targets()` row (role IN manager/admin, not a hardcoded id) whenever a guard saves or cancels their own availability | The manager had no signal that a guard had submitted except opening the dashboard and looking. Deliberately **client-triggered** (fired from `useSavePreferences`/`useDeleteSubmission`'s `onSuccess`), not a database trigger on `weekly_submissions` — `test:cloud` calls `save_week_preferences`/`delete_week_submission` directly, dozens of times per run, against the live project (no separate test database exists here); a table-level trigger would have paged the real manager on every future test run. Firing from the client means test scripts, which never go through React, never reach the code that sends it — and incidentally also means the manager's own edit-on-behalf-of path (`manager_save_week_preferences`, a different hook entirely) is excluded for free, with no `auth.uid()` guard needed |
| 67  | **Server-side event verification** — `send-notifications` re-checks that a `weekly_submissions` row actually exists (submit/edit) or actually does not (cancel) before sending, and that the caller's own JWT resolves to the `guard_id` being reported, rather than trusting either claim from the request body | Same discipline as `roster_published`'s `is_week_published()` check (migration 43) and `generate-schedule`'s server-side role re-check — a guard's browser is not trusted to assert facts about itself. Neither new type is deduped by `notification_log_sent_once` (already narrowed to the three cron types in migration 43) — each real submit, edit, or cancel is its own distinct, reviewable event |

### 1.17 Changes in Version 2.16–2.17

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 68  | **Passkey (Face ID / fingerprint) login, v2.16** — shipped first on `@supabase/supabase-js`'s native experimental Passkey API (`registerPasskey()`/`signInWithPasskey()`), needing zero new migrations or Edge Functions. **Superseded the same day (v2.16→2.17, §8, §12.11)**: real-device testing showed that API only issues true, OS-synced passkeys (visible in the phone's system Passwords & passkeys list, eligible to sync to the guard's Google/Apple account) — not the app-scoped, device-only credential intended. Rebuilt from scratch on `@simplewebauthn/browser`/`@simplewebauthn/server` (`residentKey: 'discouraged'`) in a new `webauthn` Edge Function, storing credentials in two new tables (migration 46, §6.2) instead of GoTrue's own passkey store | A guard's phone is usually personal, but the credential still shouldn't be something the OS offers to sync or restore through its general password manager — that's a materially different trust boundary than "unlocks this app on this phone." Full account of the pivot, the session-minting trick (`admin.generateLink` + `verifyOtp`, no password involved), and the RP-ID-as-per-request-allowlist design in §12.11 |
| 69  | **Remember-me toggle** (`src/lib/supabase.ts`) — a switchable `localStorage`/`sessionStorage` adapter, default **on** so no guard's existing always-persisted session changes unless they opt out. Moved from an initial Preferences card (v2.16) onto the Login page itself in v2.18 (item 71) after Ben's review                                                                                                                                                                                                                                          | Persistence was already unconditional before this (`persistSession: true`, no toggle) — this makes it explicit and reversible for a guard on a shared device, without changing the default anyone already relies on                                                                                                                                                                                                                                                                                          |
| 70  | **App-restart lock gate with a 24h grace window** — a device with a registered passkey re-verifies on a fresh app load rather than silently resuming, UNLESS a real biometric verification succeeded within the last 24 hours (`wo.webauthnUnlockedAt`, only ever set by an actual ceremony, never extended by a mere resume). An expired window now performs a plain, **local-only** sign-out (`supabase.auth.signOut({ scope: 'local' })`) landing on the ordinary Login page, rather than a separate "locked" screen shipped and then removed the same day | Every JS boot — including a plain browser refresh — looks identical to a genuine reopen days later; gating on literal every boot re-prompted on every refresh. `scope: 'local'` matters: an automatic per-device timeout must never revoke a session the same guard has active on another device. The separate lock screen it first shipped with was dropped for feeling inconsistent with the rest of the app — one Login page for everyone, not a second identity |

### 1.18 Changes in Version 2.18

| #   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Rationale                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 71  | **Login UX rework, per Ben's review of the shipped feature** — the Preferences passkey-management card (list/rename/remove) was dropped entirely as redundant (a passkey is set-and-forget; nobody needs to delete one), the remember-me toggle (item 69) moved onto the Login page itself under the personal PIN step, and the Login page's passkey button became **hybrid**: it runs the real sign-in ceremony if this device already has a credential, otherwise falls through to an ordinary badge-code + PIN login | Matches the "sign in with biometrics or set one up" pattern most consumer apps with passkey login use, and closes the gap the management-card removal opened — the hybrid button is now the permanent way back in for a guard who skipped the one-time home-screen setup nudge (§12.11) |
| 72  | **Hybrid flow fluency fix, same day** — the passkey button's no-credential branch now imperatively focuses the code input (`CodeInput` gained a `forwardRef`/`useImperativeHandle` handle) instead of relying on a mount-time `autoFocus` that never refires on a re-render and that mobile browsers mostly ignore outside a real user gesture anyway; and passkey registration now fires directly from the PIN-submit handler immediately after a successful login — same click's async chain — instead of being deferred to a flag `GuardHome` picked up on its next mount, a full navigation away from any usable browser "user gesture" window for `navigator.credentials.create()` | Real-device testing of item 71's first cut found both gaps: the keyboard never visibly opened, and setup only ever started if the guard found and tapped the separate home-screen nudge a second time. Best-effort either way — a failure or cancellation is swallowed silently, since the passive nudge card remains as a fallback |

### 1.19 Changes in Version 2.19

| #   | Change                                                                                                                                                                                                                                                                                                                                                                       | Rationale                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 73  | **Removed the ability to mute/disable push notifications in-app** (§12.10) — the header bell-icon toggle is gone, and so is the underlying capability, not just the button: `useNotifications.ts` lost `disable`/`toggle` in favor of a single `enable`, and `src/lib/push.ts` lost `unsubscribeFromPush()` entirely. `GuardHome`'s existing enable-prompt card, unchanged in shape, is now the only in-app notification control, and was already enable-only in practice (it only ever renders while `Notification.permission === 'default'`) | These notifications carry real schedule-affecting updates (submission deadlines, roster publishes) — Ben's explicit call that no guard should be able to silence them through the app for any reason. Stated precisely because it matters: this closes the *in-app* path only; a guard can still disable notifications for the PWA at the OS/browser level, which has never been something a web app can prevent |

### 1.20 Changes in Version 2.20

| #   | Change                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 74  | **Per-week 12h/11h double-shift display setting** (`roster_weeks.double_shift_display_hours`, migration 47, §2.4d) — a manager toggle that shortens the day12/night12 handover-boundary TEXT next to a guard's name by one hour ("עד 17:45" / "מ 19:45"), purely cosmetic: the shift is still scheduled and counted as a full 12h everywhere it matters | Ben's explicit requirement, phrased as "manage the doubled shift between 12h and 11h" — real-world guards on a day12/night12 sometimes actually leave/arrive an hour off the nominal boundary, and the roster's TEXT should be able to say so without touching coverage math |
| 75  | The shortened text is **suppressed** (falls back to the full 12h boundary) on any specific assignment where that guard is the day's **only** real coverage of the segment the shortened hour would come out of (S2 for day12, S3 for night12)              | Ben's explicit caveat: shortening the text when nobody else covers that hour would misrepresent an actual empty slot as covered — computed live from that day's real assignments (`isDoubleShiftShortened()`), not stored, so it always reflects the current roster            |
| 76  | **(v2.20.1) JPEG preview/download un-gated from "published only"** (§10.2) — `RosterExport` now renders for whichever run is selected, draft or published, gated only on not-mid-edit; `RosterPublishNotify`'s push announcement to every guard stays published-only | Ben's explicit call, reversing the v2.4-era published-only gate: he wants to preview/download any version's picture without publishing first. Deliberately not paired with a draft watermark on the image itself — his choice, no visual difference from the published export |
| 77  | **(v2.20.2) Manager-triggered guard PIN reset** (§12.4, new `reset-pin` Edge Function) — resets a claimed guard's forgotten PIN in place via the GoTrue admin API (`admin.auth.admin.updateUserById()`), without touching `profiles`, `roster_codes`, or any roster history | An employee (Hodaya) forgot her PIN and the existing "החלפת קוד עובד" button on Login did nothing to help — there was no recovery path at all, self-service or otherwise, before this. `profiles.id IS auth.users.id` (`ON DELETE CASCADE`) ruled out a delete-and-re-claim approach, since it would have erased her roster history along with her account |

---

### 1.21 Changes in Version 2.21

| #   | Change                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 78  | **`phone_number` added to the schema** (migrations 48, §12.4/§12.12) — the first contact channel that has ever existed for a guard, on both `roster_codes` (pre-claim) and `profiles` (post-claim), carried across at claim time by a dedicated trigger. Required when a manager adds a new employee, optional/editable for an existing one. No uniqueness constraint yet — deliberately deferred on Ben's explicit instruction | Item 77's manual reset worked, but Ben explicitly wants a REAL, self-service "forgot password" system on the guard's own side — "instead of what we currently have, not in addition to it." Self-service needs some verification channel, and none existed anywhere in this schema before now |
| 79  | **Self-service forgot-PIN via WhatsApp OTP** (§12.12, migration 49, new `whatsapp-pin-reset` Edge Function) — a guard taps "שכחתי סיסמה" on the Login page's PIN step, gets a 6-digit code via WhatsApp (Meta Business Cloud API), enters it, then chooses a new PIN herself — no manager involved on the happy path. The old dead "החלפת קוד עובד" button is gone, replaced (not supplemented) by this plus a small "→ קוד אחר" back-link for the genuinely different "wrong code" case | Ben's explicit design choice among the options discussed: no email/phone existed to build a classic reset-link flow around, and a push-to-manager-approval design was considered and set aside in favor of Ben's own WhatsApp-Business-API idea, which he already has the real phone numbers to support |
| 80  | The manager-mediated `reset-pin` (item 77) **stays as the permanent fallback**, not a stopgap — for any guard with no phone number on file yet, or if WhatsApp delivery fails for some other reason. (Superseded by item 84/85 in v2.22.1: the self-service tier this row describes was fully reverted, so `reset-pin` is now once again the only path, not a fallback to a second tier) | Deliberate two-tier design: self-service is the primary path once a guard has a number on file, but nothing about this feature should ever leave a guard with literally no way back in |

---

### 1.22 Changes in Version 2.22

| #   | Change                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 81  | **Forgot-PIN OTP delivery pivots from WhatsApp to a push notification** (§12.12, migrations 49–50, `whatsapp-pin-reset` renamed `request-pin-reset`) — before any real WhatsApp message was ever sent, Ben discovered his Meta account is restricted from Ads over a disputed fraudulent charge, and Meta requires a Business Portfolio to attach WhatsApp to an app at all, with no way around it ("create an app without a use case" doesn't avoid the requirement either — confirmed directly, not assumed). Rather than wait on the dispute or stand up a new Business Portfolio under a different admin, delivery moves to this app's own already-working `send-notifications` push system instead | Ben's explicit call, once the Meta account restriction was found to be a genuine dead end: reuse infrastructure already live in production rather than depend on an external account he cannot currently unblock |
| 82  | **`phone_number` fully reverted** (migration 50 — columns, trigger, `roster_code_status` view all undone; `AddEmployeeCard`'s required field and `EmployeeRow`'s edit panel removed from `TeamManagement.tsx`) | Item 78 added it for no reason other than feeding the WhatsApp call — nothing else in the project ever used it, so once WhatsApp was dropped there was nothing left to preserve. A "required" field that does nothing would only confuse a future reader |
| 83  | **`send-notifications` gains a `pin_reset_otp` type**, cron-secret-only like the original three cron types (no JWT path — its only legitimate caller, `request-pin-reset`, itself has no caller session to check against). `otp_request` confirms a live `push_subscriptions` row exists before generating a code, and treats a `send-notifications` response reporting zero delivered as a real failure — deleting the now-useless OTP row and returning a clean error rather than a false "ok" | The one real trade-off of the new channel versus WhatsApp: delivery needs an existing subscription, which a phone number never did. Made this failure mode honest and clearly reported rather than silently swallowed, so a guard is never left assuming a code is coming when it never will |

---

### 1.23 Changes in Version 2.22.1

| #   | Change                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 84  | **Self-service forgot-PIN (items 78–83, §12.12) fully reverted** — `AuthContext.tsx`, `useTeam.ts`, `Login.tsx`, `TeamManagement.tsx`, and `send-notifications` restored to their exact pre-item-78 (v2.20.2) state; `request-pin-reset` Edge Function and its test deleted; migrations 48–50 left in place as historical record (they really ran against the live database), a new migration 51 added on top to reverse their net effect (drops `pin_reset_otps`, restores the two `CHECK` constraints migrations 49/50 had widened) | A session-persistence regression appeared in production after v2.22.0 shipped — every page refresh, on every device (including one with no passkey registered, ruling that gate out), signed Ben back to the Login page. A full diff of every file changed since v2.20.2 showed nothing touching session storage or auth config; root cause was never conclusively identified. Ben's call: stop debugging a live regression against an unconfirmed cause and revert to the last confirmed-stable point instead |
| 85  | The manager-mediated `reset-pin` (item 77) is once again the **only** PIN-recovery path — the "החלפת קוד עובד" button on the Login page's `'pin'` step goes back to simply resetting local state to the code-entry step, exactly as it behaved before item 79 | Direct consequence of item 84: with the self-service flow gone, there is no second tier left to fall back from |

---

### 1.24 Changes in Version 2.22.2

| #   | Change                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 86  | Fixed: `useVisibleRosters()` was leaking every historical published week into the guard-facing `/roster` and `/` (GuardHome) pages for a manager-and-guard account, instead of degrading to just the current week when next week wasn't published yet — the extra week was also mislabelled "next week" regardless of whether it was actually in the future | It trusted RLS alone to scope published runs to "current + next," but the `is_manager()` RLS branch has no date floor at all, by design, since it's what lets the manager-only archive (§7) work. Ben is both manager and an active guard, so his own guard-facing pages inherited the archive's unbounded read instead of the guard-scoped one |
| 87  | New `guardVisibleWeekFloor()` (`src/lib/dates.ts`) — a client-side mirror of the database's `guard_visible_from()` — filters `useVisibleRosters()` to it; `RosterView.tsx`/`GuardHome.tsx` now also label a genuinely past week correctly instead of assuming "not current" means "next" | The fix has to live client-side because the RLS policy itself is correct for its actual purpose (the manager archive) — narrowing it would break that; the guard-facing hook needed its own floor on top, not a schema change |

---

### 1.25 Changes in Version 2.23.0

| #   | Change                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 88  | **A placeholder row can optionally occupy a coverage slot** (`schedule_assignments.occupies_slot`, migration 52, §12.9) — a manager editing the roster can now mark a specific guard-less placeholder to count toward that segment's floor/target/ceiling exactly like a real assignment, while it still carries no guard identity | A placeholder (migration 39) was always excluded from every hard-rule check and all coverage counting, unconditionally — useful for a pure annotation, but there was no way to say "someone genuinely covers this slot, I don't want to name who" without it silently reading as short-staffed |
| 89  | `occupies_slot` is meaningful only when `guard_id IS NULL`, enforced by a `CHECK` (`occupies_slot = FALSE OR guard_id IS NULL`) — defaults `FALSE`, so every placeholder that existed before this migration keeps its prior behaviour unchanged. A placeholder still requires at least one note regardless of the flag (Ben's explicit call — occupying a slot does not relax `placeholder_needs_a_note`) | Same defence-in-depth pattern migration 39 used for `placeholder_needs_a_note` — the invariant is enforced at the database layer, not just trusted from the client |
| 90  | `src/lib/validate.ts`'s referee gained its first-ever `guard_id === null` branch — `coverageBySegment()` already counted every assignment guard-agnostically (it never reads `guard_id`), so only the guard-specific loops (H1/H2 availability, H3/H4 one-shift-per-day and the weekly ceiling, H5/H7 rest, and `scoreSchedule()`'s preference/stretch terms) needed an explicit skip for a null `guard_id` | Confirms the coverage model was already generic enough that a coverage-occupying, guard-less row didn't need new hard-rule logic — only an exemption from the rules that inherently require a real guard to check against |
| 91  | New per-row "תופס משבצת בכיסוי" checkbox in `RosterEditor.tsx`'s `SlotEditor`, shown only on a placeholder row and reset to `false` the moment the row is switched to a real guard | UI mirrors the data model exactly: the checkbox only ever means something on a placeholder, so it disappears rather than staying visible-but-inert once a real guard is picked |

---

### 1.26 Changes in Version 2.24.0

| #   | Change                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 92  | **Afternoon block segment shifts** — two new manual-edit-only shift types, `afternoon_early` (covers S2, 14:45-18:45) and `afternoon_late` (covers S3, 18:45-22:45), migration 53, §12.13 — a manager can now put a real guard or an `occupies_slot` placeholder into just one half of the afternoon block, without tying them to the full 8h `afternoon` shift or a 12h `day12`/`night12` that also commits them to the morning or night | Until now the only way to occupy just S2 or just S3 manually was a 12h shift, which drags in a morning or night commitment the manager may not want; the full `afternoon` shift always covers both halves, with no way to scope it down |
| 93  | Added to the shift catalogue (`src/lib/shifts.ts`) exactly like the original five shift types — `covers: ['S2']`/`['S3']`, `requiresBase: 'afternoon'` (same base-availability slot the full `afternoon` shift already requires — guards only ever mark availability by base shift, never by segment), `isExtended: false` (shorter than normal, not longer, so no 12h opt-in applies) | Coverage counting, rest-hour derivation (`restHours`/`classifyRest`, *derived* from each shift's `startH`/`endH`), and eligibility are all already generic over the shift catalogue, not hardcoded to five values — extending the catalogue was enough on its own, no new rule code |
| 94  | New `SOLVER_SHIFT_TYPES` constant (`src/lib/shifts.ts`) — the original five shift types only, mirroring `solver/models.py`'s own independent, hand-maintained list — swapped into `mockSolver.ts`'s candidate-move search in place of the full shift catalogue | Caught before shipping: the mock solver's candidate search also iterates the shift catalogue generically, so the moment the two new types existed it started proposing them on its own — a golden fixture's assignment count changed on a re-run. Both new types are manual-edit only, same as a placeholder; `SOLVER_SHIFT_TYPES` is what actually keeps the automatic generator from ever producing one. Confirmed fixed via `test:compare` regaining exact mock/CP-SAT parity on every fixture |
| 95  | `RosterGrid.tsx`/`exportRoster.ts`'s existing day12/night12 handover-pairing (`buildAfternoonRows`/`rowsFor`) widened to pair the two new types the identical way — a lone half renders as "name / –", two halves pair as "name / name," same as day12/night12 already do, just without the 12h boundary-time suffix (not extended shifts, nothing ambiguous about their hours to annotate) | Reuses 100% of the existing handover-rendering machinery rather than adding a new visual pattern — the segment split was already a solved rendering problem for day12/night12, this just widens which shift types feed it |
| 96  | Fixed in the same pass: `exportRoster.ts`'s handover-row constructor had a latent hardcoded `shift: 'day12'`/`'night12'` literal (harmless while only those two values ever reached it) instead of reading the row's own `.shift` — would have mislabelled a genuine `afternoon_early`/`afternoon_late` row's colour in the exported JPEG | Found while widening the early/late filters to include the new types — `colors[row.early.shift]` (the canvas colour lookup) needed the row's real shift value to resolve correctly |

---

## 2. OPERATIONAL SCHEDULING RULES

### 2.1 Dynamic Roster Size

All constraints scale to the number of guards flagged `is_active = TRUE`, supporting 6–12 registered guards. No constraint hard-codes a team size.

**Current active roster (8):** בן, יובל, לוק, הודיה, שלי, ים, עידן, ניתאי
**Registered but inactive (2):** רום, אדיר

> בן holds the `manager` role **and** is an active guard — he is scheduled on the grid exactly like
> everyone else. `role` and `is_active` are orthogonal: role controls dashboard access, `is_active`
> controls solver inclusion. Which two guards are currently inactive is a placeholder assumption.

> **POC seed data:** only Ben's real badge code (`005396`) is known. All other guards are seeded with
> **placeholder codes `100001`–`100009`** so the proof-of-concept is fully testable. Real codes will be
> collected from the team once the system is validated; swapping them is a single `UPDATE` on
> `roster_codes` plus `profiles.employee_code`, with no schema change.

### 2.2 Shift Catalogue

Five shift types across two grids, plus two manual-edit-only segment shifts (v2.24.0, §12.13).
**A guard works at most ONE shift type per calendar day.**

| Code               | Hebrew         | Window             | Hours | Grid     | Eligibility                                         |
| ------------------ | -------------- | ------------------ | ----- | -------- | --------------------------------------------------- |
| `morning`          | בוקר           | 06:45 – 14:45      | 8     | Standard | All guards                                          |
| `afternoon`        | צהריים         | 14:45 – 22:45      | 8     | Standard | All guards                                          |
| `night`            | לילה           | 22:45 – 06:45 (+1) | 8     | Standard | All guards                                          |
| `day12`            | יום 12ש׳       | 06:45 – 18:45      | 12    | Extended | Requires `allows_12h` on that day's **morning** row |
| `night12`          | לילה 12ש׳      | 18:45 – 06:45 (+1) | 12    | Extended | Requires `allows_12h` on that day's **night** row   |
| `afternoon_early`† | צהריים מוקדם   | 14:45 – 18:45      | 4     | Standard | All guards — same `afternoon` base requirement      |
| `afternoon_late`†  | צהריים מאוחר   | 18:45 – 22:45      | 4     | Standard | All guards — same `afternoon` base requirement      |

> **Shift weight:** a 12h shift counts as **1** shift against the guard's כמות and against the 5-shift weekly ceiling — identical to an 8h shift. It is _not_ 1.5. The two 4h segment shifts follow the
> same rule: **1** shift, not a fraction, consistent with the existing hours-agnostic count.

> † **Manual-edit only** (migration 53, §12.13) — never produced by either engine, same status as a
> placeholder row (§12.9). `SOLVER_SHIFT_TYPES` (`src/lib/shifts.ts`) is the original five shift
> types only, and is what `mockSolver.ts`'s candidate search actually iterates; the CP-SAT solver
> (`solver/models.py`) has no notion of these two at all. Lets a manager occupy just S2 or just S3 of
> the afternoon block without the full `afternoon` shift or a 12h `day12`/`night12`.

### 2.3 Segment Coverage Model

Both grids tile the same 24 hours on four boundaries: **06:45 / 14:45 / 18:45 / 22:45**. Coverage is therefore enforced per _segment_, which lets 8h and 12h guards be mixed freely on the same day.

| Segment | Window        | Length | Covered by                                |
| ------- | ------------- | ------ | ------------------------------------------ |
| **S1**  | 06:45 – 14:45 | 8h     | `morning`, `day12`                         |
| **S2**  | 14:45 – 18:45 | 4h     | `afternoon`, `day12`, `afternoon_early`†   |
| **S3**  | 18:45 – 22:45 | 4h     | `afternoon`, `night12`, `afternoon_late`†  |
| **S4**  | 22:45 – 06:45 | 8h     | `night`, `night12`                         |

† Manual-edit only — see §2.2.

### 2.4 Targets vs. Critical Floors

> **The raised morning target applies Monday to Friday only.** Saturday and Sunday are the days
> off at the school and always run a target of 2 (floor 1) no matter what the week is set to.
> `segmentTargets()` / `segmentFloors()` therefore take a day index, not just the week setting.

| Segment                              | Target Capacity                       | Critical Floor                               |
| ------------------------------------ | ------------------------------------- | -------------------------------------------- |
| **S1** (morning window, **Mon-Fri**) | Manager-set: **2 or 3**               | **1** if target = 2; **2** if target = 3     |
| **S1** (morning window, **Sat/Sun**) | Always **2**                          | Always **1**                                 |
| **S2** (early afternoon)             | 2 (or **1**, per-day override, §2.4c) | 1, or **`min(1, target)`** under an override |
| **S3** (late afternoon)              | 2 (or **1**, per-day override, §2.4c) | 1, or **`min(1, target)`** under an override |
| **S4** (night window)                | 2 (or **1**, per-day override, §2.4c) | 1, or **`min(1, target)`** under an override |

- The **target is a hard ceiling** — the solver never over-staffs a segment.
- The **floor is a soft constraint with a heavy penalty** (weight 1000). It is effectively never breached, but a breach returns a readable _coverage report_ instead of a bare `INFEASIBLE`.
- It is fully acceptable for segments to sit between floor and target. The solver satisfies floors first, then כמות, then fills remaining target slots.

### 2.4a Submission Window

A week's submission window is derived, not stored, from a **configurable** offset and time (migration
22 — see §12.5; the shape below was a literal before that):

```
week W starts on a Sunday
  opens   (W − open_offset_days)     at open_time     Asia/Jerusalem  -- default Saturday 20:00
  closes  (W − deadline_offset_days) at deadline_time  Asia/Jerusalem  -- default Wednesday 19:00
```

With the defaults, W = Sunday 16 Aug opens Sat 8 Aug 20:00 and closes Wed 12 Aug 19:00. Next week's
window is therefore already open when the current week begins and shuts midweek — which is what
keeps exactly **two** weeks live at a time (three for a few hours around the open time, which is
inherent to a window that opens before the previous one closes rather than a defect). Changing the
offsets or times preserves this shape as long as `open` stays configured to land before `deadline`
(enforced by a CHECK, §12.5) — the manager is not required to keep the gap this exact size.

`ensure_roster_weeks()` is idempotent and runs on every app load. It creates the current week and
the next one, opens or locks them against their windows, and **never touches a week whose status a
manager has set by hand** (§12.3).

### 2.4b Per-Day Morning Target Override (migration 35, v2.8)

`roster_weeks.morning_target_slots` is a single value for the whole week (§2.4) — Mon-Fri all get
the same target, 2 or 3. That's too coarse for an exceptional week: a holiday needing Mon-Wed at 2
guards but Thu-Fri at 3 can't be expressed by the week-level setting alone. `weekly_morning_target_overrides`
adds a **per-day exception**, for Mon-Fri only (`day_index BETWEEN 1 AND 5` — Sat/Sun stay hard-locked
at 2 regardless, unchanged from §2.4) and scoped to one specific week.

**Sparse by design**, the same convention `requested_shifts` and `notes` already use (§3.4/§3.10): a
day's row exists only when it **differs** from the week's own baseline. Saving a value equal to the
current baseline deletes the row instead of storing a redundant one — `morningTargetForDay()`
(`src/lib/shifts.ts`) checks the override map first, falling back to the week setting when a day has
no entry. This means raising or lowering the week-level 2-vs-3 toggle later automatically re-applies
to every day that was never explicitly overridden, exactly the "temporary exception" shape a holiday
week needs — the override doesn't have to be re-entered or cleared when the underlying baseline
changes.

`morningTargetForDay()`, `segmentTargets()` and `segmentFloors()` all take the override map as an
optional third argument, threaded through everywhere they're already called: both solver engines
(§9.3), both referees (`validate.ts` / `verify.py`), `CoverageMatrix`, `RosterGrid`, `RosterEditor`,
and the JPEG export (`exportRoster.ts`, which mirrors `RosterGrid` rule for rule, §10.2). The solver
contract (§9.2) carries it as `morning_target_overrides`, a sparse `{day_index: target}` map, default
empty so every fixture and caller written before this existed still parses unchanged.

**Manager UI**: a collapsed-by-default "החרגה ליום ספציפי" section on `WeekControlsPanel`
(`ManagerDashboard.tsx`), one row per weekday, each a 2/3 toggle identical in style to the existing
week-level one, pre-filled with the _effective_ value (override or baseline) and badged "הוחרג" when
an explicit override is active for that day.

### 2.4c Per-Day Secondary Segment Target Override (migration 37, v2.10)

§2.4b's per-day override only ever touched the morning (S1) target. The other three segments —
early afternoon (S2), late afternoon (S3), night (S4) — had no equivalent: their target sat at a
flat **2** every day, for every week, with no way to express "this one day only needs 1." A short-
staffed or exceptional week sometimes needs relief outside the morning window specifically — one
guard alone at night is genuinely acceptable that day — and §2.4b couldn't say that.
`weekly_segment_target_overrides` closes that gap for S2/S3/S4, independently, on **any day of the
week** (`day_index BETWEEN 0 AND 6` — unlike §2.4b, there is no weekend lock to preserve here, since
S2/S3/S4 never had a Sat/Sun special case to begin with), lowered to **1** (never raised — these
segments have no "3" tier the way morning does).

One generic table, not three near-identical ones: a `segment` column (`'S2' | 'S3' | 'S4'`)
distinguishes which of the three a row applies to, since all three share an identical shape
(day-scoped, week-scoped, 1-or-2 valued). Same **sparse-by-design** convention as §2.4b: a row
exists only when it differs from the flat-2 baseline. `secondaryTargetForDay(segment, dayIndex,
overrides)` (`src/lib/shifts.ts`, mirrored in `solver/models.py`) checks the override map first,
falling back to 2 when a day/segment has no entry.

**Floor pinning — the one behaviorally new rule, not just a copy of §2.4b's shape.** Overriding a
segment's target down to 1 also pins that segment's floor to **`min(1, target)`**, not the old flat
1 baseline. Without this, a target correctly lowered to 1 would still report a floor breach the
instant exactly 1 guard was assigned — the same "target isn't actually what gets enforced" trap
§1.8 item 47 hit for כמות. `segmentFloors()` computes this identically in both `src/lib/shifts.ts`
and `solver/models.py`, verified by golden fixture 16
(`solver/tests/fixtures/16-secondary-target-override.json`), which explicitly asserts no floor
breach is reported when a day's S3 or S4 target is overridden to 1 and exactly 1 guard is assigned.

Threaded through everywhere §2.4b's override already reaches: both solver engines (§9.3), both
referees (`validate.ts` / `verify.py`), `CoverageMatrix`, `RosterGrid`, `RosterEditor`, and the JPEG
export (`exportRoster.ts`), plus the guard-facing roster view (`RosterView.tsx` via
`useVisibleRosters`), which now also fetches this table so a guard's own view of a published week
reflects the same overridden target. The solver contract (§9.2) carries it as
`secondary_target_overrides`, a sparse `{S2: {day_index: target}, S3: {...}, S4: {...}}` map,
default `{}` for every segment so every fixture and caller written before this existed still
parses unchanged. Because guards mark availability per **base shift** (`afternoon` as one unit, not
S2/S3 separately), the pre-flight coverage check in `CoverageMatrix` uses the **stricter of S2 and
S3** for the afternoon block (`Math.max(floors.S2, floors.S3)` / `Math.max(targets.S2, targets.S3)`)
— and `RosterGrid` / `exportRoster.ts` pad the afternoon block's row count to
`Math.max(earlySlots, lateSlots)` so the grid still shows the right number of rows when S2 and S3
diverge for a day.

**Manager UI**: the same "החרגה ליום ספציפי" section on `WeekControlsPanel` now renders up to four
rows per day — S1 (only on working days, unchanged from §2.4b) plus S2/S3/S4 (every day) — each a
`SegmentOverrideRow`, morning's toggle at 2/3 and the other three at 1/2, labeled "בוקר" / "צהריים
מוקדם" / "צהריים מאוחר" / "לילה" and badged "הוחרג" the same way. The override counter badge changed
from "(N ימים הוחרגו)" to a combined "(N חריגות)" summing the morning override count with all three
secondary segments' counts.

### 2.4d Double-Shift Display Hours (migration 47, v2.20)

`roster_weeks.double_shift_display_hours` (`11 | 12`, default `12`) is a manager-facing, per-week
setting that is deliberately invisible to the solver, both referees, and every coverage/kamut/rest
computation — a day12/night12 guard is scheduled for, and counted against every hard rule as, the
full 12 hours regardless of this value. The **only** thing it changes is the handover-boundary TEXT
rendered next to the guard's name: RosterGrid's morning-block "עד 18:45" suffix on a day12 chip and
night-block "מ 18:45" suffix on a night12 chip. At the default 12 these read the full boundary; set
to 11, they shorten by one hour — "עד 17:45" / "מ 19:45" — **unless** that specific guard is the
day's only real coverage of the segment the shortened hour would come out of (S2's last hour for
day12, S3's first hour for night12), in which case the text stays at the full 12h boundary so the
roster never implies an hour with literally nobody there, even though the guard is (and always was)
actually present for it either way.

`isDoubleShiftShortened()` / `doubleShiftSuffix()` / `doubleShiftLabel()` (`src/lib/shifts.ts`)
implement this once, generically over any assignment-shaped row (`{ shift, guard_id }`) matched by
object reference rather than id, so the identical logic runs against `ScheduleAssignment` rows and
the roster editor's own `DraftAssignment` shape without either importing the other's type. Threaded
through every place a day12/night12 chip renders: `RosterGrid` (manager and guard, shared), the
manager's live-edit grid (`RosterEditor`'s `SlotEditor` chips), the JPEG export (`exportRoster.ts`,
mirroring `RosterGrid` rule for rule as always), and the guard's own "המשמרות שלי" list
(`RosterView.tsx`), which uses `doubleShiftLabel()` to shorten the standalone `"06:45-18:45"` /
`"18:45-06:45"` window label it prints rather than a name-suffix.

**Manager UI**: a two-button 12h/11h toggle on `WeekControlsPanel`, styled identically to the
existing morning-target 2/3 toggle, sitting between the morning-capacity section and the per-day
override section. `useUpdateWeek()` gained a `doubleShiftHours` input alongside `morningTarget`,
patching the new column the same way. `useVisibleRosters()` (guard portal) fetches the column
alongside `morning_target_slots` so a guard's own view reflects it too.

**Sparse-by-week, not sparse-by-day** — unlike §2.4b/§2.4c's per-day override tables, this is a
single flat value per week, closer in shape to `morning_target_slots` itself than to its per-day
exception tables: there is no "differs from a baseline" concept here, just one on/off choice for the
whole week. `DEFAULT 12` on the column means every existing and future week keeps today's unchanged
text unless a manager explicitly opts a week in — no standing default setting was added (unlike
`default_morning_target_slots`), since nothing about this needs to carry forward differently for a
brand-new week versus any other.

### 2.5 Capacity Analysis (why floors must be soft)

Weekly demand in guard-hours at full target, morning target = 2:

```
(2 × 8h) + (2 × 4h) + (2 × 4h) + (2 × 8h) = 48 guard-hours/day  →  336/week
```

| Scenario                                 | Weekly supply | Verdict                            |
| ---------------------------------------- | ------------- | ---------------------------------- |
| 8 guards × 5 shifts × 8h                 | 320h          | ❌ Short of target-2 by 16h        |
| 8 guards × 5 shifts × 12h                | 480h          | ✅ Target-2 reachable              |
| Floor-only coverage (24 guard-hours/day) | 168h needed   | ✅ Always safely met               |
| Morning target = 3 (Mon-Fri only)        | ~376h needed  | ⚠️ Requires substantial 12h uptake |

**Conclusion:** with 8 guards, floors are always achievable and full target coverage is only achievable with meaningful 12h opt-in. The system is designed to degrade gracefully between the two and to report the gap explicitly.

### 2.6 Rest Rules

- **Below 8 hours rest: hard-blocked.** Unbreakable, physically impossible.
- **Exactly 8 hours rest: permitted but discouraged** — each occurrence costs **−5**.
- **12 hours rest or more: entirely free**, no penalty.
- Since a guard works at most one shift per day, rest only applies across consecutive days.

Derived rest matrix (rows = shift on day _d_, columns = shift on day _d+1_):

| ↓ prev \ next → | `morning` | `day12`   | `afternoon` | `night12` | `night` |
| --------------- | --------- | --------- | ----------- | --------- | ------- |
| `morning`       | 16h ✅    | 16h ✅    | 24h ✅      | 28h ✅    | 32h ✅  |
| `afternoon`     | **8h ⚠️** | **8h ⚠️** | 16h ✅      | 20h ✅    | 24h ✅  |
| `day12`         | 12h ✅    | 12h ✅    | 20h ✅      | 24h ✅    | 28h ✅  |
| `night`         | **0h ⛔** | **0h ⛔** | **8h ⚠️**   | 12h ✅    | 16h ✅  |
| `night12`       | **0h ⛔** | **0h ⛔** | **8h ⚠️**   | 12h ✅    | 16h ✅  |

⛔ = hard-blocked · ⚠️ = allowed, −5 penalty · ✅ = free

Exactly **four** penalised transitions remain, all of them 8-hour rests:
`afternoon→morning`, `afternoon→day12`, `night→afternoon`, `night12→afternoon`.

> **Note:** because 12h rest is free, `day12 → day12` on consecutive days carries no penalty.
> Combined with the 5-shift ceiling this permits up to 60 working hours in 5 consecutive days.
> The 5-shift ceiling (§2.7) is the only thing bounding this.

> **The No-Clopen rule is now derived, not declared.** The four ⛔ cells _are_ No-Clopen: any night-ending shift makes the next morning physically impossible (0 hours rest).

### 2.7 Weekly Volume Limits

- **Hard ceiling:** no guard exceeds **5 shifts per week** — ordinarily. Since v2.7 (§3.10) this is a
  **per-guard** value (`max_shifts`), not a module-wide constant: it is tightened below 5 for a guard
  who explicitly requested fewer shifts than configured, and raised to 6 for a guard already
  configured at exactly 5 who explicitly requested a 6th. Every other guard's ceiling stays exactly 5.
- **Soft minimum:** each guard should reach their `effective_kamut` (weight 100 per missing shift).
- **Soft bonus (v2.7):** a shift beyond `effective_kamut`, up to the guard's own `stretch_target`,
  is rewarded but never required (§3.10, §4.2 P2b) — the requested-shift-count analogue of the
  עדיפות bonus (P4b, §3.8).
- **Automatic כמות override (pre-flight):**
  ```
  effective_kamut = min(configured_kamut, distinct_available_days, 5)
  ```
  A guard whose כמות is 4 but who marked only 2 available days is automatically lowered to 2. This is computed before the solver runs and is displayed to the manager as an override notice. Since
  v2.7, a guard's own explicit requested-shift-count (below configured) can lower this further —
  `requested_shifts` is folded into the same `effective_kamut` calculation, not a separate number
  (§3.10).
- **Per-guard default (migration 19):** `configured_kamut` is a per-WEEK value
  (`weekly_guard_targets`), but it is a per-GUARD steady state — the same 5, 5, 4, 5, 5, 3, 2, 2 the
  manager was re-entering by hand every week. `profiles.default_kamut` holds that baseline.
  `ensure_roster_weeks()` seeds `weekly_guard_targets` from it for any (week, guard) pair that does
  not have a row yet — new week, or a guard registering mid-week — via `ON CONFLICT DO NOTHING`, so
  a value the manager has already set (by hand, through the Stepper on `TeamTable`) is never
  overwritten. There is no UI to edit the baseline itself; it is set directly, the same way the seed
  badge codes are, on the expectation that a guard's steady state changes rarely enough that asking
  isn't worth a settings screen.

### 2.8 Cross-Week Carry-In

The solver accepts a `carry_in` map of `{guard_id → shift worked on the previous Saturday}`, read from the previous week's **published** run. The full rest matrix (§2.6) is applied between that shift and each guard's Sunday assignment. In particular, a guard who worked Saturday `night` or `night12` cannot work Sunday `morning` or `day12`.

The current week's Saturday assignments become the next week's carry-in, closing the loop.

---

## 3. GUARD PREFERENCE MODEL

### 3.1 Submission Structure

Per week, each guard submits:

1. **Availability:** any subset of the 21 base slots (7 days × בוקר/צהריים/לילה). An empty subset is valid.
2. **Preference strength** (2-level `יכול` / `עדיפות`, migration 31, v2.4) — a marked slot may additionally be flagged עדיפות. See §3.8 for the mechanism and the solver-weight tuning story.
3. **Per-day 12h opt-ins:** each marked בוקר or לילה slot may carry `allows_12h`, extending that one day only.

### 3.2 Availability Is Hard

The solver will **never** assign a guard to a slot they did not mark. If that leaves a segment below target, the shortfall is reported to the manager rather than silently overridden. This is a deliberate trade: guard trust over automatic coverage.

> **Resolved (§13 item 6, 8 August).** The manager's stated rule is _"we can't have an unoccupied
> shift"_ — in practice he would phone somebody who had not volunteered. Under the current model the
> solver cannot do that; it reports the empty shift instead. Making availability **soft** (penalised
> below a floor breach but above a target gap) would let it draft an unmarked guard only when the
> alternative is an empty shift. On the first real dataset CP-SAT achieved **zero** floor breaches
> without it, so this was assessed as insurance rather than a fix — and Ben decided to keep
> availability hard. A floor breach still gets a phone call, same as before this system existed.

### 3.3 12h Eligibility Derivation

| Shift     | Assignable when                                                         |
| --------- | ----------------------------------------------------------------------- |
| `day12`   | guard marked **בוקר** that day **AND** that row has `allows_12h = TRUE` |
| `night12` | guard marked **לילה** that day **AND** that row has `allows_12h = TRUE` |

Because the flag lives on the preference row, removing the availability removes the opt-in with
it. There is no reconciliation step and no way to be opted in for a day you no longer work.

The preference form states this explicitly in Hebrew, e.g. _"אם תסמן, ייתכן שתשובץ 06:45–18:45 בימים שסימנת בהם בוקר."_

### 3.4 Empty Submissions

A guard may submit a completely empty sheet. This is a normal, non-error state. Because §2.7 auto-lowers `effective_kamut` to 0 when there are no available days, the solver simply does not schedule them. The system distinguishes three states:

| State                       | Meaning                                                     |
| --------------------------- | ----------------------------------------------------------- |
| **Not submitted**           | No row in `weekly_submissions` — manager should chase them  |
| **Submitted, empty**        | Row exists, zero preference rows — deliberately unavailable |
| **Submitted, partial/full** | Row exists with ≥1 preference row                           |

### 3.5 Submission Lock

Guards may create and edit preferences until the week's `submission_deadline` (**Wednesday 19:00 Asia/Jerusalem**, i.e. `week_start - 4`). After that, RLS blocks guard writes at the database engine level. Only managers can edit and only managers can trigger generation.

### 3.6 Free-Text Notes

Each `weekly_submissions` row carries one optional `notes` column (≤500 characters, enforced by a
CHECK) — a place for context that does not fit the slot model: _"עדיפות למשמרות לילה"_, _"עד 4
משמרות השבוע"_, _"דבר איתי אם אתה צריך עזרה"_. This is deliberately **not** a preference-strength
or constraint field (§3.1 item 2 remains deferred) — the solver never reads it. It exists for the
human reading the roster, not the one generating it.

An all-whitespace note is normalised to `NULL` inside `save_week_preferences`, the same treatment
an empty slot array gets (§3.4): absence of content should leave a clean absence of data, not a
stray string. Shown to the manager on the team list (`TeamTable`) directly under each guard's row,
next to the 12h badges — where the manager is already scanning before setting כמות, and where a
line like _"עד 4 משמרות"_ is something to act on rather than something to go looking for. It appears
without a reload: `weekly_submissions` and `weekly_wish_preferences` are in the Realtime publication
(migration 18), so a guard's save invalidates the manager's dashboard query live (§10).

### 3.7 Cancelling a Submission (migration 30)

A guard may withdraw a submission entirely, via `delete_week_submission(p_week_start)` — genuinely
back to **"not submitted"** (§3.4's first state), not an edit down to an empty sheet. The two are
different answers: "submitted, empty" is a deliberate _"I checked and I'm unavailable this week"_;
cancelling is _"disregard what I sent, I may submit something different later."_ Ben's scenario:
something comes up in a guard's life inside the still-open window and they want to reconsider,
possibly resubmitting a corrected sheet before the deadline rather than living with a stale one.

Mirrors `save_week_preferences`' shape exactly — `SECURITY INVOKER`, acts only on the caller's own
row via `auth.uid()`, gated on `is_week_open(p_week_start) OR is_manager()` — and deletes from both
`weekly_wish_preferences` and `weekly_submissions` in one transaction, since the two tables are not
FK-linked (§6.2) and a two-step client-side delete could half-fail. The guard-facing form
(`WeeklyPreferenceForm.tsx`) shows a "ביטול ההגשה" card, only once something exists to cancel and
only while the week is open, behind the same click-again-to-confirm pattern already used for
deleting an employee (§12.4).

### 3.8 Two-Level Preference Strength (migration 31, v2.4)

**Rejected first: extracting it from the free-text notes field.** A guard's notes (§3.6) already
carries things like _"עדיפות למשמרות לילה"_, and the manager can read that — but the solver
deliberately never does. Parsing it programmatically was ruled out: Hebrew has no fixed phrasing a
guard would reliably use, a false parse would silently mis-weight the solver, and the guard would
have no way to know a parse had even happened, let alone that it was wrong. The schema had already
reserved a real mechanism for this since migration 1 — `weekly_wish_preferences.strength SMALLINT
CHECK (strength IN (1, 2))`, always defaulting to 1 — so turning that on is what shipped instead.

**Mechanism.** Any slot a guard has already marked available may additionally be flagged עדיפות via
a chip in `WeeklyPreferenceForm.tsx`, rendered for every marked shift that day (not just the
morning/night pair the 12h chip is limited to — the point is choosing between e.g. afternoon and
night on a day both are marked, exactly the case that motivated this). `save_week_preferences`
carries `strength` inside the same per-slot JSON object `allows12h` already used, so an old-shaped
caller still parses (`COALESCE(..., 1)`). Deleting the slot deletes the strength mark with it, same
as `allows_12h` — there is no way to be "preferred" for a shift you are not marked available for.

**Solver mechanism and the weight-tuning story.** `SolverGuard.preferred` (a day-index → base-shift
map, mirroring the shape of `twelve_hour_day`/`twelve_hour_night`) collects a guard's strength-2
slots. Both engines add `w.preferred` on top of the existing flat `w.pref` (§4.2 P4) for a matching
assignment — a term P4b, not a new priority tier. The weight was **measured, not assumed**, against
the live demo dataset before settling on a value:

| Weight tried                                                                   | Result                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2 (shipped)                                                                    | One guard's preferred shifts honoured on 4 of 5 working days, **zero cost** anywhere else in the roster (no new target gap, no new 8h-rest occurrence)                         |
| 50 (above target=10 and rest8=5, reliably wins an ordinary coverage trade-off) | Same guard's preference fully honoured (5 of 5), but at the cost of **two extra 8-hour-rest occurrences** elsewhere in the roster, for **no change** in total target-gap count |

Weight 2 shipped: it is a genuine tie-breaker, kept below `rest8` (5) and `target` (10), so it can
only decide between options the rest of the objective is already indifferent to — it can never
cause a floor breach, an unmet כמות, or an extra rest penalty just to honour a preference. Raising
it is possible but was measured to cost real roster quality for one guard's last preferred shift;
see the `preferred` comment on `WEIGHTS` in `src/lib/shifts.ts` before changing it.

**What it does not do.** It cannot manufacture coverage from a guard who isn't marked available —
that is a different question than the one target/floor gaps answer (§4.2a). Its actual effect is
narrower and was confirmed empirically: on repeated identical generations, CP-SAT was found landing
on multiple tied-optimal rosters that differed only in _which_ equally-eligible guard filled a
given slot (e.g. two guards with identical availability and no preference data, swapped across
runs) — exactly the situation `w.preferred` exists to resolve, once real preference data exists to
break the tie with. A synthetic tie-breaker (e.g. sorting guards by ID) was considered and rejected
in favour of this: it would make output stable but arbitrary, where real preference data makes it
stable _and_ meaningful.

Manager visibility: `TeamTable.tsx` shows a `★ עדיפות · N` badge per guard, next to the existing
12h-opt-in badges, counting their strength-2 rows for the week.

**UI refinement (v2.5, §1.6 item 37).** Two guardrails added after real testing surfaced both gaps:
the chip row only renders when a day has **more than one** marked shift (`daySlots.length > 1`) —
with one marked shift there is nothing to be preferred _over_, so showing it there was noise. And a
day's preferred count is capped at **N−1** of its N marked shifts (`toggleStrength` in
`WeeklyPreferenceForm.tsx` blocks turning a chip on once the cap is hit; the chip itself renders
disabled rather than silently no-opping). Marking every marked shift preferred is exactly as
uninformative to the solver as marking none — P4b needs a non-preferred alternative to have
outscored for the bonus to mean anything.

### 3.9 Feasible-Shift Estimate (v2.5, §1.6 item 38)

The preference form's summary card used to show the guard their manager-configured כמות directly
(`{configuredKamut} / {MAX_SHIFTS_PER_WEEK}`) — inconsistent with §1.4 item 33's decision that a
guard doesn't need to see a target set for them behind the scenes. Removed, but a bare day-count in
its place would have overstated what a submission can produce: marking Sunday `night` and Monday
`morning` is two marked days but zero legal combinations (0h rest, the same H5/⛔ rule as
generation itself) — so a naive count would read as a promise the roster can't keep.

`maxFeasibleShifts` (`src/lib/shifts.ts`, shared with the manager's `GuardPreferenceEditor`)
computes the actual best case instead: a small day-by-day DP where the score ending in "worked
shift S on day d" is `1 + ` the best score from day `d−1` that isn't blocked by resting into S (or
the best "day off" score, always compatible), reusing `classifyRest` — the same rest classification
§2.6/generation itself uses. Verified against a hand-worked example before shipping (alternating
night/morning across four days collapses to 2 feasible, not 4 — confirmed both by hand and by the
implementation before it shipped). Deliberately does not model 12h (day12/night12) opt-ins
separately — this is a guidance number for the guard reading their own submission, not solver
input, and the added complexity wasn't judged worth it for that purpose. A caption appears under
the number only when it's actually lower than the plain day count, so the guard sees an explanation
exactly when the number would otherwise look unexplained.

> **v2.7 change:** this function is **not** capped at `MAX_SHIFTS_PER_WEEK` (5) any more — it
> returns the true DP result uncapped (see §3.10 item 50 / §1.8 item 50 for why the cap was removed
> and what it broke while it was there). It is purely a physical fact about the marked slots (a
> guard who marked every night of the week can legitimately be told 7); any policy ceiling on what a
> guard may actually _select_ is applied separately, by the caller, via `maxRequestableShifts()`.

### 3.10 Guard-Requested Shift Count (migration 33, v2.7)

**What it is.** A stepper (`כמות משמרות מבוקשת`) next to the feasible-shifts estimate (§3.9), on
both the guard-facing form and the manager's edit-on-behalf-of window (§12.7), lets a guard state a
preferred shift count for the week — independent of, and layered on top of, the manager-configured
כמות. Stored as `weekly_submissions.requested_shifts` (nullable `SMALLINT`, `CHECK (BETWEEN 0 AND
6)`), threaded through `save_week_preferences` / `manager_save_week_preferences` as a trailing
`p_requested_shifts` parameter, the same shape `notes` (§3.6) already used. Equal-to-configured
normalises to `NULL` on save — absence of a real request should leave a clean absence of data, the
same convention `notes` and empty availability already get (§3.4, §3.6).

**The four rules, as specified by Ben (verbatim intent):**

| Requested vs. configured                 | Outcome                                                                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Below**                                | Wins outright — `min(configured, requested)` becomes the new `effective_kamut`, and (v2.7) is _guaranteed_: the guard's own hard weekly ceiling is tightened to match, so it is never exceeded regardless of coverage benefit |
| **Equal**                                | No-op — normalises to `NULL`, identical to not requesting at all                                                                                                                                                              |
| **Above, guard configured below 5**      | Soft, non-guaranteed bonus — granted only if the solver can fit it at no cost to coverage or rest, capped at `MAX_SHIFTS_PER_WEEK` (5)                                                                                        |
| **Above, guard configured at exactly 5** | Same soft treatment, but the ceiling itself may rise to 6 — "only if possible and necessary, not a hard constraint"                                                                                                           |

**Two new derived numbers feed the solver** (`src/lib/shifts.ts`), computed client-side exactly like
`effective_kamut` always was — both engines only ever see pre-derived numbers, never the raw
`requested_shifts` or `configured_kamut` (the same "solver stays dumb about business rules"
principle §2.7's auto-override already established):

- **`effective_kamut`** (extended) — `floorTarget = requested < configured ? requested :
configured`, then clamped by `min(distinct_available_days, MAX_SHIFTS_PER_WEEK)` exactly as
  before. A request at or above configured leaves this unchanged from pre-v2.7 behaviour.
- **`stretch_target`** — the rewarded (never penalised) ceiling for a request above configured:
  `max(effective_kamut, min(requested, distinct_available_days, maxRequestableShifts(configured)))`.
  Feeds a new soft objective term, P2b (§4.2), mirroring how P4b (§3.8) sits on top of the flat
  preference term.
- **`max_shifts`** — this guard's actual hard weekly ceiling (replacing the flat H4 constant, §4.1):
  `effective_kamut` when the guard requested fewer than configured (a genuine, guaranteed tightening);
  otherwise `MAX_SHIFTS_PER_WEEK`, or `ABSOLUTE_MAX_SHIFTS_PER_WEEK` (6) when the guard is configured
  at exactly 5 **and** explicitly requested more.
- **`maxRequestableShifts(configuredKamut)`** — the small helper centralising "who is eligible for a
  6th shift": returns 6 only when `configuredKamut === MAX_SHIFTS_PER_WEEK`, else 5. Both
  `guardShiftCeiling()` and `stretchTarget()` consume it, and both stepper UIs use it directly to
  size the stepper's own max — so a guard only ever sees "6" as an option when it could actually
  apply to them.

**Bug found and fixed in production: the lower-request "guarantee" wasn't one at first (item 47).**
The first shipped version computed the lowered `effective_kamut` correctly but only ever used it as
the existing soft floor penalty (P2) — nothing stopped the solver from exceeding it. A real guard
requested 1 shift (configured 2) and was still assigned 2, identical to pre-feature behaviour;
confirmed directly against the production run that surfaced it (roster version 30, week
`2026-08-09`): stored `effective_kamut` was correctly `1`, actual assignment was `2`. Root cause: a
"target" in this codebase is structurally a floor (penalised if missed) unless something _also_
enforces it as a ceiling — conflating the two is an easy mistake because `effective_kamut` LOOKS
like it should cap the guard. Fixed by generalising H4 (§4.1) from a flat module-wide constant into
the per-guard `max_shifts` field above, mirrored in both engines and both referees. Re-verified
directly against the same production data: the guard is now correctly capped at exactly 1.

**Bug found and fixed at the UI layer: the 6th shift was unreachable even after the fix above (item
50).** `maxFeasibleShifts()` (§3.9) had its own hardcoded cap at `MAX_SHIFTS_PER_WEEK`, left over
from before this feature existed. Both steppers compute their selectable max as
`min(maxFeasibleShifts(...), maxRequestableShifts(...))` — since the first argument could never
exceed 5, that `min()` could never reach 6 no matter what the second argument said. Fixed by
removing the internal cap (§3.9); `maxFeasibleShifts()` now returns the true, uncapped physical
result, and the two callers already combined it with the policy ceiling themselves.

**CP-SAT modelling note (P2b, the stretch bonus).** A term that is _minimised_ (like the existing
kamut-gap penalty, P2) is safe with a bare one-sided `>=` against a possibly-negative RHS — CP-SAT
drives it to its own domain floor (0) harmlessly whenever a guard falls short. A term that is
_maximised_ (the stretch bonus) is **not** safe with the naive mirror-image `<=`: the RHS
(`worked - effective_kamut`) goes negative the moment a guard falls short of `effective_kamut` (an
ordinary, expected condition handled separately by P2 itself), and `0 <= negative` is
unsatisfiable — genuine `INFEASIBLE` for input that has every right to solve. First caught by the
golden-fixture suite (fixture 05, clopen-trap, went `INFEASIBLE`). Fixed with an explicit
`AddMaxEquality(overflow, [diff, 0])` floor-at-zero step before the ordinary `sb <= overflow`
cap — both directions now degrade to `sb = 0` instead of failing. The same class of bug resurfaced
when `max_shifts` could reach 6: the `diff`/`overflow` `IntVar` domain bounds were sized off the
flat `MAX_SHIFTS_PER_WEEK` constant, which would have made `diff == worked - effective_kamut`
unsatisfiable the moment a guard's own (now possibly 6) `max_shifts` let `worked` exceed 5 — fixed
by sizing those bounds off each guard's own `max_shifts` instead of the constant.

**Weight (v2.7 P2b `stretch`), measured against live data before shipping**, per this project's
established habit (§9.4, §3.8): tested on the real demo week (`2026-08-09`) by raising specific
guards' `stretch_target` on a frozen snapshot and comparing before/after. Result: **zero effect** on
that particular week — every candidate guard's slack was already rest-blocked (unchanged
`target_gaps` count across all trials), so the mechanism had nothing to grant there. Shipped at the
starting hypothesis of **1** (lowest weight in the model, same tier as `pref`) since the isolated
fixture (11-stretch-bonus.json) independently proves the grant side works when slack genuinely
exists; the live measurement's contribution was confirming **zero harm** on real data, not
confirming a grant.

**Auto-follow stepper (item 51).** Until a guard manually touches the stepper at least once, its
value auto-follows `min(configuredKamut, feasible)` live as boxes are checked and unchecked —
bidirectional, not just a downward clamp, so marking more days later raises the default back up
too. The first manual nudge marks it "touched," and from then on the guard's own choice is
respected, only ever pulled down if it becomes infeasible. A guard editing an existing submission
that already has a stored request is treated as already touched, so a prior explicit choice is
never silently overridden by the auto-default.

**Manager visibility and editing (item 52).** `TeamTable.tsx` shows a `מבוקש · N` badge per guard
next to the existing עדיפות badge. `GuardPreferenceEditor` (§12.7) exposes the identical stepper,
bounded live against whatever the manager currently has toggled in that same editing session, not
the guard's original submission.

### 3.11 Submission Confirmation (v2.6)

Before a preference submission actually sends — from the guard-facing form, and from the manager's
edit-on-behalf-of window (§12.7) — a modal appears summarising exactly what is about to be sent (the
marked slots, day by day; the requested-shifts count when it differs from configured, §3.10; the
notes text, §3.6) and requires an explicit confirm. Nothing is written until that confirmation.
Added because tapping "שלח" previously sent immediately with no chance to review — a guard (or a
manager entering something on a guard's behalf, further from the source data) had no checkpoint
between "I think I'm done" and the write actually landing.

---

## 4. WEIGHTED MULTI-OBJECTIVE MODEL

The solver maximises a single weighted score. All coverage and volume goals are soft; only safety and physics rules are hard.

### 4.1 Hard Constraints (never violated)

| #   | Constraint                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | Availability — guard assignable only to slots they marked                                                                                                                                                                       |
| H2  | 12h eligibility — `day12`/`night12` require the matching opt-in                                                                                                                                                                 |
| H3  | At most **one** shift per guard per calendar day                                                                                                                                                                                |
| H4  | At most `max_shifts` shifts per guard per week — a **per-guard** ceiling (v2.7, §3.10), ordinarily **5**, tightened for an explicit lower request or raised to **6** for a guard configured at 5 who explicitly requested a 6th |
| H5  | Minimum **8 hours** rest between consecutive shifts (⛔ cells in §2.6)                                                                                                                                                          |
| H6  | Segment coverage never **exceeds** its target ceiling                                                                                                                                                                           |
| H7  | Carry-in rest from the previous Saturday                                                                                                                                                                                        |

### 4.2 Soft Objective Terms

| Priority   | Term                                                                                                                                | Weight                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **P1**     | Each guard-slot below a segment's **critical floor**                                                                                | **−1000** × `segmentPenaltyWeight(seg)`                              |
| **P2**     | Each shift a guard falls short of `effective_kamut`                                                                                 | **−100**                                                             |
| **P3**     | Each unfilled **target** slot above the floor                                                                                       | **−10** × `segmentPenaltyWeight(seg)`                                |
| **P-rest** | Each 8-hour-rest occurrence (⚠️ cells in §2.6)                                                                                      | **−5**                                                               |
| **P4**     | Each assignment matching a declared preference (availability is hard, so this is every assignment)                                  | **+1**                                                               |
| **P4b**    | Each assignment matching a slot marked **עדיפות** (strength 2, §3.8)                                                                | **+2**, additive on top of P4                                        |
| **P2b**    | Each shift beyond `effective_kamut`, up to a guard's own `stretch_target` (v2.7, §3.10) — the requested-shift-count analogue of P4b | **+1**, starting hypothesis, measured zero-harm on live data (§3.10) |

```
maximise   Σ pref_weight·x  +  preferred_weight·Σ preferred_x  +  stretch_weight·Σ stretch_bonus
         − 1000·Σ segmentPenaltyWeight(seg)·floor_gap
         −  100·Σ kamut_gap
         −   10·Σ segmentPenaltyWeight(seg)·target_gap
         −    5·Σ rest_violation
```

`segmentPenaltyWeight(seg)` (§4.2b, v2.8) is `segmentWeight(seg)` (§4.2a below) plus a flat bonus
added for S1 only. Everywhere the P1/P3 tiers appear, this is the function actually used — see §4.2b
for what it adds on top of the plain length-based `segmentWeight()`.

### 4.2a Segment-Length Weighting (v2.4)

`floor_gap` and `target_gap` are per-segment, but the four segments are not equal length (§2.3): S1
and S4 are 8h, S2 and S3 are 4h. A flat per-slot count cannot tell an 8-guard-hour hole from a
4-guard-hour one, so the solver was found to be genuinely indifferent between them — the same real
week, solved twice at identical weights, landed on two different Saturday layouts with an identical
score. `segmentWeight(seg)` (`src/lib/shifts.ts`, mirrored as `segment_weight()` in
`solver/models.py`) is `SEGMENT_DEFS[seg].hours / 4` — 2 for S1/S4, 1 for S2/S3 — multiplied into
every floor/target gap term in both engines and both referees. This scales _within_ the P1/P3
tiers, not a new tier: a worst-case target-gap unit becomes 2×10=20, still far below P2's 100.
Verified on live data: before, repeated identical generations varied which segment was left short;
after, they consistently pick the cheaper (4h) one when the trade-off is otherwise tied.

> **Note on P4/P4b:** because availability is hard (H1), every assignment matches a preference, so
> P4 alone reduces to "+1 per shift worked" — dominated by P1–P3, a gentle tie-breaker toward using
> willing guards. P4b (§3.8) adds real discriminating power on top of that for a guard's specific
> עדיפות-marked slots, at a weight (2) measured against live data rather than assumed — see §3.8 for
> the trade-off that ruled out a larger value.

### 4.2b Morning-Priority Weighting (`WEIGHTS.morning_priority`, v2.8)

Per Ben, the manager's actual preference when a coverage trade-off is unavoidable is a fully-staffed
**morning** over a _balanced_ morning/night — e.g. one guard alone at night rather than splitting a
guard who is flexible between the two evenly across both. §4.2a's `segmentWeight()` already makes S1
and S4 both cost 2× an S2/S3 gap from length alone, but that leaves S1 and S4 tied with each other —
nothing in the objective preferred one over the other.

`segmentPenaltyWeight(seg, morningPriorityBonus)` (`src/lib/shifts.ts`, mirrored as
`segment_penalty_weight()` in `solver/models.py`) adds a flat bonus to `segmentWeight('S1')` only,
used in place of the bare `segmentWeight()` in every P1/P3 term (§4.2, both engines and both
referees). **Additive, not a multiplier** — unlike a ratio, an integer bonus needs no rounding step
to stay CP-SAT-safe (CP-SAT's coefficients must be integers), and it matches how every other weight
in this model already works. `WEIGHTS.morning_priority` is the bonus value: shipped at **1** (S1's
floor/target gap costs 3 where S4 still costs 2), a starting hypothesis not yet measured against live
data at the time of writing — see the weight-tuning discipline in §3.8/§4.2a before raising it.

Because this lives entirely inside the P1 (×1000) / P3 (×10) tiers, it structurally outranks P4/P4b
(±1/±2) by construction: a guard's own עדיפות mark can only ever break a tie _after_ the coverage
tiers have already decided, so it is never overridden by this weighting, without needing any explicit
conditional logic to enforce that.

The solver contract's `weights.morning_priority` (§9.2) defaults to **0** (neutral — identical to
pre-v2.8 behaviour), _not_ the shipped production value: this adds to a term present in almost every
fixture, including ones predating this field whose expected behaviour assumes segments are otherwise
symmetric (e.g. fixture 10's preference tie-break, §14.2). A non-zero default would silently change
what they test. Real generation always sends the full `WEIGHTS` object explicitly, so the zero
default is only ever reached by an old fixture or caller that omits the field.

---

## 5. GOOGLE OR-TOOLS CP-SAT — PRIMER

OR-Tools is a free, Apache-2.0 optimisation library from Google (`pip install ortools`). CP-SAT is its constraint-programming solver.

Rather than writing an algorithm that _builds_ a schedule, you **declare** the problem:

1. **Variables** — one boolean per possibility: `x[guard, day, shift]`. For 8 guards × 7 days × 5 shifts = 280 booleans.
2. **Constraints** — rules in near-English: `sum(x[g, mon, night] for g) <= 2`, or `x[g, mon, night] + x[g, tue, morning] <= 1`.
3. **Objective** — the weighted score from §4.2.

CP-SAT then searches with clause learning across parallel workers and returns a **provably optimal** assignment. At this problem size it returns in well under one second.

Its one sharp edge: a contradictory _hard_ constraint yields `INFEASIBLE` with no explanation — a terrible experience for a manager on a Wednesday evening. This specification therefore keeps the hard set minimal (§4.1) and makes every business goal soft, guaranteeing the solver always returns a schedule plus a readable coverage report.

---

## 6. DATABASE SCHEMA (SUPABASE / POSTGRESQL)

### 6.1 Types

```sql
-- 'afternoon_early'/'afternoon_late' added by migration 53 (v2.24.0, §12.13) --
-- manual-edit only, never produced by either engine; see §2.2.
CREATE TYPE shift_type  AS ENUM ('morning', 'afternoon', 'night', 'day12', 'night12',
                                  'afternoon_early', 'afternoon_late');
CREATE TYPE base_shift  AS ENUM ('morning', 'afternoon', 'night');
CREATE TYPE user_role   AS ENUM ('admin', 'manager', 'guard');
CREATE TYPE week_status AS ENUM ('open', 'locked', 'generated', 'published');
```

### 6.2 Tables

```sql
-- 1. Pre-seeded badge codes (exists BEFORE an auth user does, so first login can claim it).
--    Written only by the service role via Edge Function. Never exposed to the anon key.
CREATE TABLE roster_codes (
  employee_code TEXT PRIMARY KEY CHECK (employee_code ~ '^[0-9]{6}$'),
  display_name  TEXT NOT NULL,
  initial_role  user_role NOT NULL DEFAULT 'guard',
  claim_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_claimed    BOOLEAN NOT NULL DEFAULT FALSE,
  claimed_at    TIMESTAMPTZ,
  -- v2.8 migration 34: true for a seeded mock/demo guard. Source of truth for
  -- the admin real/test view-mode toggle (§12.8) -- not inferred from
  -- display_name's "- דמה" suffix (§1.4 item 25).
  is_demo       BOOLEAN NOT NULL DEFAULT FALSE
);

-- 2. Guard / manager profiles
CREATE TABLE profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  employee_code TEXT NOT NULL UNIQUE CHECK (employee_code ~ '^[0-9]{6}$'),
  display_name  TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'guard',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- v2.8 migration 34: same flag as roster_codes.is_demo, carried across
  -- claiming by trg_profiles_is_demo the same way default_kamut already is.
  is_demo       BOOLEAN NOT NULL DEFAULT FALSE
);

-- 3. Per-week manager controls
CREATE TABLE roster_weeks (
  week_start           DATE PRIMARY KEY CHECK (EXTRACT(DOW FROM week_start) = 0), -- Sunday
  morning_target_slots INT NOT NULL DEFAULT 2 CHECK (morning_target_slots IN (2, 3)),
  submission_deadline  TIMESTAMPTZ NOT NULL,
  status               week_status NOT NULL DEFAULT 'open',
  -- v2.2: set when a manager changes status by hand. ensure_roster_weeks()
  -- skips such weeks permanently, so automation cannot revert a human decision.
  status_overridden_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. One row per guard per week: proves submission occurred + holds the 12h opt-ins.
--    Opt-ins live here (not per-slot) so they cannot self-contradict.
CREATE TABLE weekly_submissions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  week_start       DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  submitted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- v2.0 §3.6, migration 17: free-text context, never read by the solver.
  notes            TEXT CHECK (char_length(notes) <= 500),
  -- v2.7 §3.10, migration 33: nullable, NULL means "defer entirely to
  -- configured" -- normalised there the same way an all-whitespace note is.
  -- Allows up to 6 (not just 5) so the CHECK doesn't need widening for the
  -- 6th-shift case (§3.10 item 49); nothing writes 6 unless that case applies.
  requested_shifts SMALLINT CHECK (requested_shifts BETWEEN 0 AND 6),
  UNIQUE (guard_id, week_start)
);
-- v2.1: the 12h flags moved OFF this row onto weekly_wish_preferences, so the
-- opt-in can differ per day. This row now records only THAT a guard answered.

-- 5. Availability. Row present == available. No row == unavailable.
CREATE TABLE weekly_wish_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  week_start  DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  target_date DATE NOT NULL,
  shift       base_shift NOT NULL,
  -- v2.1: extend THIS shift on THIS day to 12h. Lives here rather than on the
  -- submission row so deleting the availability deletes the opt-in with it.
  allows_12h  BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT twelve_h_on_extendable_shift
    CHECK (NOT allows_12h OR shift IN ('morning', 'night')),
  strength    SMALLINT NOT NULL DEFAULT 1 CHECK (strength IN (1, 2)), -- 2 = עדיפות (v2.4, §3.8)
  UNIQUE (guard_id, target_date, shift),
  CHECK (target_date >= week_start AND target_date <= week_start + 6)
);

-- 6. Manager-configured כמות, relational (replaces v1 JSONB blob)
CREATE TABLE weekly_guard_targets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start       DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  guard_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  configured_kamut INT NOT NULL DEFAULT 0 CHECK (configured_kamut BETWEEN 0 AND 5),
  effective_kamut  INT CHECK (effective_kamut BETWEEN 0 AND 5), -- computed at generation
  UNIQUE (week_start, guard_id)
);

-- 6b. Per-day exceptions to a week's own morning_target_slots (§2.4b, v2.8
--     migration 35). Sparse: a day with no row here just follows the week's
--     baseline. Weekdays only -- Sat/Sun stay hard-locked at 2 (§2.4).
CREATE TABLE weekly_morning_target_overrides (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start            DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  day_index             SMALLINT NOT NULL CHECK (day_index BETWEEN 1 AND 5),
  morning_target_slots  SMALLINT NOT NULL CHECK (morning_target_slots IN (2, 3)),
  UNIQUE (week_start, day_index)
);

-- 6c. Per-day exceptions to the flat-2 baseline for S2/S3/S4 (§2.4c, v2.10
--     migration 37). One generic table for all three segments (not three
--     near-duplicates of 6b) since they share an identical shape. Unlike 6b:
--     all 7 days are overridable (no weekend lock -- these segments never had
--     one), and the value only ever lowers to 1 (no raised "3" tier).
CREATE TABLE weekly_segment_target_overrides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start    DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  day_index     SMALLINT NOT NULL CHECK (day_index BETWEEN 0 AND 6),
  segment       TEXT NOT NULL CHECK (segment IN ('S2', 'S3', 'S4')),
  target_slots  SMALLINT NOT NULL CHECK (target_slots IN (1, 2)),
  UNIQUE (week_start, day_index, segment)
);

-- 7. One row per solver execution; holds the coverage report and publication state
CREATE TABLE schedule_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start      DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  version         INT NOT NULL,
  solver_status   TEXT NOT NULL,   -- OPTIMAL | FEASIBLE | INFEASIBLE | MOCK
  objective_value INT,
  coverage_report JSONB NOT NULL DEFAULT '{}'::jsonb, -- floor breaches, unmet כמות, gaps
  is_published    BOOLEAN NOT NULL DEFAULT FALSE,
  generated_by    UUID REFERENCES profiles(id),
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (week_start, version)
);

-- At most one published roster per week
CREATE UNIQUE INDEX one_published_run_per_week
  ON schedule_runs (week_start) WHERE is_published;

-- 8. The assignments themselves.
CREATE TABLE schedule_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES schedule_runs(id) ON DELETE CASCADE,
  target_date DATE NOT NULL,
  shift       shift_type NOT NULL,
  -- v2.11 §12.9, migration 39: NULL means this row is a PLACEHOLDER -- a
  -- note-only cell annotation with no real guard behind it. Never produced
  -- by the solver; manual edits only. Both UNIQUE constraints below already
  -- treat NULL as distinct from any other value, so any number of
  -- placeholders can share a run/day/shift with no collision.
  guard_id    UUID REFERENCES profiles(id) ON DELETE CASCADE,
  -- v2.11 §12.9, migration 38: manager-written, solver-blind free text
  -- rendered before/after the guard's name on this one cell. Nullable,
  -- capped short (40 chars) -- these render in a chip, not a paragraph field.
  note_before TEXT CHECK (char_length(note_before) <= 40),
  note_after  TEXT CHECK (char_length(note_after)  <= 40),
  -- v2.11 §12.9, migration 39: a placeholder with no text at all is just a
  -- blank row with no purpose.
  CONSTRAINT placeholder_needs_a_note
    CHECK (guard_id IS NOT NULL OR note_before IS NOT NULL OR note_after IS NOT NULL),
  -- v2.23.0 §12.9, migration 52: TRUE makes a placeholder count toward
  -- coverage like a real assignment, while still carrying no guard identity.
  -- Meaningless (and refused) on a real row -- one already occupies its own
  -- slot. Defaults FALSE, so every pre-migration placeholder is unaffected.
  occupies_slot BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT occupies_slot_only_on_placeholder
    CHECK (occupies_slot = FALSE OR guard_id IS NULL),
  UNIQUE (run_id, target_date, shift, guard_id)
);

CREATE INDEX idx_prefs_week        ON weekly_wish_preferences (week_start, guard_id);
CREATE INDEX idx_assign_run        ON schedule_assignments (run_id, target_date);
CREATE INDEX idx_runs_week_pub     ON schedule_runs (week_start, is_published);

-- 9. Push notifications (§12.10, migrations 40-42). One row per browser/device.
CREATE TABLE push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. Audit trail AND idempotency ledger for every send attempt.
CREATE TABLE notification_log (
  id                 BIGSERIAL PRIMARY KEY,
  notification_type  TEXT NOT NULL CHECK (notification_type IN ('broadcast','reminder_24h','reminder_2h')),
  week_start         DATE REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  guard_id           UUID REFERENCES profiles(id) ON DELETE CASCADE, -- NULL = whole-run skip
  status             TEXT NOT NULL CHECK (status IN
                        ('sent','skipped_already_sent','skipped_out_of_window',
                         'skipped_no_subscription','skipped_no_open_week','failed')),
  detail             TEXT,
  intended_at        TIMESTAMPTZ,
  sent_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX notification_log_sent_once
  ON notification_log (notification_type, week_start, guard_id) WHERE status = 'sent';

-- 11. Singleton config: the send-notifications URL + shared secret
-- notification_tick() calls. RLS enabled, ZERO policies -- unreachable via
-- PostgREST by any role; filled in with a plain UPDATE after migrating.
CREATE TABLE notification_secrets (
  id          BOOLEAN NOT NULL PRIMARY KEY DEFAULT TRUE CHECK (id),
  notify_url  TEXT,
  cron_secret TEXT
);

-- 12. App-scoped WebAuthn credentials (§8, §12.11, migration 46). One row per
-- registered device; guard-owned (read/rename/delete their own row), but NO
-- insert grant to `authenticated` at all -- only the webauthn Edge
-- Function's service-role client may ever create one, after a verified
-- ceremony, never forged directly by a guard's own client.
CREATE TABLE webauthn_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key    BYTEA NOT NULL,
  counter       BIGINT NOT NULL DEFAULT 0,
  device_type   TEXT,
  backed_up     BOOLEAN NOT NULL DEFAULT FALSE,
  transports    TEXT[],
  friendly_name TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

-- 13. Short-lived nonces for the two-step register/authenticate ceremony.
-- Sealed like notification_secrets -- RLS enabled, ZERO policies, no grants
-- to authenticated/anon at all. Consumed (deleted) the moment they're used.
CREATE TABLE webauthn_challenges (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('register', 'auth')),
  challenge  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
```

---

## 7. ROW-LEVEL SECURITY

### 7.1 Helper Functions

> `SECURITY DEFINER` is essential. In v1 the manager policies queried `profiles` from inside a policy; that subquery was itself subject to `profiles`' RLS, returned zero rows, and silently blocked managers from ever writing. These helpers bypass RLS safely with a pinned `search_path`.

```sql
CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role IN ('manager', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.is_week_open(p_week_start DATE)
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT status = 'open' AND NOW() < submission_deadline
     FROM roster_weeks WHERE week_start = p_week_start),
    FALSE);
$$;
```

**Other helpers** (full definitions live in `supabase/migrations/`, which is the source of truth —
the snippets here are illustrative and can drift):

| Function                                                                     | Purpose                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `current_week_start()`                                                       | The Sunday starting the week containing today, in Asia/Jerusalem. Calendar-only, never configurable — RLS's archive cutoff (§12.2) and `guard_visible_from()` (migration 16) key off this, not the admin cursor below                                              |
| `admin_current_week_start()`                                                 | The manager-facing current/next cursor (migration 26): advances at each week's own configured submission open-time instead of real midnight (§12.1). Used only by `ensure_roster_weeks()` and the manager dashboard's week picker — never by anything guard-facing |
| `deadline_for_week(d)`                                                       | Wednesday 19:00, `week_start − 4`                                                                                                                                                                                                                                  |
| `opens_for_week(d)`                                                          | Saturday 20:00, `week_start − 8`                                                                                                                                                                                                                                   |
| `ensure_roster_weeks()`                                                      | Idempotent lifecycle: creates and opens/locks the current week and the next (§12.1)                                                                                                                                                                                |
| `set_week_status(d, s, h)`                                                   | Manager override; extends or clears the deadline and stamps `status_overridden_at` (§12.3)                                                                                                                                                                         |
| `save_week_preferences(d, jsonb, notes, requested_shifts)`                   | Atomic replace of the **caller's own** week (`auth.uid()`); `SECURITY INVOKER`, so RLS still applies. Trailing `p_notes`/`p_requested_shifts` are optional (§3.6, §3.10)                                                                                           |
| `manager_save_week_preferences(guard_id, d, jsonb, notes, requested_shifts)` | The manager-authority twin (migration 32, §12.7) — identical shape but keyed on an explicit `p_guard_id`, gated on `is_manager()` only (not `is_week_open()`)                                                                                                      |
| `delete_week_submission(d)`                                                  | Cancels the **caller's own** submission outright — back to "not submitted," not an edit to empty (§3.7)                                                                                                                                                            |
| `manager_delete_week_submission(guard_id, d)`                                | The manager-authority twin (§12.7), keyed on an explicit `p_guard_id`                                                                                                                                                                                              |
| `carry_in_shifts(d)`                                                         | Previous Saturday's published shifts, for cross-week rest (§2.8)                                                                                                                                                                                                   |
| `next_run_version(d)`                                                        | Next draft version number for a week                                                                                                                                                                                                                               |
| `claim_rate_ok` / `record_claim_attempt`                                     | Badge-claim throttling (§8)                                                                                                                                                                                                                                        |

### 7.2 Policies

```sql
ALTER TABLE roster_codes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_weeks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_submissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_wish_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_guard_targets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_assignments    ENABLE ROW LEVEL SECURITY;

-- roster_codes: no policy for `authenticated` at all => deny-all.
-- Only the service role (Edge Function) may read/write it.
CREATE POLICY codes_manager_read ON roster_codes
  FOR SELECT TO authenticated USING (is_manager());

-- profiles: everyone reads the roster (names are needed to render the grid).
CREATE POLICY profiles_read ON profiles
  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY profiles_self_update ON profiles
  FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY profiles_manager_write ON profiles
  FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

-- Block privilege escalation at the column level: a guard may edit their own
-- display name but never their own role or active flag.
CREATE OR REPLACE FUNCTION public.guard_profile_columns()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_manager() THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.employee_code IS DISTINCT FROM OLD.employee_code THEN
      RAISE EXCEPTION 'insufficient privilege: protected profile column';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_guard_profile_columns
  BEFORE UPDATE ON profiles FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_columns();

-- roster_weeks: readable by all, writable by managers
CREATE POLICY weeks_read ON roster_weeks
  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY weeks_manager_write ON roster_weeks
  FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

-- weekly_submissions: own row, only while the week is open; managers read all
CREATE POLICY subs_read ON weekly_submissions
  FOR SELECT TO authenticated USING (guard_id = auth.uid() OR is_manager());
CREATE POLICY subs_self_write ON weekly_submissions
  FOR ALL TO authenticated
  USING  (guard_id = auth.uid() AND is_week_open(week_start))
  WITH CHECK (guard_id = auth.uid() AND is_week_open(week_start));
CREATE POLICY subs_manager_write ON weekly_submissions
  FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

-- weekly_wish_preferences: identical pattern. Managers MUST be able to read all,
-- otherwise the manager dashboard renders empty (a v1 bug).
CREATE POLICY prefs_read ON weekly_wish_preferences
  FOR SELECT TO authenticated USING (guard_id = auth.uid() OR is_manager());
CREATE POLICY prefs_self_write ON weekly_wish_preferences
  FOR ALL TO authenticated
  USING  (guard_id = auth.uid() AND is_week_open(week_start))
  WITH CHECK (guard_id = auth.uid() AND is_week_open(week_start));
CREATE POLICY prefs_manager_write ON weekly_wish_preferences
  FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

-- weekly_guard_targets: guards read only their own כמות; managers write.
CREATE POLICY targets_read ON weekly_guard_targets
  FOR SELECT TO authenticated USING (guard_id = auth.uid() OR is_manager());
CREATE POLICY targets_manager_write ON weekly_guard_targets
  FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

-- schedule_runs: guards see a published run only for the CURRENT or a future
-- week. Past weeks are manager-only (§12.2) and the cut is absolute.
CREATE POLICY runs_read ON schedule_runs
  FOR SELECT TO authenticated
  USING (is_manager() OR (is_published AND week_start >= current_week_start()));
CREATE POLICY runs_manager_write ON schedule_runs
  FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

-- schedule_assignments: visibility inherited from the parent run.
CREATE POLICY assign_read ON schedule_assignments
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM schedule_runs r
            WHERE r.id = schedule_assignments.run_id
              AND (is_manager()
                   OR (r.is_published AND r.week_start >= current_week_start())))
  );
CREATE POLICY assign_manager_write ON schedule_assignments
  FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());
```

### 7.3 Security Notes

- The **anon key is public by design**; all protection rests on the policies above. The **service-role key must never** be shipped to the browser or set as a `VITE_*` variable — it lives only in Edge Function / Render secrets.
- Every write policy carries an explicit `WITH CHECK`. Relying on `FOR ALL` implicitly reusing `USING` is legal but fragile.
- `roster_codes` has **no** `authenticated` write policy, so unclaimed badge codes cannot be enumerated or hijacked through PostgREST.
- **Residual risk:** a colleague who reads a badge over someone's shoulder could claim that code before its owner does. Mitigation: the manager controls `claim_enabled`, sees claim status per code, and can reset a claim.

---

## 8. AUTHENTICATION FLOW

Login is by **6-digit badge code + personal PIN**. The code is stored as `TEXT` so leading zeros (e.g. `005396`) survive.

Supabase GoTrue has no native code-login, so a synthetic identity is used internally: `<employee_code>@guards.local`. The guard never sees or types an email.

**First login (claim):**

1. Guard enters their 6-digit code.
2. Frontend calls the `claim-code` Edge Function.
3. The function (service role) verifies the code exists in `roster_codes`, is `claim_enabled`, and is not yet claimed.
4. Guard is prompted to choose a personal PIN/password.
5. The function creates the `auth.users` record + `profiles` row, and marks the code claimed.

**Subsequent logins:** `signInWithPassword({ email: '<code>@guards.local', password: pin })`.

**Abuse controls:** the `claim-code` function rate-limits by IP and by code; repeated failures disable the code and notify the manager.

**Passkey (Face ID / fingerprint) login (v2.16–2.18, §12.11)** — optional, additive, never a
lockout: badge code + PIN always keeps working regardless. From an already-authenticated session, a
guard can register an app-scoped WebAuthn credential (`residentKey: 'discouraged'` — explicitly
**not** a synced OS passkey) via the `webauthn` Edge Function. On a device with one registered, the
Login page's passkey button runs the real sign-in ceremony directly; on a device with none, the same
button falls through to an ordinary badge-code + PIN login and the ceremony starts automatically
right after. A device with a credential re-verifies on every fresh app load unless a real biometric
check succeeded within the last 24 hours (§12.11's grace-window design). Full technical account —
the pivot from Supabase's native Passkey API, the RP-ID allowlist, and how a successful ceremony
mints a real session with no password involved — lives in §12.11, not repeated here.

---

## 9. SOLVER SERVICE

### 9.1 Hosting

Supabase Edge Functions run Deno and **cannot execute Python or OR-Tools**. The solver is a small **FastAPI** service on **Render** (or Railway) free tier.

```
[React / Vercel]
      │  1. manager clicks "צור סידור"
      │  2. reads guards/prefs/targets/carry-in   (manager RLS)
      │  3. computes effective_kamut              (§2.7)
      │  4. builds SolverInput
      ▼
[Supabase Edge Function: generate-schedule]   ← holds SOLVER_SECRET
      │  5. re-checks the caller is a manager, server-side, using their own JWT
      │  6. forwards SolverInput  ─────────────► [Render: FastAPI + CP-SAT]
      ▼                                       ◄── SolverOutput
[React / Vercel]
      │  7. verifySchedule() re-derives the report and REFUSES an illegal roster
      │  8. writes schedule_runs + assignments   (manager RLS)
      ▼
[Supabase Postgres]
```

**The Edge Function is deliberately thin.** It does only the two things the browser cannot: hold
`SOLVER_SECRET`, and re-check the caller's role server-side. It does _not_ gather data, compute
`effective_kamut`, verify the result or write the roster — that would mean a third Deno copy of
rules that already exist twice (TypeScript and Python), and the twin-referee design depends on
there being exactly two implementations held in step by shared fixtures. Every write the client
makes afterwards is still governed by RLS, which does not trust the client's claim about its role.

**Fallback.** If the solver is unreachable — Render's free tier sleeps after 15 minutes idle, with
roughly a 50-second cold start — the app falls back to the in-browser mock rather than failing. The
mock is always _legal_ (every hard rule is checked before each assignment) but not optimal; see
§9.4.

**Nothing is stored on the solver's word.** The assignments come back, `verifySchedule()` recomputes
the coverage report and objective from scratch, and a roster that breaks a hard rule is refused
rather than saved.

### 9.2 Solver Contract

```jsonc
// SolverInput
{
  "week_start": "2026-08-09",
  "morning_target_slots": 2,
  "morning_target_overrides": { "4": 3, "5": 3 },  // v2.8 §2.4b: sparse day_index -> target for THIS week only, default {}
  "secondary_target_overrides": { "S3": { "2": 1 }, "S4": { "3": 1 } },  // v2.10 §2.4c: sparse segment -> day_index -> target, default {} per segment
  "guards": [
    { "id": "uuid", "effective_kamut": 3,
      "stretch_target": 3,   // v2.7 §3.10: rewarded (never penalised) ceiling above effective_kamut, default 0
      "max_shifts": 5,       // v2.7 §3.10: this guard's actual hard weekly ceiling (H4), default 5
      "availability": { "0": ["morning"], "1": ["morning","night"] },  // day index → base shifts
      "preferred":    { "1": ["night"] },   // day index → base shifts marked עדיפות (strength 2, §3.8)
      "twelve_hour_day":   [1, 2],   // day indices where day12 is allowed
      "twelve_hour_night": [1]       // day indices where night12 is allowed
    }
  ],
  "carry_in": { "uuid": "night" },   // previous Saturday's shift, or null
  "weights": { "floor": 1000, "kamut": 100, "target": 10, "rest8": 5, "pref": 1, "preferred": 2, "stretch": 1,
                "morning_priority": 0 }  // v2.8 §4.2b: flat S1-only bonus, default 0 (neutral) -- shipped WEIGHTS sends 1
}

// SolverOutput
{
  "status": "OPTIMAL",
  "objective_value": 128,
  "assignments": [ { "day": 0, "date": "2026-08-09", "shift": "morning", "guard_id": "uuid" } ],
  "coverage_report": {
    "floor_breaches":  [ { "day": 3, "segment": "S4", "required": 1, "assigned": 0 } ],
    "target_gaps":     [ { "day": 0, "segment": "S1", "target": 2, "assigned": 1 } ],
    "unmet_kamut":     [ { "guard_id": "uuid", "effective_kamut": 3, "assigned": 2 } ],
    "rest_violations": [ { "guard_id": "uuid", "day": 2, "from": "night", "to": "afternoon", "hours": 8 } ],
    "kamut_overrides": [ { "guard_id": "uuid", "configured": 4, "available_days": 2, "effective": 2 } ]
  }
}
```

### 9.3 CP-SAT Model (reference implementation)

```python
from ortools.sat.python import cp_model

SHIFTS   = ['morning', 'afternoon', 'night', 'day12', 'night12']
SEGMENTS = ['S1', 'S2', 'S3', 'S4']

# Which segments each shift covers (§2.3)
COVERS = {
    'morning':   ['S1'],
    'afternoon': ['S2', 'S3'],
    'night':     ['S4'],
    'day12':     ['S1', 'S2'],
    'night12':   ['S3', 'S4'],
}

# Rest hours from a shift on day d to a shift on day d+1 (§2.6)
END   = {'morning': 14.75, 'afternoon': 22.75, 'day12': 18.75, 'night': 30.75, 'night12': 30.75}
START = {'morning': 30.75, 'day12': 30.75, 'afternoon': 38.75, 'night12': 42.75, 'night': 46.75}
def rest(prev, nxt):
    return START[nxt] - END[prev]

# <8h impossible · exactly 8h penalised · >=12h free  (§2.6)
HARD_REST, FREE_REST = 8.0, 12.0


def generate_schedule(inp):
    W  = inp['weights']
    G  = inp['guards']
    md = inp['morning_target_slots']
    m  = cp_model.CpModel()

    target = {'S1': md, 'S2': 2, 'S3': 2, 'S4': 2}
    floor  = {'S1': 2 if md == 3 else 1, 'S2': 1, 'S3': 1, 'S4': 1}

    # --- Variables, gated by H1 (availability) and H2 (12h eligibility) ---
    x = {}
    for gi, g in enumerate(G):
        for d in range(7):
            avail = set(g['availability'].get(str(d), []))
            for s in SHIFTS:
                # v2.1: the 12h opt-in is per DAY, so the day index must be in
                # the guard's opted-in list -- not merely a week-level flag.
                ok = ((s in ('morning', 'afternoon', 'night') and s in avail)
                      or (s == 'day12'   and 'morning' in avail and d in g['twelve_hour_day'])
                      or (s == 'night12' and 'night'   in avail and d in g['twelve_hour_night']))
                x[gi, d, s] = m.NewBoolVar(f'x{gi}_{d}_{s}') if ok else m.NewConstant(0)

    # --- H3: one shift per day ---
    for gi in range(len(G)):
        for d in range(7):
            m.Add(sum(x[gi, d, s] for s in SHIFTS) <= 1)

    # --- H4: 5-shift weekly ceiling ---
    for gi in range(len(G)):
        m.Add(sum(x[gi, d, s] for d in range(7) for s in SHIFTS) <= 5)

    # --- H5 hard rest + soft 16h preference ---
    rest_penalties = []
    for gi, g in enumerate(G):
        for d in range(6):
            for p in SHIFTS:
                for n in SHIFTS:
                    r = rest(p, n)
                    if r < HARD_REST:                      # ⛔ includes No-Clopen
                        m.Add(x[gi, d, p] + x[gi, d + 1, n] <= 1)
                    elif r < FREE_REST:                    # ⚠️ exactly 8h — allowed, penalised
                        v = m.NewBoolVar(f'r{gi}_{d}_{p}_{n}')
                        m.Add(v >= x[gi, d, p] + x[gi, d + 1, n] - 1)
                        rest_penalties.append(v)

        # --- H7: carry-in from the previous Saturday ---
        prev = inp['carry_in'].get(g['id'])
        if prev:
            for n in SHIFTS:
                r = rest(prev, n)
                if r < HARD_REST:
                    m.Add(x[gi, 0, n] == 0)
                elif r < FREE_REST:
                    rest_penalties.append(x[gi, 0, n])

    # --- H6 ceiling + P1/P3 soft coverage ---
    floor_gaps, target_gaps = [], []
    for d in range(7):
        for seg in SEGMENTS:
            cov = sum(x[gi, d, s] for gi in range(len(G)) for s in SHIFTS if seg in COVERS[s])
            m.Add(cov <= target[seg])                      # H6: never over-staff

            fg = m.NewIntVar(0, floor[seg], f'fg{d}_{seg}')
            m.Add(fg >= floor[seg] - cov)
            floor_gaps.append(fg)

            tg = m.NewIntVar(0, target[seg], f'tg{d}_{seg}')
            m.Add(tg >= target[seg] - cov)
            target_gaps.append(tg)

    # --- P2: כמות shortfall (already auto-overridden, §2.7) ---
    kamut_gaps = []
    for gi, g in enumerate(G):
        worked = sum(x[gi, d, s] for d in range(7) for s in SHIFTS)
        kg = m.NewIntVar(0, 5, f'kg{gi}')
        m.Add(kg >= g['effective_kamut'] - worked)
        kamut_gaps.append(kg)

    # --- P4: preference weight (single-level for the POC: +1 per matched assignment) ---
    pref_terms = [x[gi, d, s]
                  for gi in range(len(G)) for d in range(7) for s in SHIFTS]

    m.Maximize(
        W['pref']     * sum(pref_terms)
        - W['floor']  * sum(floor_gaps)
        - W['kamut']  * sum(kamut_gaps)
        - W['target'] * sum(target_gaps)
        - W['rest8']  * sum(rest_penalties)
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 20.0
    solver.parameters.num_search_workers = 8
    status = solver.Solve(m)
    # ... marshal assignments + coverage_report per §9.2 ...
```

> This snippet predates v2.4 and is illustrative only, per this doc's own convention (§7.1) —
> `solver/scheduler.py` is the source of truth. As of v2.4 it additionally: scales `floor_gaps` and
> `target_gaps` by `segment_weight(seg)` before summing (§4.2a) rather than summing the bare
> `IntVar`s shown above, and adds a `w.preferred * sum(preferred_terms)` term to `model.Maximize`
> (§3.8, P4b) alongside the `w.pref` term. As of v2.7 (§3.10): H4 (`m.Add(sum(...) <= 5)` above) is
> per-guard (`<= g.max_shifts`), and a P2b stretch-bonus term is added to `model.Maximize` — modelled
> with an explicit `AddMaxEquality(overflow, [diff, 0])` floor-at-zero step before the bonus
> variable's own `<=` cap (both `diff`'s and `overflow`'s domain sized off each guard's own
> `max_shifts`, not the flat constant), not the naive mirror of the kamut-gap idiom — see §3.10 for
> why the naive version goes `INFEASIBLE`.

### 9.4 Mock versus CP-SAT — measured, not assumed

Both engines are held to the same referee over the same fixtures, so their outputs are directly
comparable. On the first real week of team availability (8 guards, morning target 2):

|                               | mock (greedy) | CP-SAT  |
| ----------------------------- | ------------- | ------- |
| Assignments                   | 29            | **33**  |
| Floor breaches (empty shifts) | **2**         | **0**   |
| Guards short of כמות          | 1             | **0**   |
| Target gaps                   | 7             | **5**   |
| Objective                     | −2266         | **−37** |

The mock is a hill-climber: it takes the best single move available and stops when nothing improves
the score, so it cannot back out of a good-looking early choice that blocks a later one. It got
_worse_ when the input improved, because more 12h options give a greedy algorithm more ways to go
wrong.

**The mock is a fallback, not the product.** Rosters judged during development should come from
CP-SAT, or the model will be tuned against an engine that will not ship.

The five remaining target gaps on that dataset were genuine capacity: five of the eight guards sat
at the 5-shift ceiling. No solver can fix that — only more people, a higher cap, or more 12h uptake.

---

## 10. FRONTEND STACK

| Concern       | Choice                                                                                                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework     | React 18 + Vite + TypeScript                                                                                                                                                                                                                                                                       |
| Styling       | Tailwind CSS, RTL-first (`dir="rtl"`, logical properties)                                                                                                                                                                                                                                          |
| Server state  | TanStack Query (cache, optimistic updates, invalidation)                                                                                                                                                                                                                                           |
| Session state | React Context (auth only)                                                                                                                                                                                                                                                                          |
| Validation    | Zod at every I/O boundary                                                                                                                                                                                                                                                                          |
| Backend SDK   | `@supabase/supabase-js` v2                                                                                                                                                                                                                                                                         |
| Live updates  | Supabase Realtime, both directions — `schedule_runs`/`schedule_assignments`/`roster_weeks` push a publish or edit to guards (`useRosterRealtime`, migration 15); `weekly_submissions`/`weekly_wish_preferences` push a guard's save to the manager (`useManagerSubmissionsRealtime`, migration 18) |

> **Environment variables:** Vite exposes only `VITE_`-prefixed variables. Use `VITE_SUPABASE_URL`
> and `VITE_SUPABASE_PUBLISHABLE_KEY` (Supabase replaced the legacy `anon` JWT with
> `sb_publishable_…`; the client accepts either). The `NEXT_PUBLIC_*` names in v1 of this document
> were a Next.js convention and resolve to `undefined` here.
>
> `VITE_SOLVER_MODE` selects the engine: `mock` runs in the browser, `remote` calls the Edge
> Function. Server-only values — `SUPABASE_ACCESS_TOKEN`, `SOLVER_SECRET`, `SOLVER_URL` — must never
> carry a `VITE_` prefix, which would publish them in the browser bundle.

### 10.0a Dual-Week Roster View (v2.8)

`RosterView.tsx` ("סידור שבועי") used to show one week at a time behind a pill selector, defaulting
to whichever week was current. `useVisibleRosters()` (`src/hooks/useGuardPortal.ts`) already fetched
_every_ published week the caller's RLS allows — in practice the current week plus the next, once
both are published — so showing only one at a time was a rendering choice, not a fetching limit.

**Now every published week renders stacked**, oldest first, each in its own `RosterGrid` card with
its own "המשמרות שלי" (my shifts) section underneath — a guard can have shifts in both weeks at
once, so the summary is per week, not combined. If only one week is published, this degrades to
exactly what showed before; no separate code path needed. Applies identically to guards and the
manager — RLS (`runs_read`, §7.2) already allows a guard to see any published week at or after their
visibility floor, current or future, so no policy change was needed.

`useRosterRealtime` (§10, migration 15) took a single `weekStart` before; it now takes a **list**,
opening one filtered channel per week plus a single shared unfiltered `schedule_assignments` channel
(that table has no `week_start` column to filter on, so it was always watched unfiltered regardless
of how many weeks are on screen). `GuardHome.tsx`'s "הסידור שלי" cards were already rendering one per
published week before this change; only its realtime subscription needed the same generalisation.

### 10.1 Roster Grid Layout

The generated roster is rendered in the **three time blocks the manager's own spreadsheet uses**,
not as the four raw coverage segments:

```
בוקר      ניתאי                 a plain 8h morning
          ים עד 18:45           a day12, working through to 18:45
צהריים    לוק                   a plain 8h afternoon, covers the whole block
          ים / שלי              the 18:45 HANDOVER, stacked in one cell
לילה      שלי מ 18:45           a night12, on since 18:45
```

A `day12` guard therefore appears **twice** — in the morning block and as the first half of the
afternoon handover — because that is what they are actually doing. Segment rows showed the same
facts but in a shape nobody reads a roster in: a morning row and an afternoon row would each look
short by one while the day was fully staffed.

An uncovered half of a handover is labelled with the **window that is empty** (`ריק 14:45-18:45`)
rather than with a 12h suffix, which would imply a shift nobody is working.

**Short-staffed reads the same way empty does.** A morning or night block with _some_ coverage but
fewer guards than its target (segment target, §2.3/2.4 — 2 or 3 for morning depending on the
weekday, always 2 for night) shows a `—` per missing guard alongside whoever IS assigned, the same
convention as an unpaired handover half — shown, not hidden. A block with **nobody** at all still
reads `ריק`, the stronger signal reserved for nobody rather than short. Both `RosterGrid.tsx` and
the export (`exportRoster.ts`, which mirrors it rule for rule) implement this identically.

**Column widths are measured, not chosen.** All seven day columns share one width — ragged columns
read badly — and that width is the widest cell actually in the table, computed in
`src/lib/measureColumns.ts` by measuring the text on a canvas with the same fonts the chips render
in. A handover counts as **twice the longer** of its two names, because both halves are `flex-1`
and split the cell evenly however long the names are; sizing for their sum let a short name donate
space its neighbour could never receive. Measurement is repeated once `document.fonts` settles, or
the columns get sized against the fallback face and clip when Heebo arrives.

### 10.2 Roster Image Export

The manager can export the **selected run** — draft or published — as a JPEG
(`src/lib/exportRoster.ts`, `src/components/manager/RosterExport.tsx`). The team coordinates in a
WhatsApp group, so a picture is how the roster reaches eight phones regardless of what the app does.

**Not published-only, as of v2.20.1** — earlier versions gated the preview/download button to a
published run specifically, on the reasoning below (point 2, kept for the history). Ben's explicit
call: he wants the preview/download available for whichever version he has selected, published or
not, without waiting to publish first. The only remaining published-only gate is
`RosterPublishNotify` (§12.10) — the push announcement to every guard's phone is a materially
different action from a manager previewing or saving a picture for their own use, and stays
published-only. `RosterExport` itself is now ungated except for `!editing` (exporting the version
currently being hand-edited would export a stale picture of what's on screen before the edit is
saved).

Three decisions worth keeping:

1. **The grid is drawn onto a canvas, not screenshotted from the DOM.** A DOM-to-canvas library
   would track the styling for free but has to reimplement a layout engine, and this app is exactly
   the kind that breaks it — Tailwind v4 emits `oklch()`, shift colours are CSS custom properties,
   chips carry rings. Half-rendered output is worse than none, because the manager would not notice
   until the picture was already in the group chat.
2. **(Historical, v2.4–v2.20.0) Published runs only.** A draft is a proposal still being moved
   around; once an image of it is in the chat it is _the roster_ as far as the guards are concerned,
   and no later edit catches up with it. Publishing is when the roster becomes a promise, so it was,
   until v2.20.1, when it became shareable. Superseded above — kept here as the reasoning a future
   change in the other direction should weigh against.
3. **Built for its destination, not a copy of the screen.** 11px text and a sideways-scrolling table
   are unreadable as a chat thumbnail, so the type is larger, nothing scrolls, and the week range,
   legend and handover convention are printed on the image — a picture in a chat arrives with no
   page around it to explain it.

The palette is read from the CSS custom properties at render time, so recolouring a shift in
`index.css` follows through to the export. Output is **JPEG only** — this exists to post into a
WhatsApp group, where a smaller file matters and nothing in a solid-colour chip grid benefits from
PNG's lossless edges. The preview sits behind a **תצוגה מקדימה** button that opens a lightbox rather
than rendering inline: `RosterExport` always sits directly under the on-screen `RosterGrid` it is a
picture of, so an inline preview would put the same grid on screen twice at once, and shrunk to card
width the names are too small to actually check anyway.

### 10.3 Dark Mode (v2.6)

`ThemeContext` (`src/contexts/ThemeContext.tsx`) is **tri-state**, not a light/dark toggle: `'system'
| 'light' | 'dark'`. `'system'` (the default, nothing stored) tracks `prefers-color-scheme` live via
a `matchMedia` listener; picking `'light'` or `'dark'` explicitly stores it (`localStorage`
`wo.theme`) and stops tracking the OS until the user picks `'system'` again. The **resolved** theme
(always concretely `light` or `dark`) is written onto `document.documentElement` as a `.dark` class
— Tailwind v4's `@custom-variant dark (&:where(.dark, .dark *))` keys off that class rather than the
media query directly, specifically so a manual override can win over `prefers-color-scheme`; reading
the class straight off the OS query would make the override impossible to express.

Shift/status colours are CSS custom properties in `index.css` with `.dark` overrides, not a second
Tailwind colour palette — the same single set of class names (`bg-shift-morning`, etc.) resolves to
different actual colours per theme, so no component needs to know which theme is active. The first
dark-mode pass read as **over-saturated** once actually used against a dark background; softened
(less saturated, not desaturated — a deliberate distinction, since desaturating toward grey would
have made the colours harder to tell apart, not just gentler) one colour family at a time: red/green
first, then orange/light-blue/purple, each verified by feel rather than a formula.

**The roster JPEG export (§10.2) is guarded to stay theme-independent** regardless of the exporting
manager's current app theme — the image is read by phones in whatever theme _they_ are in, on
WhatsApp, with no in-app theme context to follow. `exportRoster.ts` temporarily strips the `.dark`
class off `<html>` before reading the CSS custom properties with `getComputedStyle` (so they resolve
to the one canonical light palette regardless of which theme the manager was actually looking at)
and restores it immediately after — the export must never silently vary by which theme the exporting
manager happened to be in.

### 10.4 PWA / Installability (v2.9)

The app can be added to the home screen on Android (Chrome) and iOS (Safari) and launched
standalone, via `public/manifest.webmanifest`, `public/sw.js`, and a full icon set in
`public/icons/`, all wired up from `index.html` and registered from `src/registerServiceWorker.ts`
(called once from `main.tsx`).

**Manual, not `vite-plugin-pwa`.** A build-plugin-generated service worker (Workbox) defaults to
precaching the built JS/CSS/HTML with a cache-first or stale-while-revalidate runtime — machinery
for solving an _offline_ problem this app doesn't have, and a real risk for one that does have a
Realtime-driven, deadline-sensitive data model (submission windows, §2.4a; roster publishes, §12):
a caching layer serving a stale JS bundle or stale deadline after a fresh push to `main` (which
auto-deploys, §11.2) is exactly the failure mode to avoid. Installability itself only requires a
service worker _registered with a fetch handler_, not that it caches anything, so `public/sw.js` is
a minimal, no-op, network-passthrough worker: it stores nothing in Cache Storage and therefore can
never serve anything stale. `registerServiceWorker()` is guarded on `import.meta.env.PROD`, so
`npm run dev` never registers it and HMR is unaffected.

**Icon set.** Generated once from Ben-supplied source artwork (`materials/Work-Organizer Icon.jpeg`,
not itself deployed — a raw source asset, kept out of `public/`) via `scripts/generate-icons.mjs`
(`npm run generate:icons`, new devDependency `sharp`): `icon-192.png` / `icon-512.png` (Android,
`purpose: any`), `maskable-512.png` (Android adaptive icon, `purpose: maskable` — the source is
padded into the inner 80% safe zone on a canvas sampled from its own corner pixel, since the
artwork's glow ring sits close to the edge and Android's mask can crop up to the outer ~20%),
`apple-touch-icon.png` (180×180, iOS), and `favicon-32.png`. Re-run the script manually whenever the
source artwork changes; nothing in `vite build` or the Vercel deploy invokes it.

**Manifest** (`public/manifest.webmanifest`): `display: "standalone"` (app-like, no URL bar, without
`fullscreen`'s more aggressive status-bar hiding, which would fight the existing
`apple-mobile-web-app-status-bar-style`); no `orientation` lock (a weekly shift grid may read better
in landscape on a phone); `background_color: "#0f172a"` reuses the app's existing dark theme color as
the Android splash-screen background; `theme_color: "#3762f4"` (brand-500) is a deliberate change
from the flat `#0f172a` `<meta name="theme-color">` that predated this feature — `AppShell`'s header
is semi-transparent blur with no single color of its own to copy, so the real brand blue is what
makes the installed app read as branded (status bar, task-switcher card) rather than generic dark
slate. `index.html`'s `theme-color` meta is now a light/dark media-queried pair mirroring that same
split, rather than the single flat value.

**iOS needs its own tags — the manifest alone is not enough.** `apple-mobile-web-app-capable` sits
alongside the pre-existing, newer, non-prefixed `mobile-web-app-capable` — iOS Safari ignores the
standard tag and requires its own vendor-prefixed one to launch standalone from the home screen. The
pre-existing `apple-mobile-web-app-status-bar-style` and `apple-mobile-web-app-title` tags (added
ahead of this feature, §1 mobile-first intent) needed no change. iOS has no `beforeinstallprompt` or
install-banner concept at all — "Add to Home Screen" is always a manual action via Safari's Share
sheet, and iOS relies on these tags and `apple-touch-icon`, not the manifest, which it largely
ignores.

**`vercel.json`** gained a `headers` block: an explicit `Content-Type: application/manifest+json` for
`/manifest.webmanifest` (`.webmanifest` isn't reliably auto-typed) and `Cache-Control: no-cache` for
`/sw.js` (a stale-cached service worker file would be a lingering version of the exact stale-content
risk this feature otherwise avoids by design). The pre-existing catch-all SPA `rewrites` entry was
verified, not assumed, to leave these paths alone — Vercel serves an existing static file ahead of a
rewrite by default, confirmed directly against both `vite preview` and production after deploy.

**Verified**: manifest parses and serves with the correct content-type, the service worker registers
and reaches `activated` at scope `/`, icons resolve, zero console errors — checked with a headless
browser against `vite preview` and re-checked against production content-types after deploy. **Not
verifiable from this machine**: real "Add to Home Screen" behavior on physical Android Chrome and iOS
Safari devices — Chrome's own mobile-emulation toolbar only resizes the viewport, it does not
reproduce a native install banner or real home-screen icon rendering. Pending Ben's own on-device
check before this is considered fully done.

---

## 11. DEPLOYMENT

```
[Local]
   │ git push
   ▼
[GitHub: work-orgenizer] ──► [Vercel]  React app        (VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_SOLVER_MODE)
                         ──► [Render]  FastAPI + CP-SAT (SOLVER_SECRET)
                                  ▲
                         [Supabase]  Postgres + Auth + Edge Functions (SOLVER_URL, SOLVER_SECRET)
```

**Migrations** are applied over HTTPS by `npm run db:apply`, which keeps a `schema_migrations`
ledger and skips what is already applied. This matters on the current development machine: outbound
Postgres ports (5432/6543) are firewalled, so `DATABASE_URL` cannot be used and the Supabase
Management API is the only route in.

### 11.1 Render Setup

1. Push the repository to GitHub (Render deploys from a Git remote).
2. render.com → **New → Blueprint** → select the repo. It reads `render.yaml` at the repo root and configures
   the service itself: Python, `rootDir: solver`, `pip install -r requirements.txt`,
   `uvicorn main:app`, health check on `/health`.
3. In the Render dashboard set **`SOLVER_SECRET`** to any long random string. It is marked
   `sync: false` in the blueprint precisely so it is never committed.
4. In Supabase → Edge Functions → Secrets, set **the same `SOLVER_SECRET`** plus **`SOLVER_URL`**
   (the Render URL, no trailing `/solve` — the function appends it).
5. Set `VITE_SOLVER_MODE=remote` locally and in Vercel.

The secret never reaches the browser: the client calls the Edge Function with its own session, and
only the function knows the token that Render will accept.

### 11.2 Vercel Setup — done, 8 August

Live at `https://work-organizer-iota.vercel.app/` — the stable production alias (Settings → Domains),
the one to actually share with the team. `npm run build` (Vite,
auto-detected) needed no extra config beyond the standard steps, run from the repo root by Ben (the
Vercel account holder — the browser-based login step can't be done on his behalf):

1. `npx vercel login` — browser tab to authenticate; no global install needed.
2. `npx vercel link` — connects the local repo to a Vercel project.
3. Set the three `VITE_*` env vars (§10 — only these are safe in the browser bundle; `SOLVER_URL` /
   `SOLVER_SECRET` / `SUPABASE_ACCESS_TOKEN` must never be set here), values straight from
   `.env.local`, declined as "sensitive" when the CLI asks — that flag makes a value **un**readable
   later with no security benefit here, since a `VITE_*` value ships in the public browser bundle
   either way (§7.3 already documents the publishable key as public by design):
   ```
   npx vercel env add VITE_SUPABASE_URL production
   npx vercel env add VITE_SUPABASE_PUBLISHABLE_KEY production
   npx vercel env add VITE_SOLVER_MODE production
   ```
4. `npx vercel --prod` — builds and deploys.

Two gotchas hit during the real run, both one-time fixes now resolved:

- **`vercel link` used "repo-link" mode** (`.vercel/repo.json`, a `projects` array) instead of a
  traditional single-project `.vercel/project.json`, because the CLI saw two deployable things in
  this repo (the frontend at root, the Python solver in `solver/`, spec §11.1). Something in how that
  mode serialized the project's Root Directory (`"."` → `./`) tripped a server-side validation error
  on every `vercel --prod` ("Root Directory must be a relative path not starting with `./`") even
  though the dashboard's own Root Directory field read as empty. Fixed by replacing `repo.json` with
  a plain `project.json` holding the same `projectId`/`orgId` — the traditional single-project link
  format `.vercel`'s own README describes. `.vercel` is gitignored either way, so this is purely
  local CLI state, not something to fix per-machine if it recurs.
- **Deployment Protection ("Vercel Authentication") was on by default**, gating every deployment —
  including production — behind a Vercel account login. The build was live and correctly wired
  (confirmed: right RTL/Hebrew shell, right title, the served JS bundle had the real Supabase project
  URL and publishable key baked in) but returned an HTTP 302 to `vercel.com/sso-api` for anyone not
  logged into the Vercel team — which is everyone, guards included. Disabled in Settings →
  Deployment Protection.

**GitHub integration is connected** (Settings → Git → `BenLachovitz/Work-Organizer`), so a push to
`main` deploys automatically — matching the `[Local] → git push → [GitHub] → [Vercel]` diagram at the
top of this section. `npx vercel --prod` is no longer part of the ongoing workflow; it's only useful
now for deploying local changes ahead of a push. Both gotchas above were one-time project setup, not
something to redo per deploy.

Production alias: `work-organizer-iota.vercel.app` (Settings → Domains) — this is the one to actually
share with the team; the per-deployment hashed URL from §11.2's first live run
(`work-organizer-ftqvcglmy-...`) changes on every new build and should not be bookmarked.

---

## 12. OPERATIONS WORKFLOW

1. **Until Wednesday 19:00 — submission window.** Guards submit availability + per-day 12h opt-ins. Empty submissions are valid. RLS locks writes at the deadline. Weeks are created automatically by `ensure_roster_weeks()`, which always keeps exactly one week open.
2. **Wednesday evening — configuration.** Manager sets the Mon-Fri morning target (2 or 3) and each guard's כמות. `ManagerDashboard` defaults its selected week to **next week**, not whichever week happens to be `open` — nearly all of a manager's actual work (כמות, generate, publish) targets the week ahead, not the one already in progress.
3. **Pre-flight.** The system computes `effective_kamut` and shows any auto-overrides for review.
4. **Generate.** CP-SAT returns an optimal draft plus a coverage report (floor breaches, target gaps, unmet כמות, rest violations).
5. **Audit.** Manager reviews the colour-coded grid and makes manual swaps (`RosterEditor.tsx`) — before publishing, or after, on a roster already live.
6. **Publish.** The run is marked `is_published`. The partial unique index guarantees at most one
   published roster per week; publishing a different version replaces the previous one. Saturday's
   assignments become next week's carry-in.

### 12.1 Week Lifecycle

Weeks are never created by hand. `ensure_roster_weeks()` runs on every app load and is idempotent:
it creates the current week and the next, and opens or locks each against its window (§2.4a). The
pair advances on its own. Because the deadline is enforced live by `is_week_open()`, a guard cannot
submit late even if nobody has opened the app for days.

> The sweep only runs when **somebody opens the app**. If that is not good enough, Supabase's
> `pg_cron` can call `ensure_roster_weeks()` on a schedule. Not currently configured.

**Two cursors, deliberately kept apart (migration 26).** "Current" means two different things
depending on who's asking, and the two are no longer the same function:

- `current_week_start()` — a pure calendar calculation, the Sunday of the week containing today.
  Unaffected by any setting. This is what RLS's archive cutoff (§12.2) and `guard_visible_from()`
  (migration 16, the Saturday-night grace period) key off — a guard's visibility into a published
  roster is pinned to the real calendar and can never be moved by a manager's configuration.
- `admin_current_week_start()` — the manager-facing cursor, used only by `ensure_roster_weeks()`
  itself (deciding which two weeks to track) and `WeekControlsPanel`'s live/archive split. It
  advances at each week's own configured submission open-time instead of real midnight: week `W`
  becomes admin-current the instant `W + 7`'s window opens. At the default settings
  (`open_offset_days = 7`, `open_time = 00:00`) this collapses to exactly `current_week_start()`;
  away from the defaults it can run ahead of (or behind) the real calendar by design, so a manager
  changing the open-time setting sees the _whole_ archive/current/next cycle move with it, not just
  a lock/open flag on whichever week already happened to be "next."

This split exists because a manager testing the open-time setting expected changing it to move the
entire cycle, and the earlier single-cursor design only ever moved a status flag. The fix surfaced a
real bug: because `admin_current_week_start()` is not guaranteed to move only forward (raising the
open-time after it had already advanced moves it back), a week that was briefly admin-next and got
auto-opened could fall out of the tracked pair and never be swept again, staying `open` forever.
`ensure_roster_weeks()`'s sweep is bounded to a window around the real calendar week
(`current_week_start() − 7 .. + 28`) rather than scoped to just the tracked pair (too narrow, this
was the bug) or left fully unbounded (too broad — it then reconciles unrelated rows, like test
suites' own future-dated fixtures, that were never meant to be subject to this at all). The same
bound also governs a separate, related fix: a week's stored `submission_deadline` is normally set
once at creation and never rewritten (§12.5) — too strict for a week nobody has manually decided
anything about, so within the same bound `ensure_roster_weeks()` also keeps such a week's deadline
live against the current `scheduler_settings`, not just its open/locked status.

> **Fixed in v2.8 (migration 36): that deadline-refresh step was itself an unconditional
> `UPDATE`.** It rewrote `submission_deadline` for every in-window, non-overridden, non-terminal
> week on every call — even when the computed value was identical to what was already stored.
> Postgres still performs a physical row write for a same-value `SET`, and Realtime broadcasts that
> as a genuine `UPDATE` regardless of whether any column's value actually changed. `useRosterRealtime`
> (§10) subscribes to `roster_weeks` updates for whichever week is on screen and reacts by
> invalidating the `roster_weeks` query — whose `queryFn` calls `ensure_roster_weeks()` again, which
> repeats the same no-op write, broadcasts again, and invalidates again. Caught live testing the
> per-day override feature above: opening `/manage` against the production project fired
> `ensure_roster_weeks()` roughly every 100ms, indefinitely, for as long as the dashboard stayed
> open — hammering the database for zero user action. Fixed with the same value-guard the two
> status-reconciliation `UPDATE`s right below it already use (`WHERE` the value would actually
> change) — `IS DISTINCT FROM` on the computed deadline.

### 12.2 Archive

Past weeks remain stored and are **manager-only**, enforced in RLS rather than by hiding a route: a
guard holding the publishable key can query PostgREST directly. The cut is **absolute** — a guard
sees nothing from a finished week, not even a shift they personally worked. The manager reaches
them through the "שבועות אחרים" toggle.

### 12.3 Manager Override Beats Automation

Twice during development an automatic rule silently overruled a human decision, and both were bugs:

1. A badge code auto-disabled after failed claims — which an unauthenticated stranger could trigger,
   permanently locking a guard out of registering (removed in migration 6).
2. The week sweep re-locked any week past its deadline, reverting the manager's "reopen" within
   milliseconds (fixed in migrations 11–12).

The rule that came out of it: **a manager's explicit action is recorded (`status_overridden_at`) and
the automation hands that week over permanently.** Reopening also extends the deadline, because
`is_week_open()` gates on the deadline as well as the status — changing the status alone would have
changed nothing observable. Locking again clears the extension, but only once the canonical deadline
has genuinely passed, so locking a week _early_ cannot accidentally become an extension.

### 12.4 Team Management (migrations 20–21)

A dedicated page (`/manage/team`, `src/pages/TeamManagement.tsx`) gives the manager CRUD over the
team itself, as opposed to ManagerDashboard's week-by-week workflow. Reached via a back-linked
button on `ManagerDashboard`, not a bottom-nav tab — it is a config screen, not something opened
every day.

| Operation           | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Add employee**    | `INSERT INTO roster_codes` — the same action `seed.sql` did by hand for the first eight. The employee still sets their own PIN through the ordinary "קוד עובד" login flow; nothing here creates an account directly.                                                                                                                                                                                                                                                                                 |
| **Delete employee** | `delete_employee(employee_code)` RPC (migration 21) — a genuine, irreversible deletion, not a deactivation. Cascades through `auth.users → profiles → {schedule_assignments, weekly_wish_preferences, weekly_submissions, weekly_guard_targets}`, so the person's shift history is gone from every roster, including a published one. Refuses to let a manager delete their own account. Works identically on a still-pending invitation (no profile exists yet, so only `roster_codes` is touched). |
| **Reset PIN** (v2.20.2) | `reset-pin` Edge Function — resets a claimed guard's forgotten PIN (their literal GoTrue password on `{code}@guards.local`) to a new value the manager enters, WITHOUT touching `profiles`, `roster_codes`, or anything hanging off `guard_id`. **Permanent fallback** for any guard whose device has no push subscription for the self-service forgot-PIN flow to deliver an OTP to (§12.12) — the guard's own self-service flow is the primary path, this is the manual backstop. |
| **Default כמות**    | Edits `profiles.default_kamut` (claimed) or `roster_codes.default_kamut` (not yet claimed) — the §2.7 baseline, not the per-week override the `Stepper` on `TeamTable` already edits.                                                                                                                                                                                                                                                                                                                |

> **v1 of this feature deactivated instead of deleting** (`profiles.is_active = false`), reasoned
> from the same cascade this table describes: deleting the row would erase a person's shift history
> out of a published roster. The manager tried it and asked for real deletion anyway — a fully
> informed call about their own data, not a case of the concern being missed. `is_active` still
> exists and still gates scheduling eligibility (§2.1) exactly as before; there is simply no more UI
> path to flip it, since there is nothing left to flip once the row is gone.

Three points worth keeping:

1. **`claim-code` is untouched.** It is the one publicly-reachable _unauthenticated_ write path in
   the system (its own docstring treats every caller as hostile), so it is changed as rarely as
   possible. Neither `roster_codes` getting a manager write policy (migration 20) nor
   `delete_employee` needing `auth.users` access (migration 21, necessarily a `SECURITY DEFINER`
   function — `auth.users` is not exposed through PostgREST at all, so there is no RLS policy that
   could gate a direct write to it the way `roster_codes` got one) touches that function or its risk
   surface.
2. **The default carries itself across claiming.** `trg_profiles_default_kamut`, a `BEFORE INSERT`
   trigger on `profiles`, copies `roster_codes.default_kamut` onto the new row — `COALESCE`d against
   whatever the insert already specified, so a profile created with no matching `roster_codes` row
   (test fixtures, mainly) is left alone rather than forced through a lookup that finds nothing. This
   fires for every profile insert, not just ones this UI causes — `claim-code`'s service-role insert
   included — so the guarantee holds regardless of who or what creates the row.
3. **Editing an existing employee's default needs no new policy.** `profiles_manager_write`
   (migration 3) already lets a manager write any guard's `default_kamut` — that part of the page is
   pure UI on top of a policy that already existed.
4. **Reset PIN could not be "delete and re-claim," because `profiles.id IS auth.users.id`** — the
   same UUID, FK'd `ON DELETE CASCADE` (migration 1). Deleting just the `auth.users` row to let the
   guard re-claim the code takes the `profiles` row (and everything hanging off `guard_id`) down with
   it — exactly what `delete_employee` above already does deliberately, and exactly what "reset her
   PIN without touching her roster history" needs to avoid. The only viable shape is resetting the
   PASSWORD on the existing `auth.users` row in place, via `admin.auth.admin.updateUserById()` — the
   same service-role admin call `claim-code` already uses to create one (§ above), applied to an
   existing user instead. Unlike `claim-code`, `reset-pin` is deployed WITHOUT `--no-verify-jwt`: the
   platform itself rejects a request with no valid session before the function's own code even runs,
   and the code re-checks `is_manager()` server-side on top of that (same two-layer pattern as
   `generate-schedule`) — a guard's own JWT is correctly rejected with 403, never just "hidden" in the
   UI. Verified end-to-end against the live project: a guard JWT is rejected, a too-short PIN is
   rejected, a manager's reset succeeds, the OLD PIN stops working immediately, the NEW one signs in,
   and the guard's `profiles` row (id, employee_code) is provably unchanged.

### 12.5 Configurable Submission Window (migration 22)

`deadline_for_week()` and `opens_for_week()` (§2.4a) used to be literals — `week_start - 4` at
19:00, `week_start - 8` at 20:00. A single-row `scheduler_settings` table now holds each as
`(offset_days, time)`, and a manager edits it from a collapsible **חלון הגשת בקשות** card on
`ManagerDashboard` (`SubmissionWindowSettings.tsx`), collapsed by default since it is changed rarely.

The database still only ever sees an offset — the UI is where "day of week" becomes days-before-
`week_start`. `src/lib/dates.ts` does the conversion:

```
offsetForWeekday(weekday, mustExceed = 0)
  naive = days before a Sunday that `weekday` falls on          -- e.g. Wednesday -> 4
  if naive <= mustExceed, step back a further 7 days and retry  -- picking the SAME weekday
                                                                    for both endpoints still
                                                                    produces something unambiguously
                                                                    earlier, not a collision
  → offset

weekdayForOffset(offsetDays)  -- the inverse, for displaying a stored offset as a weekday
```

Saving computes `deadlineOffset = offsetForWeekday(deadlineWeekday)`, then
`openOffset = offsetForWeekday(openWeekday, deadlineOffset)` — validated against the current
defaults: Wednesday → 4 (`mustExceed` not binding), Saturday with `mustExceed=4` → naive 1, which is
not > 4, so steps back a week → 8. Both match the original literals exactly.

Two things worth keeping:

1. **A CHECK, not just client-side care.** `open_before_deadline` on `scheduler_settings` requires
   `open_offset_days > deadline_offset_days` (or equal offsets with an earlier `open_time`) — larger
   offset is earlier in time, since both count backward from `week_start`. The client-computed values
   satisfy this by construction, but the constraint is what actually stops a bad row, including one
   written by hand.
2. **Changing the setting is forward-looking.** `deadline_for_week()`/`opens_for_week()` are read
   only when `ensure_roster_weeks()` inserts a new `roster_weeks` row or sweeps status against that
   row's already-_stored_ deadline — an existing week's stored `submission_deadline` is not rewritten
   retroactively. To change one specific week's deadline right now, the lock/reopen flow (§12.3,
   migrations 11–12) is still how. Also changed: both functions went from `IMMUTABLE` to `STABLE`,
   since their result can now change between calls if a manager edits the settings row — `IMMUTABLE`
   tells the planner it may cache or fold a call forever, which would go stale the moment settings
   change.

### 12.6 Seed Data Is Bootstrap-Only

`seed.sql` is not just start-of-project scaffolding — `npm run db:apply` reruns it on **every**
invocation, migration or not, and it originally seeded `roster_codes` with
`ON CONFLICT (employee_code) DO NOTHING`. That combination has a sharp edge: once real team
management existed (§12.4) and a manager could genuinely _delete_ an employee, a deleted row is no
longer a conflict — so the next `db:apply` silently re-inserted it. This actually happened: a
placeholder employee the manager had deleted through the real feature came back after an unrelated
migration was applied.

Fixed by gating the whole `roster_codes` insert on the table being **empty**
(`WHERE NOT EXISTS (SELECT 1 FROM roster_codes)`), not on a per-row conflict. A genuinely fresh
database still gets bootstrapped to a usable starting point; a database that already has ANY row —
real or not — is never touched by this block again, so a deletion (or an edit, or an addition
through Team Management) sticks. The two placeholder codes for guards nobody had hired yet
(`100008`, `100009`) were dropped from the seed entirely in the same pass — Team Management is how
a new employee gets added now, so a permanently-unclaimed placeholder serves no purpose and was
exactly the kind of row this bug could resurrect.

Verified with a regression test (Gate A local, "seed.sql does not revive a deleted employee"):
delete a seeded code through `delete_employee()`, rerun `seed.sql` verbatim, assert it is still gone.

### 12.7 Manager Preference Detail View and Edit-on-Behalf-of Window (v2.6)

`TeamTable` only ever showed aggregate badge counts per guard (12h opt-ins, עדיפות marks, and now
מבוקש, §3.10) — never the actual slots behind them. `GuardPreferenceDetail.tsx` renders a guard's
full submitted availability, day by day, with the same עדיפות/12h/מבוקש/notes detail the guard
themselves sees, reached by clicking a row on `ManagerPreferences.tsx`.

From that same detail view, a manager can edit the guard's submission directly —
`GuardPreferenceEditor.tsx`, a **minimal click-to-toggle grid**: tap a shift cube to mark or unmark
it, the same 12h/עדיפות toggles as the guard-facing form, the requested-shifts stepper (§3.10), and
one save button. This went through one full rebuild: the first version reused
`WeeklyPreferenceForm` itself, and was rejected as over-complex for what a manager actually needs —
"just by clicking the shift cubes and a small button for saving... simple, intuitive for edits as an
admin," not the guard-facing form's deadline countdown, feasible-shifts summary, or
submit-confirmation flow (which the editor still gets, §3.11, just without the rest of that
chrome). Saving goes through `manager_save_week_preferences` (migration 32), the manager-authority
twin of `save_week_preferences` (§7.1) — same atomic-replace shape, keyed on an explicit
`p_guard_id` rather than `auth.uid()` (neither `save_week_preferences` nor `delete_week_submission`
could be reused for this: both are hardcoded to act only on the caller's own row). Gated on
`is_manager()` only, deliberately **not** `is_week_open()` — a manager's edit on a guard's behalf
isn't bound by that guard's own submission deadline, the same way a manager can already edit a
published roster. A parallel `manager_delete_week_submission(p_guard_id, p_week_start)` mirrors
`delete_week_submission` (§3.7) the same way.

### 12.8 Admin Real/Test View-Mode Toggle (`is_demo`, migration 34, v2.8)

The 7 mock guards (`{שם} - דמה`, §1.4 item 25) are permanent test fixtures — Ben keeps using them for
sanity-testing even as real registration proceeds alongside them (§1.4). `TeamTable`, `TeamManagement`
and `ManagerPreferences` (`GuardHome`'s "manager preferences" list) all showed every active
guard mixed together, real and demo, with no way to see just one group.

**The flag, not the naming convention.** `is_demo` (a real boolean column, on both `profiles` and
`roster_codes` — a row can live in either depending on claimed state, the same reason
`default_kamut` lives on both, §12.4) is the source of truth, not string-matching the `- דמה`
display-name suffix: a name-based check would break if a demo guard were ever renamed, and can't
distinguish a real employee whose name happens to contain the substring. Backfilled by known
employee_code (`100001`–`100007`) in the same migration, not by matching the suffix.

**The toggle itself**: `ViewModeContext` (`src/contexts/ViewModeContext.tsx`, same shape as
`ThemeContext`, §10.3) is binary — `'real' | 'test'`, persisted to `localStorage`, defaulting to
`'real'`. A control in `AppShell`'s header, visible only when `isManager` (the same role check
`BottomNav` already uses), switches it. `visibleToViewMode()` (`src/lib/viewMode.ts`) is the shared
filter: `mode === 'test' ? guard.is_demo : !guard.is_demo` — **except** Ben (`005396`), who is
always visible in both modes regardless of the flag, since he was never seeded with a separate demo
account to begin with.

**Display-only, deliberately.** The toggle changes what the manager dashboard's _lists_ show —
`TeamTable`, `TeamManagement`, `ManagerPreferences` — never who gets scheduled. Generation,
`CoverageMatrix` and `RosterGrid` all keep reading the full, unfiltered guard set exactly as before;
`is_active` alone still governs solver inclusion (§2.1). Filtering `TeamTable`'s rows happens after
`buildGuardRows()`, on the derived rows, specifically so `data.guards` itself — what generation and
the roster grid actually consume — is never touched by the toggle.

### 12.9 Free-Text Assignment Notes (migrations 38–39, v2.11)

A generated assignment answers "who, what shift, which day" — not "what's actually different about
this one." The manager sometimes knows a real wrinkle that doesn't fit that model: a guard covering
an `afternoon` shift will really walk in at 10:45 and work a 12h day instead, or a guard on `morning`
is leaving two hours early that one day. Reshaping the assignment to fit — splitting the afternoon
into two segments just to capture an early arrival — would distort the segment coverage model (§2.3)
over something that isn't actually a coverage fact. `schedule_assignments.note_before` and
`.note_after` let the manager say it in words instead, attached to the exact cell it's about.

Two independent, nullable `TEXT` columns (not one), each capped at 40 characters — short by design,
since these render inside an 11px on-screen chip and a fixed-width canvas column, not a paragraph
field like `weekly_submissions.notes` (§3.6). Both can be set on the same cell at once: "(מ-10:45)
שלי (12 שעות)" is a legitimate single annotation split across both sides of the name.

**Manual edit only**, wired through `RosterEditor.tsx`'s `SlotEditor` — the per-cell modal the
manager already uses to change a guard or shift type gained two short text inputs alongside them.
`save_run_assignments` already replaces a run's assignments wholesale on every save (migration
13/14); the notes ride along in the same JSONB payload, trimmed and NULLed when blank
(`NULLIF(TRIM(...), '')`, the same convention `weekly_submissions.notes` uses). A fresh solver
generation never sets these — a new run starts with zero notes, consistent with every other manual
edit not carrying over between versions.

**Rendered everywhere the cell is displayed**, not just in the editor: the shared `RosterGrid.tsx`
`Chip` component (used by both the manager's own roster view and the guard-facing one), the JPEG
export (`exportRoster.ts`, which mirrors `RosterGrid` rule for rule, §10.2), and the guard's own
"המשמרות שלי" list (`RosterView.tsx`). Column widths (`measureColumns.ts`'s `widestRosterColumn()`,
and `exportRoster.ts`'s own canvas measurement pass) account for the extra text so a note is never
silently clipped.

**Solver-blind by design**, same status as `weekly_submissions.notes`: never part of the solver
contract (§9.2), never read by `validate.ts` / `verify.py`. It's context for a human reading the
roster, not a constraint — the exact same reasoning that field's own migration comment gives.

**Placeholder (guard-less) rows, migration 39.** Migration 38's note only ever rides on a REAL
assignment — a note about Yam's own morning shift has to be attached to Yam's own row. That breaks
for a note that isn't about any one guard's shift at all: "Yam is alone in the morning until 10:45,
then Shely joins" is a fact about the morning _segment_, not a second real shift for Shely — who may
already have a genuine assignment elsewhere that day (§2.3's afternoon, say), and adding her again
to the morning cell would be a real double-booking. The `one_shift_per_guard_per_day` index and the
referee's H3 check are _right_ to refuse that, because as far as the data model is concerned it
would be exactly that.

`schedule_assignments.guard_id` is nullable as of migration 39: a `NULL`-guard row is a
**placeholder** — a cell annotation with no real person behind it, existing purely to carry
`note_before`/`note_after` text. Both existing `UNIQUE` constraints on the table already treat
`NULL` as distinct from any other value (standard SQL) — so a run/day/shift can hold any number of
placeholder rows alongside its real ones, with no collision, and no index change was needed. A
placeholder is checked the other direction instead: `placeholder_needs_a_note`
(`CHECK (guard_id IS NOT NULL OR note_before IS NOT NULL OR note_after IS NOT NULL)`) refuses a
row that is neither a real assignment nor carries any text — just a blank row with no purpose.
`RosterEditor.tsx` already drops an emptied-out placeholder client-side before saving, so this CHECK
is a backstop, not the primary UX.

Threaded through every consumer identically to a real row, minus anything that only makes sense for
a real person: `nameOf()` returns `''` for a placeholder (not `'—'`, which stays reserved for a
real data problem — an id that doesn't resolve to any known guard) so the note text carries the
whole chip; the referee (`RosterEditor.tsx`'s `verifySchedule` call) filters placeholders out of its
payload entirely rather than teaching every hard rule about them, the same way it never learns about
a guard who isn't on the roster; and every coverage/target computation (`RosterEditor`'s `cellTone`,
`RosterGrid`'s `covers()`, `exportRoster.ts`'s `covers()`, and the morning/night/afternoon
gap-padding math in all three) counts only _real_ rows, so a cosmetic placeholder chip can never
paint a genuinely short-staffed cell green or hide a real coverage gap underneath it. Visually a
placeholder chip is styled exactly like a real one, coloured by its shift the same way — the note
text itself is what tells the reader what it means.

**Manager UI**: the guard `<select>` in `SlotEditor` — both the per-row editor and the "הוספת
מאבטח" add flow — gained a leading "— ריק (הערה בלבד)" option (label text updated in v2.23.0, see
below — it no longer unconditionally says "not counted in coverage," since that's no longer always
true). Selecting it and adding a note (either or both fields) creates a placeholder row; the
marked/carried-in-from-Saturday hints, which are meaningless for a non-guard, are silently skipped
for one rather than showing a false "לא סימן" warning.

**Coverage-occupying placeholders, migration 52 (v2.23.0, §1.25).** A placeholder was, until here,
*unconditionally* excluded from coverage — the right default for a pure annotation, but it left no
way to say "someone genuinely covers this slot, I don't want to name who" without the roster reading
as short-staffed underneath a note that says otherwise. `schedule_assignments.occupies_slot BOOLEAN
NOT NULL DEFAULT FALSE` (migration 52), meaningful only when `guard_id IS NULL`
(`CHECK (occupies_slot = FALSE OR guard_id IS NULL)` — a real assignment already occupies its own
slot, so the flag is meaningless there and the database refuses to let it be set). Defaults `FALSE`,
so every placeholder that existed before this migration is completely unaffected. A placeholder
still requires at least one note regardless of the flag — Ben's explicit call, occupying a slot does
not relax `placeholder_needs_a_note`.

When set, the placeholder counts toward that segment's floor/target/ceiling **exactly like a real
assignment** — `validate.ts`'s `coverageBySegment()` already summed every assignment by `day`+`shift`
alone, never reading `guard_id`, so it needed no change at all to pick this up once a `guard_id:
null` row reaches it. What *does* need to change is everywhere that previously used "has a
`guard_id`" as its coverage-inclusion test: `RosterEditor.tsx`'s referee-input filter and its
`cellTone` closure, `RosterGrid.tsx`'s `covers()`/`realCount`/`realFull`/`realPairs`, and
`exportRoster.ts`'s equivalents — each widened from `guard_id != null` to
`guard_id != null || occupies_slot`. The placeholder still never becomes a real guard for any
guard-specific purpose: `validate.ts` gained its first `guard_id === null` branch, explicitly
skipping H1/H2 (availability, 12h opt-in), H3/H4 (one-shift-per-day, the weekly ceiling), H5/H7
(rest), and `scoreSchedule()`'s preference/stretch terms whenever `guard_id` is null — a
coverage-occupying placeholder fills a floor/target/ceiling slot and can resolve a shortfall in the
manager's live verdict, but is invisible to every rule and every number that requires a real person
behind it.

A new per-row "תופס משבצת בכיסוי" checkbox in `SlotEditor` — shown only while the row's guard is
the placeholder sentinel, in both the per-row editor and the "הוספת מאבטח" add panel — sets the
flag. Switching a row's guard picker from the placeholder to a real guard resets it to `false` in
the same `onChange`, so the draft can never carry a combination the database would refuse.

### 12.10 Push Notifications (migrations 40–42, `send-notifications`, v2.12)

Two kinds of notification, delivered as real OS-level push through the service worker already
installed for the PWA (§10.4): a **fixed weekly broadcast** (every Sunday 11:00 Asia/Jerusalem, to
every active non-demo profile, regardless of submission status) announcing that week's actual
submission deadline, and **two deadline-relative reminders** (~24h and ~2h before the open week's
real deadline) sent only to guards who haven't submitted yet — `unsubmitted_targets()`, the same
"no row in `weekly_submissions`" convention §3.4 already uses for "never submitted" vs. "submitted
empty." Push-only by explicit decision: no SMS/email fallback for a guard who doesn't install the
app. iOS only delivers Web Push to a PWA actually added to the home screen (Safari 16.4+) — an
accepted limitation, not something this feature works around.

**Storage** (migration 40): `push_subscriptions` (one row per browser/device, keyed by `endpoint`
so a guard can hold several) and `notification_log` (an audit trail of every send _attempt_ — sent
or one of five distinct skip/failure reasons). A partial unique index,
`(notification_type, week_start, guard_id) WHERE status = 'sent'`, is the idempotency primitive —
`claim_notification_send()` optimistically inserts a `'sent'` row before the actual push call, so a
duplicate trigger (see below) can never double-send. Two SQL functions, `broadcast_targets()` and
`unsubmitted_targets(week_start)`, are the single source of truth for "who gets this," reused by
both `send-notifications` and the test suite so targeting logic is defined exactly once. Neither
filters on `role` — a manager is also a real, active guard who submits their own availability (§2.1,
Ben is scheduled exactly like everyone else); an earlier draft of `unsubmitted_targets()` filtered
to `role = 'guard'` and would have silently excluded him from his own reminders, caught in review
before shipping and asserted explicitly in Gate G so it can't regress unnoticed.

**Scheduling — the design changed twice while building this, both times because of a real hosted-
Postgres permission wall, not a change of mind:**

1. _Original design_: three separate weekly `cron.schedule()` entries (one per notification type),
   each firing once, at a precomputed day/time — deliberately not a repeating poll. The two
   reminders' times were meant to be _derived_ from `scheduler_settings` by a Postgres function,
   re-registered automatically by an `AFTER UPDATE` trigger whenever the window changed. This
   required `ALTER DATABASE postgres SET cron.timezone = 'Asia/Jerusalem'` so pg_cron's hour/day
   fields would evaluate in Israel wall-clock time. **Rejected by Supabase itself**:
   `55P02: parameter "cron.timezone" cannot be changed without restarting the server` — a restart a
   client cannot trigger.
2. _Revised design (what's actually running)_: a single cron job, `notification_tick`, fires every
   15 minutes (`*/15 * * * *` — a cadence, not a wall-clock time, so it needs no timezone setting at
   all). Each tick is pure SQL, no HTTP call: it compares `NOW()` against absolute `TIMESTAMPTZ`
   targets — `broadcast_due()` computes "the nearest Sunday 11:00 Israel time" using the same
   `AT TIME ZONE 'Asia/Jerusalem'` idiom `deadline_for_week()` already uses (migration 22, correctly
   DST-aware), and the two reminders compare against the _open week's real, already-stored_
   `submission_deadline` minus 24h/2h via `reminder_due()`'s ±20-minute tolerance window (migration
   40). Only on the rare tick where something is actually due does it call `net.http_post` — the one
   thing that costs an Edge Function invocation, still only a handful of real calls per week, not
   96/day. This also means a `scheduler_settings` change needs no special handling at all anymore:
   the tick always reads the _live_ deadline, so there is nothing to precompute or go stale — a
   genuine simplification, not just a workaround.
3. _Secrets_: the URL and shared secret `notification_tick()` needs to call `send-notifications`
   were originally meant to be two `ALTER DATABASE ... SET app.settings.*` GUCs (mirroring how every
   other secret in this project is set manually, never committed). **Also rejected**:
   `42501: permission denied to set parameter "app.settings.notify_url"` — the Management API role
   (used for every migration and test in this project) isn't allowed to alter database-level config
   here either. Replaced with an ordinary table, `notification_secrets` (migration 42): RLS enabled
   with **zero policies** at all, so `authenticated`/`anon` get no access whatsoever via PostgREST —
   filled in with a plain `UPDATE`, which only needs standard DML privileges the API role already
   has (proven by every other migration and test in this project).

**Gate A (local/PGlite) compatibility**: `pg_cron` requires a background-worker process PGlite — a
single-process WASM Postgres — can never provide. Rather than let this break Gate A's guarantee that
every migration applies cleanly from disk (`rls.test.mjs`'s own stated principle: migrations are
_discovered_, not listed, specifically so nothing after a given point silently stops being tested),
migration 41 wraps its extension creation and cron registration in `DO` blocks that catch the
failure and log a `NOTICE` instead of erroring — on a real Supabase project (which has both
extensions) it behaves identically to a bare statement; on PGlite it leaves `notification_tick()`
defined but unscheduled, and every migration after it still applies and is still tested.

**`send-notifications`** (`supabase/functions/send-notifications/index.ts`): deployed
`--no-verify-jwt` — no browser ever calls this, only `pg_net` — authorized instead by an
`x-cron-secret` header compared against the `CRON_SHARED_SECRET` Edge Function secret. Finds the
target week with `ORDER BY week_start ASC LIMIT 1`, deliberately not `.maybeSingle()`: "exactly one
open week" is a design intent (§2.4a), not a DB-enforced invariant — a manager's manual status
override can leave two weeks open at once, and the earlier query shape would have thrown rather than
picking the soonest-closing one (also caught in review, also asserted explicitly in Gate G). Sends
via `npm:web-push` (confirmed working in Supabase's Deno runtime by a standalone smoke test before
the real function was written); a 404/410 response means the subscription is dead and is pruned from
`push_subscriptions` immediately. VAPID key pair generated once via `web-push generate-vapid-keys`;
the private half and `CRON_SHARED_SECRET` live only as Edge Function secrets, the public half ships
as `VITE_VAPID_PUBLIC_KEY` (safe for the browser, needed by `PushManager.subscribe()`) — same
never-in-git discipline as `SOLVER_SECRET` (§11.1).

**Frontend**: `src/lib/push.ts` (subscribe, upserting into `push_subscriptions` via ordinary
RLS-governed writes — a single-table write, no RPC needed) and `useNotifications` (hook wrapping
`Notification.permission` + subscription state) back a one-time, dismissible enable-prompt card on
`GuardHome` — that page, not somewhere more general, because it's where a guard actually is around
deadline time, the same reasoning §10.4 gives for the PWA install nudge's placement. **Enable-only,
by deliberate design (v2.19, item 73)**: an earlier header bell-icon toggle could also *disable* a
subscription, and was removed along with the underlying `unsubscribeFromPush()`/`disable()` code
paths, not just the button — these notifications carry real schedule-affecting updates, and no guard
should be able to silence them through the app for any reason. Worth stating precisely: this closes
the in-app path only. It was never possible, and still isn't, for a web app to stop a guard from
disabling notifications for the PWA at the OS/browser level — that control never belonged to this
app and no client-side change could take it away.

**Testing**: Gate G (`supabase/tests/notifications.cloud.test.mjs`) exercises the SQL primitives
directly — RLS on `push_subscriptions`, both targeting functions (explicitly asserting the
`role`-filter fix), the tolerance window, `claim_notification_send()` idempotency, and the two-open-
weeks robustness fix — deliberately without invoking the real Edge Function, which would push real
notifications to Ben's phone on every test run. The push-send path itself (VAPID signing, actual
on-device delivery) was verified live instead: a throwaway, fully isolated test week (a Sunday far
from any real week, so nothing real could be affected) was created with `status = 'open'`, and
`send-notifications` was invoked directly (`curl`, bypassing `notification_tick`) for each type in
turn. All three arrived on Ben's own installed PWA and were confirmed by him before this shipped.

**Click routing (v2.13, item 63)**: the push payload carries a `url` field (`/preferences` for all
three current types — every one of them exists to get a guard to submit, so every one should land
there, not just wherever the app happened to be). `showNotification()` stores it in the
notification's own `data`, and `notificationclick` reads it back: if a tab is already open it's
navigated there via `WindowClient.navigate()` rather than just focused in place, and if none is
open `clients.openWindow(url)` opens straight to it. Carried in the payload rather than hardcoded in
the service worker so a future notification type (e.g. a roster-published push, which would
sensibly point at the roster instead) needs no new client-side branch.

### 12.11 Passkey / Biometric Login (migration 46, `webauthn` Edge Function, v2.16–2.18)

Optional Face ID / fingerprint login, **additive and never a lockout** — badge code + PIN always
keeps working regardless of whether a guard ever sets this up.

**The design changed once while building this, for a reason worth recording plainly.** v2.16
shipped first on `@supabase/supabase-js`'s native, experimental Passkey API
(`registerPasskey()`/`signInWithPasskey()`, `auth.experimental.passkey: true`) — GoTrue runs the
whole WebAuthn ceremony and stores the credential itself, so this needed zero new migrations and
zero new Edge Functions. Real-device testing the same day showed what that API actually produces: a
true, **discoverable, OS-synced passkey**, visible in the phone's system "Passwords & passkeys" list
and eligible to sync to the guard's Google/Apple account. That's a materially different trust
boundary than "unlocks this app on this phone" — WebAuthn supports the narrower one directly
(`residentKey: 'discouraged'` at registration produces a non-resident credential that neither syncs
nor is offered through the OS account-picker UI), but Supabase's native Passkey API doesn't expose
that option; it's deliberately built only for true discoverable passkeys. **v2.16's mechanism was
replaced wholesale, same day**, with a from-scratch implementation: `@simplewebauthn/browser`
client-side, `@simplewebauthn/server` in a new `webauthn` Edge Function, credentials stored in
`webauthn_credentials`/`webauthn_challenges` (migration 46, §6.2) instead of GoTrue's own store —
undoing the "zero backend code" property that was always the trade-off of the native API in the
first place. **Known, confirmed platform limit, not a bug**: Android honours
`residentKey: 'discouraged'` and never syncs the credential; Apple's platform authenticator can
still create a synced iCloud Keychain passkey even when asked for `discouraged` — "never synced" is
a strong guarantee on Android and only a best-effort one on iPhone.

**The `webauthn` Edge Function**, one function with four actions via an `action` field (same shape
as `claim-code`'s `status`/`claim` split), deployed `--no-verify-jwt` since `auth-options`/
`auth-verify` have no session by definition — that's what they're establishing:

```
register-options  (needs the caller's own JWT) -> generateRegistrationOptions(), residentKey:
                   'discouraged', excludeCredentials from the caller's existing rows
register-verify   (needs the caller's own JWT) -> verifyRegistrationResponse(), INSERT into
                   webauthn_credentials
auth-options      (no session -- body carries a client-supplied guard_id hint)
                   -> generateAuthenticationOptions() scoped to that guard's stored credential IDs
auth-verify       (no session) -> verifyAuthenticationResponse() against the stored public key,
                   then mints a real session
```

`register-*` resolve the caller's own `guard_id` from their own JWT using the exact `asCaller` +
`getUser(token)` pattern §12.10 already established for `guard_submitted`/`guard_cancelled` — and
the exact lesson v2.15.1 had to learn the hard way: `getUser()` needs its token passed explicitly,
unlike `.rpc()`/`.from()`, which pick up the global `Authorization` header on their own.

**A non-discoverable credential loses the "no username needed" property true passkeys have** — the
server must already know which credential to challenge before the ceremony starts, since the browser
can no longer show a blind "pick your passkey" picker. Solved with a local-only device flag,
`wo.webauthnGuardId`, set after a successful registration on that specific device: sent to
`auth-options` as a plain **hint**, never a trust boundary — the actual authorization is the
cryptographic signature `verifyAuthenticationResponse()` checks against that exact guard's stored
public key, so a forged `guard_id` does nothing without the matching physical authenticator.

**RP ID/origin are a hardcoded allowlist inside the function itself**, keyed off the request's
`Origin` header — the production origin, and `http://localhost:5173` as a second, entirely separate
RP for local dev testing (a credential registered under one simply doesn't verify under the other,
correct WebAuthn behaviour, so the dev entry is a disposable testing lane, not a way to touch
production credentials from a dev machine). This is a real improvement over the native API's one
RP-ID-per-Supabase-project constraint, and only possible because this function owns the whole
ceremony now.

**A successful `auth-verify` mints a real Supabase session with no password involved**:
`admin.getUserById(guard_id)` for their (synthetic, non-routable) email, then
`admin.generateLink({ type: 'magiclink' })` — which does **not** send any mail, it only returns a
token — immediately exchanged server-side via a plain anon-key client's
`verifyOtp({ token_hash, type: 'magiclink' })` for a real `{ session }`. Only its access/refresh
tokens are returned to the browser, which installs them with `supabase.auth.setSession()`.

**App-restart lock gate, with a 24-hour grace window.** A device with a registered passkey is meant
to re-verify on a fresh app load rather than silently resuming — but every JS boot, including a
plain browser refresh, looks identical to `AuthContext`'s bootstrap effect; there is no lighter-
weight signal for "genuine reopen after time away" than "same session, page just reloaded." Gating
on literal every boot (v2.16's original shipped behaviour) re-prompted on every refresh. Fixed with
`wo.webauthnUnlockedAt` (`src/lib/supabase.ts`): the gate is skipped whenever a real ceremony
succeeded within the last 24 hours, and shown otherwise — deliberately **only** ever set by an
actual biometric verification, never extended by a mere silent resume, or a device opened once a day
would never need to re-verify at all, defeating the point of gating it. 24h chosen over a 7-day or
"only on session loss" alternative, weighing routine daily use against how long a lost/stolen phone
would stay unlockable on the persisted session alone. **The gate itself has no separate "locked"
screen** — v2.16 shipped one, and it was dropped the same week for feeling inconsistent with the
rest of the app: an expired window now performs a plain, **local-only** sign-out
(`supabase.auth.signOut({ scope: 'local' })`) and lands on the ordinary Login page every signed-out
guard already sees. `scope: 'local'` matters — an automatic, per-device timeout must never revoke a
session this guard has active on another device just because one phone's window lapsed.

**Frontend UX, reworked once after the first ship.** v2.16 put passkey management (list, rename,
remove) on a Preferences card, alongside the remember-me toggle described below. Ben's review after
using it for real changed both: nobody needs to *delete* a passkey (it's set-and-forget, not
something guards manage day to day), so that whole card was dropped; and remember-me belongs where
almost every app puts it — under the personal PIN on the Login page itself, not tucked into
settings. What replaced the management card is a **hybrid passkey button** on Login, matching the
"sign in with biometrics or set one up" pattern most consumer apps with passkey login use: a purely
local, instant check for whether this device already has a credential (`getPasskeyGuardId()`). If
yes, the button runs the real sign-in ceremony. If not, it falls through to an ordinary badge-code +
PIN login and the registration ceremony fires automatically right after — directly from the
PIN-submit handler, in the very same click's async chain, not deferred to a later screen/tap, since
`navigator.credentials.create()` needs to run reasonably close to a genuine user gesture or the
browser silently refuses it. A dismissible, one-time nudge card on `GuardHome` (same established
pattern as §12.10's notification enable-prompt) remains as the passive fallback for a guard who logs
in normally without ever touching the passkey button, and as the safety net if the automatic
ceremony above is cancelled or the browser declines it. `CodeInput` gained an imperative
`forwardRef`/`useImperativeHandle` `focus()` for the same reason: a mount-time `autoFocus` doesn't
refire on a re-render, and mobile browsers mostly ignore it outside a real user gesture anyway, so
the passkey button's no-credential branch calls it directly to pop the keyboard.

**Remember-me** (`src/lib/supabase.ts`) makes the persistence badge-code login already had
implicitly (`persistSession: true`, always on, no toggle before this) explicit and reversible: a
`wo.rememberMe` flag, default **on** so no guard's existing behaviour changes unless they opt out,
drives a custom switchable storage adapter that delegates each read/write to `localStorage` or
`sessionStorage` depending on the flag *at the time of that call*. On the Login page, flipping the
toggle calls `setRememberMe()` immediately, before the guard even submits — since the adapter only
consults the flag at the moment a session is actually written, the very next successful login
already lands in the correct storage with no separate "apply after login" step needed.

**Testing — Gate H** (`npm run test:webauthn`, `supabase/tests/webauthn.cloud.test.mjs`, 22
assertions): RLS on both new tables (an owner reads/renames/deletes only their own row; a different
guard gets nothing; a manager can read any row; a direct client `INSERT` is rejected outright — no
grant exists, only the Edge Function's service-role client may ever create one; `webauthn_challenges`
is completely unreachable via PostgREST regardless of role), and the Edge Function's auth/
verification paths — missing/malformed caller JWT, an origin outside the allowlist, a `guard_id`
with no credentials, a malformed `guard_id`, a bogus credential response rejected cleanly (400, not
a crash) on both `register-verify` and `auth-verify`, and proof a consumed challenge cannot be
replayed. Same deliberate scope as Gate G never invoking `send-notifications` for a real push: a
genuine end-to-end ceremony still needs a physical authenticator or a browser's virtual-authenticator
API, neither of which this suite uses — what IS exercised for real is
`generateRegistrationOptions()`/`generateAuthenticationOptions()` actually running against the live
Deno Edge Function runtime, which doubles as the "confirm a new runtime dependency actually works
before trusting it" smoke test §12.10 set the precedent for with `npm:web-push`.

### 12.12 Self-Service Forgot-PIN — Attempted and Reverted (migrations 48–51, v2.21.0–v2.22.1)

> **REVERTED in v2.22.1.** Everything below this notice describes a feature that shipped, in two
> different designs, and was then **fully reverted** — kept here as a historical record (the same
> "explain the pivot, don't erase it" discipline §12.11's account of the passkey rebuild already
> follows), not as a description of current behavior. **The current, actual state**: the Login
> page's `'pin'` step is back to exactly what it was before either attempt — a "החלפת קוד עובד" link
> that resets local state back to the code-entry step, and the manager-mediated `reset-pin` (§12.4)
> is once again the **only** recovery path for a guard who forgot her PIN.
>
> **Why it was reverted**: after the second design (push-notification delivery, v2.22.0) shipped, a
> session-persistence regression appeared in production — every page refresh, on every device
> (confirmed on one **with** a registered passkey and one **without**), signed Ben back out to the
> Login page, even with "remember me" on and a fresh login moments earlier. A full diff of every file
> touched since the last confirmed-stable point (the manager-only `reset-pin` tool, v2.20.2) showed
> nothing touching session storage, the Supabase client config, or the passkey ceremony at all — the
> passkey re-verification gate (§12.11) was directly ruled out by the no-passkey-device reproduction,
> and the Vercel deployment/environment/bundle were all confirmed healthy and current. **No root
> cause was conclusively identified.** Rather than keep debugging a live regression against an
> unconfirmed cause, Ben's call: revert the whole feature back to the last confirmed-stable point and
> revisit self-service PIN recovery later, in isolation, if at all. Migrations 48–50 were **not**
> deleted or rewritten — they genuinely ran against the live database, and this project's own
> discipline is that migrations are discovered, never edited after the fact. Migration 51 reverses
> their net effect (drops `pin_reset_otps`, un-widens the two `CHECK` constraints migrations 49/50
> touched) the same way any other unwanted schema change gets undone: with a new migration on top.
> `phone_number` needed no further reversal — migration 50 had already fully reverted it (columns,
> trigger, view) during the WhatsApp→push pivot, before this regression was even found.
>
> **Worth carrying forward if this is attempted a third time**: build and test it on a branch/preview
> deployment rather than shipping straight to production main, specifically so a regression like this
> one can be bisected against a controlled set of changes instead of a live session nobody can safely
> keep debugging in place.

Replaces a dead button. The Login page's `'pin'` step (existing-PIN entry) used to carry a
"החלפת קוד עובד" link that did nothing but reset local state back to the code-entry step — a guard
who genuinely forgot her PIN had no real recovery path, only the manager-mediated `reset-pin`
(§12.4) once the manager noticed or was told. That fallback **still exists, permanently** — for any
guard whose device has no live push subscription. This section adds a genuine self-service path for
guards who do.

**Design changed mid-build, for a reason worth recording plainly — the same discipline §12.11's own
account of its native-Passkey-API pivot follows.** The original plan (v2.21.0, migrations 48–49)
delivered the OTP via Meta's WhatsApp Business Cloud API, which needed a `phone_number` added to the
schema for the first time and a new `whatsapp-pin-reset` Edge Function. Before any real message was
ever sent — `WHATSAPP_*` secrets were never configured — Ben discovered his Meta account is
restricted from Ads over a disputed fraudulent charge from years earlier. Meta requires a Business
Portfolio to attach a WhatsApp Business Account to an app at all, with **no way around it**:
confirmed directly, "Create an app without a use case" does not avoid the requirement either, since a
WhatsApp Business Account is fundamentally a Business Portfolio asset, not an artifact of which
onboarding wizard was used. Rather than wait on an account dispute or stand up a new Business
Portfolio under a different admin, **Ben's call (v2.22.0)**: deliver the OTP through this app's OWN
already-working push notification system (`send-notifications`, §12.10) instead — no new external
account, no new dependency, reuses infrastructure already live in production. `phone_number`
(migration 48) is fully reverted (migration 50) — nothing else in the project ever used it, so there
was nothing else to preserve. The OTP mechanics themselves — `pin_reset_otps`'s hash/attempts/
expiry/`verify_token` shape, `claim_attempts`' widened `'otp_request'` action (migration 49) — are
**unchanged**; only the delivery channel moved.

**The one real trade-off versus the WhatsApp design, worth stating plainly**: delivery now needs an
**existing `push_subscriptions` row** for the guard, which itself needs a prior login on that same
device with notifications enabled — a phone number works regardless of app state or device, a push
subscription doesn't. In practice this is rarely a gap: every real guard already uses this app weekly
and is nudged to enable notifications early (`GuardHome`'s enable-prompt card), and a forgotten-PIN
guard is overwhelmingly trying to log back into the same device she always uses. A guard with no
subscription anywhere, or on an unfamiliar device, gets a clean error routing her to the manager's
`reset-pin` fallback instead — the same two-tier shape (self-service primary, manager fallback for
the rest) the WhatsApp design already had for "no phone on file," just with a different coverage
boundary.

**The `request-pin-reset` Edge Function** (renamed from `whatsapp-pin-reset` in the same pivot), a
new file rather than a third+ action bolted onto `claim-code` — that function's own docstring treats
it as hostile-input territory, changed "as rarely as possible," and this is a categorically bigger
addition (a 3-call stateful sequence, a new table) than anything added to it since it was written. It
doesn't fit `reset-pin` either — that function's authorization is `is_manager()` via a caller JWT;
this one has no caller identity at all, authorization comes from proving OTP possession instead.
Deployed `--no-verify-jwt`, same posture as `claim-code` (the guard has no session at this point) —
this is now the **second** publicly-reachable unauthenticated write path in the system, written on
the identical "assume the caller is hostile" footing:

```
otp_request  (no session) -- resolves the guard's id from a CLAIMED employee_code, confirms at
             least one push_subscriptions row exists (else a clean 404), generates a 6-digit OTP,
             stores its SHA-256 hash, then calls send-notifications SERVER-TO-SERVER (the exact
             cron-secret mechanism notification_tick already uses -- reads notify_url/cron_secret
             from notification_secrets, migration 42) with the new pin_reset_otp type. If nothing
             actually delivered (sent < 1 -- e.g. a subscription exists but is dead), the OTP row
             is deleted and a clean error returned rather than a false "ok". Rate-limited via
             claim_rate_ok()/record_claim_attempt() (migration 4), widened by migration 49 to
             also cover 'otp_request' -- reused completely unmodified (the auto-disable logic
             those functions once had was already removed project-wide by migration 6, so
             there's no risk of a failed send locking anyone's badge code).
otp_verify   (no session) -- checks a 6-digit guess against the stored hash. 5 wrong guesses
             kills that specific code (a per-row counter, not the rolling claim_attempts
             window -- a different job: gating brute-force guesses on one live code needs a tight
             per-code cap, not a shared per-(code,ip) throttle meant to gate how often a send can
             be triggered at all). A correct guess mints a one-time verify_token. Unchanged from
             the WhatsApp-era design -- this action never cared how the code was delivered.
otp_complete (no session) -- requires a verify_token from a successful otp_verify, resets the
             password on the guard's EXISTING auth.users row via
             admin.auth.admin.updateUserById() -- the same call reset-pin already makes,
             duplicated here rather than cross-invoked, since the two functions have incompatible
             auth models and every function in this project already builds its own admin client
             from scratch. Consumes (deletes) the OTP row on success -- single use. Unchanged from
             the WhatsApp-era design.
```

**`pin_reset_otps`** (migration 49, untouched by the pivot) follows the exact "fully sealed" shape
`webauthn_challenges` (migration 46) and `notification_secrets` (migration 42) already use: RLS on,
**zero** policies, `REVOKE ALL` from every PostgREST role — completely unreachable via the API
regardless of role, only the Edge Function's service-role client can ever touch it. No `consumed_at`
column, for the same reason `webauthn_challenges` has none — a row is deleted the instant it's
consumed or superseded (a fresh `otp_request` for the same code deletes any prior live row first, so
"at most one live OTP per code" holds without a partial unique index).

**`send-notifications` gains a fourth cron-secret-only type**, `pin_reset_otp` (migration 50) —
unlike `roster_published`/`guard_submitted`/`guard_cancelled`, this one has **no JWT auth path at
all**, only the original three cron types' shape: the only legitimate caller is `request-pin-reset`'s
`otp_request` action, which itself runs with no caller session to check against. `guard_id` in the
payload is trusted precisely *because* only a holder of the cron secret can reach this branch — the
same discipline `notification_tick`'s own three types already rely on. Targets a single, already-
resolved `guard_id` directly rather than a `_targets()` RPC (every other type's recipient set is a
role/subscription query; this one's recipient is already known). Not deduped — each request is a
genuine, distinct event, same as `guard_submitted`/`guard_cancelled`. The plaintext OTP is
deliberately **never** written into `notification_log.detail` — it already lives, hashed, in
`pin_reset_otps`; there's no reason for the plaintext to also sit in an audit log a manager can read.

**Login.tsx**: three new steps chained from `'pin'` — `'otpVerify'` (enter the code, unmasked
`CodeInput` since the guard is reading it off a notification rather than recalling a memorized
secret, a "שלח שוב" resend with a 30s client-side cooldown as a UX nicety on top of the real
server-side throttle) and `'otpNewPin'` (choose a new PIN, exactly `'setPin'`'s shape — factored into
a shared internal `PinChooser` component used by both, since the surrounding heading/copy/submit-
button/back-link genuinely differ between "first registration" and "post-OTP reset" but the two-
`CodeInput`-plus-remember-me block underneath doesn't). `'pin'`'s old bottom-of-card "החלפת קוד עובד"
ghost button is gone, split into two distinct, honest actions instead of one that conflated them: a
small "→ קוד אחר" back-link moved to the **top** of the step (for "this isn't my code, let me
retype it"), and a real, primary-adjacent "שכחתי סיסמה" button (for "this is my code, I forgot the
PIN") that fires `requestPinResetOtp` immediately on tap — no separate confirm screen — and
transitions straight to `'otpVerify'`. `completePinResetOtp` signs the guard in immediately on
success (`signIn()` internally, same sequence `claim()` already follows for first-time
registration), so a successful reset lands on the signed-in home screen, not back at a bare login
prompt. The `'setPin'` step's identical dead button is untouched — a genuinely different concern (a
not-yet-claimed code has no PIN to forget), out of scope here. None of this layer changed across the
WhatsApp→push pivot — the guard-facing flow was always delivery-channel-agnostic by construction.

**Shared `invokeEdgeFunction()`** (`src/lib/edgeFunctions.ts`) — `invokeClaimCode` (`AuthContext.tsx`)
and `invokeResetPin` (`useTeam.ts`) were already near-identical ~15-line copies of the same
non-2xx-error-unwrapping logic (`supabase-js` reports any Edge Function error generically and hides
the function's own Hebrew message unless the response body is read back out of `error.context`
explicitly). Adding a third near-copy for this feature would have tripled it; extracted into one
shared helper instead, all three call sites now use it.

**Testing — Gate I** (`npm run test:pinreset`, `supabase/tests/request-pin-reset.cloud.test.mjs`, 23
assertions). Same deliberate scope as Gate G never invoking `send-notifications` for a real
broadcast, and Gate H seeding a `webauthn_credentials` row directly rather than running a real
ceremony: a real push to a REAL subscribed device must never fire inside a repeatable `test:cloud`
run. `otp_verify`/`otp_complete` are exercised for real by seeding a `pin_reset_otps` row directly
via SQL with a known OTP's SHA-256 hash (correct code accepted and mints a token; 5 wrong guesses
locks the code out, a 6th correct guess still rejected; an expired row rejected; a successful
`otp_complete` proven by the OLD PIN failing sign-in and the NEW PIN succeeding, mirroring the
before/after proof used to manually verify `reset-pin`; a replayed, already-consumed `verify_token`
rejected). `otp_request` is exercised for real on **two** paths that never reach a real device: a
claimed guard with zero subscriptions (clean 404), and a claimed guard with a deliberately bogus
subscription (endpoint/keys matching no real device) — `send-notifications` genuinely attempts
delivery and genuinely fails, and the suite asserts `otp_request` surfaces that failure honestly (502)
rather than a false "ok," and cleans up the now-useless OTP row rather than leaving it dangling. RLS:
`pin_reset_otps` fully sealed (`42501 permission denied`, not just an empty result — there's no grant
for RLS to even evaluate against). `claim_attempts.action`'s widened CHECK accepts `'otp_request'`.
`notification_log` accepts `pin_reset_otp` and never carries the plaintext code.

**Not automated, by design, same as Gate G's real-push gap**: an actual push arriving on a real,
currently-subscribed device. Needs confirming by hand once — the same class of real-device-only check
push notifications (§12.10) and passkey ceremonies (§12.11) each needed — but is otherwise much
lower-risk to verify than the WhatsApp design was, since it costs nothing and pages only whichever
test account is used, not a real Meta billing relationship.

---

### 12.13 Afternoon Segment Shifts (migration 53, v2.24.0, §1.26)

The afternoon block (14:45-22:45) is really two coverage segments, S2 (early, 14:45-18:45) and S3
(late, 18:45-22:45) — §2.3. Until this version the only way to occupy just one manually was a 12h
`day12`/`night12` shift, whose morning/night half is a real, unavoidable commitment; the full 8h
`afternoon` shift always covers both halves at once, with no way to scope it down. A manager
sometimes just needs one specific person in S2 or S3 alone — covering for someone's late arrival or
early departure — without either overstating what they're actually working or dragging in a shift
they didn't ask for.

**Two new shift types**, `afternoon_early` (covers S2 only) and `afternoon_late` (covers S3 only),
added to the shift catalogue (`src/lib/shifts.ts`) exactly like the original five — `startH`/`endH`
set to the exact S2/S3 clock boundaries, `requiresBase: 'afternoon'` (guards only ever mark
availability by base shift, never by segment, so this is the same base slot the full `afternoon`
shift already requires), `isExtended: false` (4h, shorter than normal rather than longer, so no 12h
opt-in check applies — §3.3). Reuses `afternoon`'s own colour and `SEGMENT_DEFS`' S2/S3 Hebrew copy
rather than introducing new ones.

**Manual-edit only, deliberately** — same status as a placeholder row (§12.9): never produced by
either engine. This mattered more than expected. Coverage counting
(`coverageBySegment`/`covers()`/`realCount`), rest-hour classification (`restHours`/`classifyRest`/
`REST_MATRIX`, all *derived* from each shift's clock times, per §2.6), and eligibility (`isEligible`)
are already generic over the shift catalogue rather than hardcoded to five values, so extending the
catalogue was enough on its own for those — no new rule code anywhere. But `mockSolver.ts`'s
candidate-move search is *also* generic over the same catalogue, and nothing had excluded manual-only
types from it — the moment the two new shift types existed, the mock solver started proposing them
on its own during automatic generation (caught by a changed golden-fixture assignment count before a
dedicated test even existed for it). Fixed with a new `SOLVER_SHIFT_TYPES` constant — the original
five shift types only, mirroring `solver/models.py`'s own independent, hand-maintained list, which
was never at risk since it has no notion of the new types at all — swapped into both of
`mockSolver.ts`'s candidate-enumeration sites. Confirmed via `npm run test:compare`: exact mock/CP-SAT
parity restored on every fixture.

**Schema**: migration 53 is two bare `ALTER TYPE shift_type ADD VALUE` statements and nothing else —
the first time this enum (unchanged since migration 1) has ever been extended. `save_run_assignments`
already casts the shift value generically (`(e->>'shift')::shift_type`) with no hardcoded literals, so
it needed no change; the two values just had to exist. Kept to its own migration file on purpose:
Postgres forbids using a newly-added enum value inside the same transaction that added it, and this
project's `db:apply` runs one transaction per migration file.

**Editor UI**: `RosterEditor.tsx`'s afternoon block widens its shift `<select>` options (both the
per-row editor, which already iterated the full shift catalogue, and the "הוספת מאבטח" add panel,
which needed its own array widened) to include "צהריים מוקדם"/"צהריים מאוחר" alongside the existing
"צהריים." No new control beyond that — which sector(s) a row covers is just which shift type is
selected, the same axis the morning/night blocks already use for `day12`/`night12`. Composes with
`occupies_slot` (§12.9) for free: a placeholder row set to `afternoon_early` with the box checked
counts toward S2 alone, with no guard identity behind it — exactly the "placeholder into only one
sector" case that motivated the feature.

**Read-only rendering**: `RosterGrid.tsx`'s `buildAfternoonRows()` and `exportRoster.ts`'s `rowsFor()`
already pair an "early half" and a "late half" into one handover row for `day12`/`night12` (§10.1) —
widening their `early`/`late` filters to also match the two new types makes that existing
pairing/rendering machinery handle them automatically, rendered as "name / –" (a lone half) or
"name / name" (two halves), with no 12h boundary-time suffix (not extended shifts, nothing ambiguous
about their hours to annotate — the same reasoning §12.9's afternoon-slash convention already
established). One real bug caught while widening `exportRoster.ts`: its handover-row constructor had
a latent hardcoded `shift: 'day12'`/`'night12'` literal (harmless while only those two values ever
reached it) instead of the row's own `.shift` — fixed, since the canvas colour lookup
(`colors[row.early.shift]`) needs the real value to resolve correctly for a genuine
`afternoon_early`/`afternoon_late` row.

**Testing**: neither type can ever appear in a golden-fixture engine output (manual-edit only, same
as a placeholder), so `solver/tests/run-fixtures.mjs` gained referee-only checks alongside the
placeholder ones (§12.9) — hand-built `SolverOutput`s proving segment isolation (an `afternoon_late`
assignment counts toward S3, leaves S2 untouched) and correct rest-hour derivation against an
adjacent day. New Gate E (edit) assertions in `edit.cloud.test.mjs` cover persistence of both types
together in one cell and confirm the same guard still cannot hold both halves of one day (the
`one_shift_per_guard_per_day` index is keyed by guard + date, not by shift, so it collides regardless
of which two distinct shift values are involved).

---

## 13. OPEN ITEMS

| #   | Item                                                                                                                                          | Status / default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2-level preference strength (`יכול` / `עדיפות`)                                                                                               | **Implemented, v2.4** (migration 31) — §3.8. Weight (2) measured against live data, not assumed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2   | `night → next-day afternoon` is legal at exactly 8h rest                                                                                      | Allowed with −5 penalty, per §2.6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3   | `day12 → day12` on consecutive days is unpenalised (12h rest)                                                                                 | Allowed; bounded only by the 5-shift ceiling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 4   | Fairness / rotation of weekend and night shifts across guards                                                                                 | Not modelled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | Public holidays                                                                                                                               | Treated as ordinary days                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | **Should availability be soft?** (§3.2)                                                                                                       | **Decided (8 August): stays hard.** On the one real dataset tested, CP-SAT hit zero floor breaches without a soft fallback — insurance against a scenario that hasn't materialized, not a fix for an observed one. No code change.                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7   | Posts (סריקה / בוטקה / בקרה / שמירה)                                                                                                          | **Dropped at Ben's request.** The column itself was later dropped too (migration 23) — nothing had read or written it since the feature was cut                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8   | `pg_cron` for the week sweep                                                                                                                  | Not configured; the sweep runs on app load (§12.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 9   | Tiered כמות penalty — discount a flex-tier guard's (כמות 3–4) _last_ missing shift so the solver favours closing target-coverage gaps over it | **Investigated (8 August), rejected — structurally a no-op.** Implemented across both engines and both referees, then tested against a hand-built adversarial scenario and the real live dataset: identical objective, identical assignments, flex-tier or not. Cause: H6 (§4.1, never over-staff a segment) already guarantees every legal placement either closes a real coverage gap or is blocked outright — there is no such thing as a placement that only satisfies כמות with zero coverage value for this discount to ever usefully trade away. Reverted in full; not worth re-investigating unless the hard-constraint set changes. |
| 10  | Guard-requested shift count (§3.10) — let a guard state a preferred count for the week, separate from מנהל-configured כמות                    | **Implemented, v2.7** (migration 33) — §3.10. Below-configured guaranteed via a per-guard H4 ceiling; above-configured a measured, zero-harm soft bonus; the 5→6 exception for guards already at the ordinary ceiling shipped as an explicit phased follow-up, per Ben's request                                                                                                                                                                                                                                                                                                                                                             |
| 11  | Passkey real-device confirmation (§8, §12.11) — registering on a real iPhone/Android from the Login page's hybrid button, confirming the credential does *not* appear in the phone's system Passwords & passkeys list, and confirming the restart-lock gate's unlock and 24h grace window behave as designed | **Open.** Everything checkable without a physical device (Gates A/H, typecheck) is covered; the ceremony itself, and the negative check that it's genuinely non-syncing, need a real phone — same class of gap as items in §14.3 for the PWA install and push notifications |

---

## 14. BUILD STATUS AND ROADMAP

### 14.1 What is built

| Step      | Scope                                                                                                                                                                                                                                                                                                                                                                                                               | State                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **A**     | Schema, RLS, seed, helper functions                                                                                                                                                                                                                                                                                                                                                                                 | ✅ complete                                                    |
| **B**     | Badge-code + PIN auth, `claim-code` Edge Function                                                                                                                                                                                                                                                                                                                                                                   | ✅ complete, deployed                                          |
| **C**     | Guard preference submission, atomic save RPC                                                                                                                                                                                                                                                                                                                                                                        | ✅ complete                                                    |
| **D**     | Manager dashboard: week controls, coverage matrix, כמות editor                                                                                                                                                                                                                                                                                                                                                      | ✅ complete                                                    |
| **E**     | Solver contract, twin referees, mock + CP-SAT, generate → publish                                                                                                                                                                                                                                                                                                                                                   | ✅ complete; **CP-SAT deployed**                               |
| **F1–F5** | Fine-tuning batch (per-day 12h, week lifecycle, Mon–Fri target, archive, US week)                                                                                                                                                                                                                                                                                                                                   | ✅ complete                                                    |
| **G**     | Manual grid editing, editable/deletable published rosters, Realtime both directions, shared grid, measured columns, image export, free-text submission notes (§3.6), per-guard default כמות (§2.7)                                                                                                                                                                                                                  | ✅ complete                                                    |
| **H**     | Team management: add/delete employees (real deletion, not deactivation), edit default כמות (§12.4)                                                                                                                                                                                                                                                                                                                  | ✅ complete                                                    |
| **I**     | Manager dashboard defaults to next week; configurable submission window (§12.5); short-staffed dash convention (§10.1)                                                                                                                                                                                                                                                                                              | ✅ complete                                                    |
| **J**     | Cleanup pass: dropped the dead `schedule_assignments.post` column (migration 23); fixed `seed.sql` re-seeding a deleted employee on every `db:apply`; removed the two never-hired placeholder codes; this document brought back in sync with the code                                                                                                                                                               | ✅ complete                                                    |
| **K**     | Deployed to Vercel (§11.2); admin week cursor + orphaned-week sweep fix (§12.1); guard can cancel a submission outright (§3.7); mobile layout fixes (SPA rewrite, viewport overflow, `AppShell` flex-shell restructure); guard-facing copy/UI polish                                                                                                                                                                | ✅ complete                                                    |
| **L**     | Two-level preference strength (§3.8, migration 31); coverage gaps weighted by segment length, not a flat per-slot count (§4.2a) — built on separate branches, merged, deployed to Render together                                                                                                                                                                                                                   | ✅ complete                                                    |
| **M**     | Guard preference-form polish: עדיפות chip only shown with 2+ marked shifts and capped at N−1 preferred (§3.8); manager-configured כמות dropped from the guard-facing summary in favour of a rest-rule-aware feasible-shifts estimate (§3.9)                                                                                                                                                                         | ✅ complete                                                    |
| **N**     | Manager preference detail view + edit-on-behalf-of window (§12.7); submission confirmation modal (§3.11); dark mode, system-synced with a manual override, colours softened in two follow-up passes (§10.3)                                                                                                                                                                                                         | ✅ complete                                                    |
| **O**     | Guard-requested shift count, phased in two parts: general below/above-configured mechanism, then the 5→6 exception (§3.10, migration 33); two production bugs found and fixed along the way (the lower-request guarantee, and the feasible-shifts UI cap)                                                                                                                                                           | ✅ complete                                                    |
| **P**     | Per-day morning target override (§2.4b, migration 35); morning-priority coverage weight (§4.2b); roster view stacks every published week instead of a selector (§10.0a); admin real/test view-mode toggle (§12.8, migration 34); fixed a live `ensure_roster_weeks()` realtime feedback loop found while testing this batch (migration 36)                                                                          | ✅ complete                                                    |
| **Q**     | PWA support (§10.4): web app manifest, minimal no-cache service worker, full icon set generated from supplied artwork, `vercel.json` static-asset headers; `GitVersion.yml` introduced for version tracking / rollback (repo root, kept in step with `package.json`'s `version` and a `vX.Y.Z` git tag per release)                                                                                                 | ✅ complete; real-device Android/iOS install check pending Ben |
| **R**     | Per-day secondary segment target override (§2.4c, migration 37): generalizes Step P's morning-only per-day override to S2/S3/S4, any day of the week, lowered to 1; new floor-pinning rule (`min(1, target)`) so an overridden target of 1 is never misreported as a floor breach                                                                                                                                   | ✅ complete                                                    |
| **S**     | Free-text assignment notes (§12.9, migrations 38–39): a manager annotation before and/or after a guard's name on one manually-edited cell, threaded through `RosterEditor`, `RosterGrid`, and the JPEG export; solver-blind, manual-edit only. Migration 39 adds placeholder (guard-less) rows for a note that isn't about any one guard's own shift, excluded from every hard-rule check and all coverage counting | ✅ complete                                                    |
| **T**     | Push notifications (§12.10, migrations 40–42): a fixed weekly broadcast plus two deadline-relative reminders, delivered via Web Push through the PWA's service worker; `send-notifications` Edge Function, first use of `pg_cron`/`pg_net` in this project                                                                                                                                                          | ✅ complete; real-device delivery confirmed by Ben             |
| **U**     | Notification click routing (§12.10, v2.13): tapping any push notification now opens or navigates straight to `/preferences`, carried in the push payload's `url` field rather than hardcoded in the service worker                                                                                                                                                                                                  | ✅ complete; real-device click confirmation pending Ben        |
| **V**     | Manual "roster published" broadcast (§12.10, migrations 43–44, v2.14): manager-gated button, repeatable per week, on a new `roster_published` push type; `send-notifications` gains a manager-JWT auth path scoped to this one type. `publish_roster(p_run_id)` RPC replaces the three non-atomic client writes publish previously did, finally setting `published_at`                                            | ✅ complete; real-device delivery confirmation pending Ben     |
| **W**     | Manager notified on guard submit/edit/cancel (§12.10, migration 45, v2.15): two new push types, client-triggered from `useGuardPortal.ts` rather than a database trigger (so `test:cloud` never pages the real manager), targeting a new role-based `manager_targets()`; `send-notifications` verifies the submission row's actual existence and the caller's own JWT identity server-side before sending. Real-device testing (v2.15.1) caught `asCaller.auth.getUser()` silently failing without an explicit token, fixed and confirmed delivering | ✅ complete; real-device delivery confirmed                    |
| **X**     | Passkey (Face ID / fingerprint) login (§8, §12.11, migration 46, v2.16–2.18): shipped first on Supabase Auth's native Passkey API, replaced same-day with an app-scoped `@simplewebauthn/*` implementation (own `webauthn` Edge Function + two new tables) after real-device testing showed the native API produced a synced OS passkey, not the device-only credential intended. App-restart lock gate with a 24h grace window (no separate "locked" screen — dropped after shipping one), a Login-page remember-me toggle, and a hybrid passkey button (signs in directly or falls through to badge+PIN then auto-registers) rounded out the UX after two more real-device review passes | ✅ complete; real-device confirmation pending Ben (§13 item 11) |
| **Y**     | Removed the ability to mute/disable push notifications in-app (§12.10, v2.19, item 73): the header bell-icon toggle and the `disable`/`unsubscribeFromPush()` code paths behind it are gone, not just hidden — `GuardHome`'s existing enable-prompt card is the only in-app control left, and was already enable-only in practice | ✅ complete                                                    |
| **Z**     | Per-week 12h/11h double-shift display setting (§2.4d, migration 47, v2.20, items 74–75): a manager toggle that shortens the day12/night12 handover-boundary TEXT by one hour, purely cosmetic (the shift is still scheduled and counted as 12h everywhere it matters), suppressed on any assignment where that guard is the day's only real coverage of the hour it would shorten away from. Same-day follow-up (v2.20.1, item 76): JPEG preview/download un-gated from published-only runs | ✅ complete                                                    |
| **AA**    | Manager-triggered guard PIN reset (§12.4, `reset-pin` Edge Function, v2.20.2): resets a claimed guard's forgotten PIN in place via the GoTrue admin API, without touching `profiles`/`roster_codes`/roster history — `profiles.id IS auth.users.id` with `ON DELETE CASCADE` rules out a delete-and-re-claim approach. Manager-JWT-gated at both the platform level (deployed without `--no-verify-jwt`) and server-side (`is_manager()`), verified end-to-end against the live project | ✅ complete                                                    |
| **AB**    | Self-service forgot-PIN, phase 1 (§12.12, migrations 48–49, v2.21.0): first shipped on Meta's WhatsApp Business Cloud API, needing `phone_number` added to the schema for the first time. Superseded the same week (v2.22.0, item AB below) after a Meta account restriction was found to block WhatsApp setup entirely — see the revision row directly below for what actually shipped | ✅ superseded, see next row                                    |
| **AB rev.** | Self-service forgot-PIN, phase 2 (§12.12, migrations 49–50, `request-pin-reset`, v2.22.0): `phone_number` fully reverted (nothing else ever used it); delivery moved to a new `pin_reset_otp` push-notification type on the already-live `send-notifications` function instead of Meta. Same 3-action public Edge Function shape (`otp_request`/`otp_verify`/`otp_complete`), same PIN-reset mechanism `reset-pin` already uses, same three new Login.tsx steps replacing the old dead "החלפת קוד עובד" button | ⚠️ shipped, then reverted — see next row                        |
| **AB rev. 2** | **Full revert of Steps AB/AB rev.** (§12.12, migration 51, v2.22.1): a session-persistence regression appeared in production after Step AB rev. shipped, with no root cause pinned down despite a full diff review and device-based elimination of the passkey gate as a cause. `AuthContext.tsx`/`useTeam.ts`/`Login.tsx`/`TeamManagement.tsx`/`send-notifications` restored to their exact Step AA (v2.20.2) state; `request-pin-reset` deleted; migrations 48–50 kept as historical record, migration 51 reverses their net effect. The manager-mediated `reset-pin` (Step AA) is once again the sole PIN-recovery path | ✅ complete, live in production                                 |
| **AC**    | Fixed a stale-past-week leak in the guard-facing roster views (v2.22.2, §1.24): `useVisibleRosters()` was trusting RLS alone to scope published runs to current+next, but the `is_manager()` RLS branch has no date floor at all, by design, for the manager archive — a manager-and-guard account (Ben) inherited the unbounded archive read on their own guard-facing pages. New `guardVisibleWeekFloor()` (`src/lib/dates.ts`) filters client-side; `RosterView.tsx`/`GuardHome.tsx` also stopped mislabelling a genuinely past week as "next week" | ✅ complete                                                    |
| **AD**    | Placeholder rows can optionally occupy a coverage slot (§12.9, migration 52, v2.23.0, §1.25): new `schedule_assignments.occupies_slot`, meaningful only on a `guard_id IS NULL` row (CHECK-enforced), counts a guard-less placeholder toward segment floor/target/ceiling like a real assignment while it stays invisible to every guard-specific rule (H1–H5, H7, קמות). `validate.ts` gained its first `guard_id === null` branch; a new per-row checkbox in `RosterEditor.tsx` drives it | ✅ complete                                                    |
| **AE**    | Afternoon block segment shifts (§12.13, migration 53, v2.24.0, §1.26): two new manual-edit-only shift types, `afternoon_early`/`afternoon_late`, let the roster editor occupy just S2 or just S3 without the full `afternoon` shift or a 12h `day12`/`night12`. One real bug caught and fixed before shipping: `mockSolver.ts`'s candidate search also iterates the shift catalogue generically and started proposing the new manual-only types on its own, fixed with a new `SOLVER_SHIFT_TYPES` constant, confirmed via `test:compare` regaining exact mock/CP-SAT parity | ✅ complete                                                    |

### 14.2 Verification

Thirteen suites, all green. Every gate runs against the live project except the PGlite one. (Gate E
engines now run 16 golden fixtures, not 8 — two added in v2.4: a segment-weight tie-break and a
preference tie-break, both empirically constructed and verified against a hand-patched "flat
weighting" baseline to confirm the tie they test was real before asserting the fix resolves it.
Three more added in v2.7 for the guard-requested shift count (§3.10): a stretch-bonus tie-break
paired with a stretch-vs-rest8 priority check in one fixture, a guard-shift-ceiling fixture proving
a lower request is never exceeded even when coverage would reward breaking it, and a sixth-shift
fixture proving both the grant and its exclusivity to guards configured at exactly 5 in one
scenario. Two more added in v2.8 (§2.4b/§4.2b): a per-day override fixture proving the raised target
actually applies on its overridden days and never leaks onto the days around it, and a
morning-priority tie-break fixture mirroring fixture 9's construction — an otherwise perfectly
symmetric S1-vs-S4 coverage tie, broken only by `WEIGHTS.morning_priority`. One more added in v2.10
(§2.4c): fixture 16 overrides Tuesday's S3 target and Wednesday's S4 target to 1 and asserts both
that the shared `afternoon`/`night` shift type caps correctly on the overridden day while staying at
baseline on unoverridden days, and that no floor breach is reported despite only 1 guard being
assigned — proving the floor-pinning fix actually took effect. No fixture added for v2.11's
assignment notes (§12.9) — the feature is deliberately solver-blind, so its coverage lives entirely
in Gate E (edit) instead: a note round-trip through `save_run_assignments`, the 40-character CHECK
being enforced, the DELETE+INSERT rolling back cleanly when that CHECK rejects the save, a real
guard and an unrelated placeholder coexisting in one cell, two placeholders sharing a day without
colliding, and — the contrast that matters — a genuine second REAL shift for the same guard still
being refused exactly as before. Same reasoning in v2.23.0/v2.24.0 (§12.9's `occupies_slot`, §12.13's
afternoon segment shifts): neither can ever appear in an engine's output, so instead of new JSON
fixtures, `run-fixtures.mjs` gained hand-built **referee-only** checks appended after the fixture
loop — constructing a `SolverOutput` by hand and calling `verifySchedule()` directly to prove
coverage isolation and correct rest-hour derivation for shift/guard combinations no engine would ever
produce.)

Gate D (`manager.cloud.test.mjs`) has a known, pre-existing, date-driven **hazard**, not merely a
flake — worth stating plainly after it cost real data once (2 September 2026): its `setup()` runs
`DELETE FROM roster_weeks WHERE week_start IN (...)` against its dedicated test week
(`2026-09-06`) unconditionally, first thing, before any assertion. That date was chosen as "well
clear of the live weeks" when the test was written, but a hardcoded calendar date does not stay
clear as the calendar advances — by the date above it had become the real, live "next week," and
running `test:cloud` deleted the real guards' submitted preferences and that week's already-generated
draft roster, with no way to recover them (no PITR on this project's plan). The originally-documented
mechanism (`ensure_roster_weeks()`'s sweep-window boundary at `current_week_start() + 28` colliding
with the test's own fixture row, self-resolving past mid-September 2026) is real but was never the
main risk — the test's own `DELETE` against a now-live date is. **Before running Gate D, or
`test:cloud`, confirm `2026-09-06` — and this test's other fixture date, `2026-07-19` — aren't
real live weeks**; more generally, check any cloud test's hardcoded fixture dates against
`roster_weeks` before trusting a "known flake" note at face value, here or elsewhere. The real fix —
computing fixture dates relative to the current date instead of a fixed calendar date, across every
cloud test file that has one — is still open.

Gate A (local) has its own known, permanent caveat since migration 41 (v2.12, §12.10): `pg_cron`
requires a background-worker process PGlite's single-process WASM Postgres can never provide.
Migration 41 wraps its extension creation and cron registration in `DO` blocks that catch that
specific failure and log a `NOTICE` instead of erroring, so every migration still applies cleanly
there and Gate A still tests everything else — it just never actually registers the cron job
locally, which is expected, not a regression.

| Suite             | Command                                                   | Covers                                                                                                                                                           |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate A (local)    | `npm run test:rls`                                        | RLS logic in PGlite, all migrations applied from disk                                                                                                            |
| Gate A (cloud)    | `node supabase/tests/rls.cloud.test.mjs`                  | RLS through real PostgREST + GoTrue JWTs                                                                                                                         |
| Gate B            | `node supabase/tests/auth.cloud.test.mjs`                 | Badge claim, PIN login, rate limiting                                                                                                                            |
| Gate B (client)   | `node supabase/tests/client.cloud.test.mjs`               | The `supabase-js` path the browser runs                                                                                                                          |
| Gate C            | `node supabase/tests/preferences.cloud.test.mjs`          | Persistence, atomicity, deadline, isolation, notes (§3.6), cancelling a submission outright (§3.7), guard-requested shift count round-trip and isolation (§3.10) |
| Gate D            | `node supabase/tests/manager.cloud.test.mjs`              | Week controls, כמות, lock/reopen override                                                                                                                        |
| Gate E (cloud)    | `npm run test:generate`                                   | Generate → verify stored rows → publish                                                                                                                          |
| Gate E (engines)  | `npm run test:fixtures`, `solver/tests/test_scheduler.py` | 16 golden fixtures, both engines, plus referee-only checks (no fixture) for `occupies_slot` and afternoon segment shifts (§12.9, §12.13)                        |
| Gate E (edit)     | `npm run test:edit`                                       | Draft and published-roster editing, deletion, assignment-note round-trip and length cap, placeholder rows coexisting with real ones without collision (§12.9), `occupies_slot` persistence and its real-row CHECK (§12.9), afternoon segment shifts coexisting and the same-guard-both-halves rejection (§12.13) |
| Gate F (realtime) | `npm run test:realtime`                                   | Live push both directions: roster changes to guards, submissions to the manager                                                                                  |
| Gate G            | `npm run test:notifications`                              | push_subscriptions RLS, targeting functions (incl. the role-filter fix), tolerance window, send idempotency, two-open-weeks robustness (§12.10)                  |
| Gate H            | `npm run test:webauthn`                                    | RLS on `webauthn_credentials`/`webauthn_challenges`, the `webauthn` Edge Function's auth/verification rejection paths, and a live smoke test of `generateRegistrationOptions()`/`generateAuthenticationOptions()` against the real Deno runtime (§12.11) |

`npm run test:cloud` chains every cloud suite in this table (rls → auth → client → preferences →
manager → generate → edit → realtime → notifications → webauthn) and stops at the first failure.
`npm run test:compare` asserts CP-SAT never scores below the mock. (Gate I, `test:pinreset`, and its
suite `request-pin-reset.cloud.test.mjs` existed for one version and were removed in the v2.22.1
revert (§14.1, Step AB rev. 2) along with the feature they tested.)

### 14.3 What is left

**Self-service forgot-PIN (§12.12) was attempted twice (v2.21.0 on WhatsApp, v2.22.0 on push
notifications) and fully reverted in v2.22.1** after an unresolved production session-persistence
regression — see §14.1 Step AB rev. 2 and §12.12's revert notice for the full account. The
manager-mediated `reset-pin` (§12.4, Step AA) is the only PIN-recovery path going forward; nothing
about self-service forgot-PIN is open or pending — it is fully removed from the live system, not
paused. If this is attempted a third time, §12.12's closing note has a specific recommendation
(build and test on a branch/preview deployment first, so a future regression can be bisected against
a controlled set of changes rather than live production).

Otherwise nothing blocking. Live in production at `work-organizer-iota.vercel.app`, GitHub
auto-deploy connected, all suites green except Gate D's date hazard (§14.2) — check its fixture
dates against real `roster_weeks` rows before running it, not after. Open item 9
(§13, tiered כמות penalty) was investigated and rejected — not something to revisit unless the
hard-constraint set changes. Open item 1 (2-level preference strength) shipped in v2.4 (§3.8). Open
item 10 (guard-requested shift count) shipped in v2.7 (§3.10), both the general mechanism and the
5→6 exception. Everything else in §13 is either decided or a deliberately deferred design choice,
not a build gap. v2.8's four features (§1.9) were a single requested batch, all shipped together.

**v2.23.0's coverage-occupying placeholders (§12.9) and v2.24.0's afternoon segment shifts
(§12.13) — resolved, not open.** Both are pure roster-editor features with no device-specific
behaviour, verified end-to-end in the browser against a disposable test fixture (created and fully
cleaned up afterward) — the editor, the read-only roster grid, and the JPEG export all confirmed
rendering correctly. Nothing pending on either.

**v2.9's PWA support (§10.4) has one item still open**: real "Add to Home Screen" verification on a
physical Android Chrome device and a physical iOS Safari device. Everything checkable from this
development machine — manifest validity and content-type, service worker registration reaching
`activated`, icon resolution, zero console errors, `vercel.json` not swallowing the new static paths
— has been verified against both `vite preview` and production. What cannot be verified here is the
actual install experience on a real phone (Chrome's own mobile-emulation toolbar only resizes the
viewport; it doesn't reproduce a native install banner or real home-screen icon rendering), so this
stays open until Ben checks it on his own devices.

**v2.12's push notifications (§12.10) — resolved, not open.** Real on-device delivery was the one
thing that couldn't be checked from this development machine; it has since been confirmed live —
`send-notifications` invoked directly for all three notification types against an isolated test
week, all three arrived on Ben's own installed PWA, and he confirmed each one before this closed.

**v2.16–2.18's passkey login (§8, §12.11) has one item still open**, same class of gap as the two
above: everything checkable without a physical authenticator — Gate H's RLS and auth/verification
coverage, the live `generateRegistrationOptions()`/`generateAuthenticationOptions()` smoke test,
full TypeScript typecheck — is green. What can't be checked here is the actual ceremony on a real
iPhone/Android from the Login page's hybrid button, and specifically the negative confirmation that
matters most for this feature: that the resulting credential does **not** show up in the phone's
system Passwords & passkeys / Google Password Manager list, which is the entire reason v2.16's first
cut (Supabase's native Passkey API) was replaced. Android fingerprint login, the restart-lock gate,
and its 24h grace window have been confirmed working by Ben on his own phone during development; the
non-syncing property specifically, and iPhone/Face ID behaviour at all, remain unconfirmed.

One thread from v2.4 is now effectively resolved rather than deferred, and one demo-data note still
stands:

- Whether `configured_kamut` should act as a soft _ceiling_ (discouraging a guard from working past
  it, not just failing to reward it) for **every** guard was left open in v2.4 — the
  segment-weighting fix alone was independently sufficient in the case that raised it, so it was
  never pursued as a general policy. v2.7 (§3.10) answers a narrower, related question instead: a
  guard's own _explicit_ request for fewer shifts now is a real, guaranteed ceiling (the per-guard
  `max_shifts` mechanism, §4.1 H4) — proven safe and tested. Extending that same mechanism to
  `configured_kamut` itself, for every guard, unconditionally, remains a separate, still-undecided
  policy question if it ever comes up again.
- The live demo week (`2026-08-09`) currently carries hand-set עדיפות marks across the whole active
  roster (night preferred over afternoon, afternoon over morning, wherever a guard has both marked
  the same day) — a deliberate sanity-test dataset, not real guard input. Worth knowing before
  reading too much into that week's generated rosters as a preference-satisfaction demo. The same
  caveat applies to any `requested_shifts` values on that week from v2.7 testing (§3.10) — verified
  via a frozen snapshot comparison, not live guard requests.

### 14.4 Local development

```bash
npm run dev              # Vite dev server on :5173
npm run db:apply         # apply pending migrations (ledger-tracked, idempotent)
npm run db:verify        # RLS + reachability audit
npm run seed:testweek    # load a week of guard availability for hands-on testing
npm run preview:week     # read-only: what the mock would produce, writes nothing
npm run preview:cpsat    # the same input through CP-SAT, for comparison
```

Live project: `atojvgyxqdbmhhycdcsa` (eu-central-1). Credentials live in `.env.local`, which is
gitignored. **End of project:** revoke the Supabase personal access token and rotate the database
password — both appear in the development transcript.

---

_Specification v2.24.0 — revised 3 September 2026._
