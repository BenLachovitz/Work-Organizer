# TECHNICAL SPECIFICATION & ARCHITECTURE BLUEPRINT: AUTOMATED SECURITY GUARD SCHEDULER
**Version:** 2.2 (build steps A–J complete; live and in daily use)
**Roster Context:** Flexible team size, 6–12 registered guards, 8 currently active
**Target Roster Week:** Sunday 9 August 2026 – Saturday 15 August 2026
**Document Date:** 8 August 2026

---

## 1. EXECUTIVE SUMMARY

This document specifies the operational rules, database schema, Row-Level Security (RLS) policies, and constraint-programming model for a custom security-guard scheduling application (**סידור אמריקאי**).

Active guards submit weekly availability from their phones, replacing manual WhatsApp coordination. A manager sets a per-week morning capacity target and a per-guard **כמות** (minimum shift target), then triggers a **Google OR-Tools CP-SAT** solver that produces a mathematically optimal, conflict-free draft roster in seconds. The manager audits the draft on a visual grid, hand-edits it where needed, and publishes — pushing the roster to every guard's phone, with a JPEG export for the team's WhatsApp group.

Hosting runs entirely on free tiers: **Vercel** (React frontend), **Supabase** (Postgres + Auth + RLS), and **Render/Railway** (Python solver microservice). Target operating cost: **$0/month**.

### 1.1 Changes in Version 2.0

| # | Change | Rationale |
|---|---|---|
| 1 | Coverage remodelled on **time segments**, not shifts | 12h shifts are a *second partition* of the day, not double shifts |
| 2 | **12h shifts corrected** to 06:45–18:45 and 18:45–06:45, weight = 1 shift | Original v1 text implied 16h back-to-back doubles |
| 3 | Coverage floors & targets made **soft with weighted penalties** | Prevents unexplainable `INFEASIBLE`; 8 guards are structurally under-capacity |
| 4 | **כמות auto-override** to `min(configured, available_days, 5)` | Removes the #1 source of solver infeasibility |
| 5 | **Availability is a hard constraint** | A guard is never scheduled on a slot they did not mark |
| 6 | Rest rules generalised: **<8h hard-blocked · exactly 8h penalised (−5) · ≥12h free** | Replaces the single No-Clopen rule; No-Clopen now derived |
| 7 | **Week-boundary carry-in** from the previous Saturday | Closes the cross-week rest loophole |
| 8 | Posts (סריקה/בוטקה/בקרה/שמירה) **removed from the solver** | Manager assigns manually post-generation |
| 9 | Schema normalised: JSONB targets → relational table; 12h flags → per-week row | Restores the FK integrity that motivated choosing Postgres |
| 10 | RLS rewritten with `SECURITY DEFINER` helpers | v1 policies were self-blocking and left one table fully open |
| 11 | Auth = **6-digit badge code + personal PIN** (set on first login) | A 6-digit code alone is not a credential |
| 12 | Solver hosted on **Render/Railway**, not Supabase Edge Functions | Edge Functions are Deno; they cannot run Python/OR-Tools |

### 1.2 Changes in Version 2.1

| # | Change | Rationale |
|---|---|---|
| 13 | **US work week**: Saturday and Sunday are the days off; Friday is a working day | This is an American school, not an Israeli-calendar workplace |
| 14 | Submission deadline moves to **Wednesday 19:00** Asia/Jerusalem | Replaces Thursday 20:00 |
| 15 | Raised morning target (3) applies **Monday-Friday only**; Sat/Sun always 2 | The weekend runs light regardless of the week setting |
| 16 | 12h opt-in becomes **per day**, stored as `allows_12h` on the preference row | A guard willing to do one long day should not have to accept a long week |
| 17 | Weeks are **auto-created** by `ensure_roster_weeks()`; hand-seeded weeks removed | Scaffolding went stale as real dates passed |
| 18 | Past weeks are **manager-only**, enforced in RLS | A guard holding the publishable key can query PostgREST directly |

### 1.3 Changes in Version 2.2

| # | Change | Rationale |
|---|---|---|
| 19 | Submission window **opens Saturday 20:00** (`week_start − 8`) and closes Wednesday 19:00 | Gives guards the weekend plus Sun–Wed; keeps exactly two weeks live |
| 20 | `ensure_roster_weeks()` manages **exactly the current week and the next** | An earlier version walked forward until it found an open window, producing a third live week for part of every cycle |
| 21 | Manager status changes go through **`set_week_status()`** and are permanent | The automatic sweep was silently reverting them — see §12.3 |
| 22 | Reopening an expired week **extends the deadline**; locking again **clears the extension** | `is_week_open()` also gates on the deadline, so flipping status alone changed nothing observable |
| 23 | Generation orchestrated **client-side**; the Edge Function is a thin secret-holding proxy | Putting solver logic in Deno would create a third copy of rules that already exist twice |
| 24 | A generated roster is **refused if it fails the referee**, never stored on the solver's word | Better a visible failure than a roster that quietly contains a clopen |
| 25 | Roster grid laid out in **three time blocks with an 18:45 handover cell** | Matches the spreadsheet the manager already used; segment rows hid that a `day12` guard covers two windows at once |
| 26 | Grid columns sized from **measured content**, not a fixed guess | A hardcoded width fitted one name and clipped the two-name handover to `יו... / ע...` |
| 27 | **Image export of a published roster** (§10.2), manager-only | The team coordinates in WhatsApp; a picture is how the roster actually reaches eight phones |

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

Five shift types across two grids. **A guard works at most ONE shift type per calendar day.**

| Code | Hebrew | Window | Hours | Grid | Eligibility |
|---|---|---|---|---|---|
| `morning` | בוקר | 06:45 – 14:45 | 8 | Standard | All guards |
| `afternoon` | צהריים | 14:45 – 22:45 | 8 | Standard | All guards |
| `night` | לילה | 22:45 – 06:45 (+1) | 8 | Standard | All guards |
| `day12` | יום 12ש׳ | 06:45 – 18:45 | 12 | Extended | Requires `allows_12h` on that day's **morning** row |
| `night12` | לילה 12ש׳ | 18:45 – 06:45 (+1) | 12 | Extended | Requires `allows_12h` on that day's **night** row |

> **Shift weight:** a 12h shift counts as **1** shift against the guard's כמות and against the 5-shift weekly ceiling — identical to an 8h shift. It is *not* 1.5.

### 2.3 Segment Coverage Model

Both grids tile the same 24 hours on four boundaries: **06:45 / 14:45 / 18:45 / 22:45**. Coverage is therefore enforced per *segment*, which lets 8h and 12h guards be mixed freely on the same day.

| Segment | Window | Length | Covered by |
|---|---|---|---|
| **S1** | 06:45 – 14:45 | 8h | `morning`, `day12` |
| **S2** | 14:45 – 18:45 | 4h | `afternoon`, `day12` |
| **S3** | 18:45 – 22:45 | 4h | `afternoon`, `night12` |
| **S4** | 22:45 – 06:45 | 8h | `night`, `night12` |

### 2.4 Targets vs. Critical Floors

> **The raised morning target applies Monday to Friday only.** Saturday and Sunday are the days
> off at the school and always run a target of 2 (floor 1) no matter what the week is set to.
> `segmentTargets()` / `segmentFloors()` therefore take a day index, not just the week setting.

| Segment | Target Capacity | Critical Floor |
|---|---|---|
| **S1** (morning window, **Mon-Fri**) | Manager-set: **2 or 3** | **1** if target = 2; **2** if target = 3 |
| **S1** (morning window, **Sat/Sun**) | Always **2** | Always **1** |
| **S2** (early afternoon) | 2 | 1 |
| **S3** (late afternoon) | 2 | 1 |
| **S4** (night window) | 2 | 1 |

- The **target is a hard ceiling** — the solver never over-staffs a segment.
- The **floor is a soft constraint with a heavy penalty** (weight 1000). It is effectively never breached, but a breach returns a readable *coverage report* instead of a bare `INFEASIBLE`.
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

### 2.5 Capacity Analysis (why floors must be soft)

Weekly demand in guard-hours at full target, morning target = 2:

```
(2 × 8h) + (2 × 4h) + (2 × 4h) + (2 × 8h) = 48 guard-hours/day  →  336/week
```

| Scenario | Weekly supply | Verdict |
|---|---|---|
| 8 guards × 5 shifts × 8h | 320h | ❌ Short of target-2 by 16h |
| 8 guards × 5 shifts × 12h | 480h | ✅ Target-2 reachable |
| Floor-only coverage (24 guard-hours/day) | 168h needed | ✅ Always safely met |
| Morning target = 3 (Mon-Fri only) | ~376h needed | ⚠️ Requires substantial 12h uptake |

**Conclusion:** with 8 guards, floors are always achievable and full target coverage is only achievable with meaningful 12h opt-in. The system is designed to degrade gracefully between the two and to report the gap explicitly.

### 2.6 Rest Rules

- **Below 8 hours rest: hard-blocked.** Unbreakable, physically impossible.
- **Exactly 8 hours rest: permitted but discouraged** — each occurrence costs **−5**.
- **12 hours rest or more: entirely free**, no penalty.
- Since a guard works at most one shift per day, rest only applies across consecutive days.

Derived rest matrix (rows = shift on day *d*, columns = shift on day *d+1*):

| ↓ prev \ next → | `morning` | `day12` | `afternoon` | `night12` | `night` |
|---|---|---|---|---|---|
| `morning` | 16h ✅ | 16h ✅ | 24h ✅ | 28h ✅ | 32h ✅ |
| `afternoon` | **8h ⚠️** | **8h ⚠️** | 16h ✅ | 20h ✅ | 24h ✅ |
| `day12` | 12h ✅ | 12h ✅ | 20h ✅ | 24h ✅ | 28h ✅ |
| `night` | **0h ⛔** | **0h ⛔** | **8h ⚠️** | 12h ✅ | 16h ✅ |
| `night12` | **0h ⛔** | **0h ⛔** | **8h ⚠️** | 12h ✅ | 16h ✅ |

⛔ = hard-blocked · ⚠️ = allowed, −5 penalty · ✅ = free

Exactly **four** penalised transitions remain, all of them 8-hour rests:
`afternoon→morning`, `afternoon→day12`, `night→afternoon`, `night12→afternoon`.

> **Note:** because 12h rest is free, `day12 → day12` on consecutive days carries no penalty.
> Combined with the 5-shift ceiling this permits up to 60 working hours in 5 consecutive days.
> The 5-shift ceiling (§2.7) is the only thing bounding this.

> **The No-Clopen rule is now derived, not declared.** The four ⛔ cells *are* No-Clopen: any night-ending shift makes the next morning physically impossible (0 hours rest).

### 2.7 Weekly Volume Limits

- **Hard ceiling:** no guard exceeds **5 shifts per week**.
- **Soft minimum:** each guard should reach their `effective_kamut` (weight 100 per missing shift).
- **Automatic כמות override (pre-flight):**
  ```
  effective_kamut = min(configured_kamut, distinct_available_days, 5)
  ```
  A guard whose כמות is 4 but who marked only 2 available days is automatically lowered to 2. This is computed before the solver runs and is displayed to the manager as an override notice.
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
2. ~~**Preference strength** (2-level `יכול` / `מעדיף`)~~ — **deferred for the POC.** The form is single-level: a slot is either marked or not. The `strength` column is reserved in the schema with a default of `1`, so the two-level scale can be switched on later with no migration.
3. **Per-day 12h opt-ins:** each marked בוקר or לילה slot may carry `allows_12h`, extending that one day only.

### 3.2 Availability Is Hard

The solver will **never** assign a guard to a slot they did not mark. If that leaves a segment below target, the shortfall is reported to the manager rather than silently overridden. This is a deliberate trade: guard trust over automatic coverage.

> **Resolved (§13 item 6, 8 August).** The manager's stated rule is *"we can't have an unoccupied
> shift"* — in practice he would phone somebody who had not volunteered. Under the current model the
> solver cannot do that; it reports the empty shift instead. Making availability **soft** (penalised
> below a floor breach but above a target gap) would let it draft an unmarked guard only when the
> alternative is an empty shift. On the first real dataset CP-SAT achieved **zero** floor breaches
> without it, so this was assessed as insurance rather than a fix — and Ben decided to keep
> availability hard. A floor breach still gets a phone call, same as before this system existed.

### 3.3 12h Eligibility Derivation

| Shift | Assignable when |
|---|---|
| `day12` | guard marked **בוקר** that day **AND** that row has `allows_12h = TRUE` |
| `night12` | guard marked **לילה** that day **AND** that row has `allows_12h = TRUE` |

Because the flag lives on the preference row, removing the availability removes the opt-in with
it. There is no reconciliation step and no way to be opted in for a day you no longer work.

The preference form states this explicitly in Hebrew, e.g. *"אם תסמן, ייתכן שתשובץ 06:45–18:45 בימים שסימנת בהם בוקר."*

### 3.4 Empty Submissions

A guard may submit a completely empty sheet. This is a normal, non-error state. Because §2.7 auto-lowers `effective_kamut` to 0 when there are no available days, the solver simply does not schedule them. The system distinguishes three states:

| State | Meaning |
|---|---|
| **Not submitted** | No row in `weekly_submissions` — manager should chase them |
| **Submitted, empty** | Row exists, zero preference rows — deliberately unavailable |
| **Submitted, partial/full** | Row exists with ≥1 preference row |

### 3.5 Submission Lock

Guards may create and edit preferences until the week's `submission_deadline` (**Wednesday 19:00 Asia/Jerusalem**, i.e. `week_start - 4`). After that, RLS blocks guard writes at the database engine level. Only managers can edit and only managers can trigger generation.

### 3.6 Free-Text Notes

Each `weekly_submissions` row carries one optional `notes` column (≤500 characters, enforced by a
CHECK) — a place for context that does not fit the slot model: *"עדיפות למשמרות לילה"*, *"עד 4
משמרות השבוע"*, *"דבר איתי אם אתה צריך עזרה"*. This is deliberately **not** a preference-strength
or constraint field (§3.1 item 2 remains deferred) — the solver never reads it. It exists for the
human reading the roster, not the one generating it.

An all-whitespace note is normalised to `NULL` inside `save_week_preferences`, the same treatment
an empty slot array gets (§3.4): absence of content should leave a clean absence of data, not a
stray string. Shown to the manager on the team list (`TeamTable`) directly under each guard's row,
next to the 12h badges — where the manager is already scanning before setting כמות, and where a
line like *"עד 4 משמרות"* is something to act on rather than something to go looking for. It appears
without a reload: `weekly_submissions` and `weekly_wish_preferences` are in the Realtime publication
(migration 18), so a guard's save invalidates the manager's dashboard query live (§10).

---

## 4. WEIGHTED MULTI-OBJECTIVE MODEL

The solver maximises a single weighted score. All coverage and volume goals are soft; only safety and physics rules are hard.

### 4.1 Hard Constraints (never violated)

| # | Constraint |
|---|---|
| H1 | Availability — guard assignable only to slots they marked |
| H2 | 12h eligibility — `day12`/`night12` require the matching opt-in |
| H3 | At most **one** shift per guard per calendar day |
| H4 | At most **5** shifts per guard per week |
| H5 | Minimum **8 hours** rest between consecutive shifts (⛔ cells in §2.6) |
| H6 | Segment coverage never **exceeds** its target ceiling |
| H7 | Carry-in rest from the previous Saturday |

### 4.2 Soft Objective Terms

| Priority | Term | Weight |
|---|---|---|
| **P1** | Each guard-slot below a segment's **critical floor** | **−1000** |
| **P2** | Each shift a guard falls short of `effective_kamut` | **−100** |
| **P3** | Each unfilled **target** slot above the floor | **−10** |
| **P-rest** | Each 8-hour-rest occurrence (⚠️ cells in §2.6) | **−5** |
| **P4** | Each assignment matching a declared preference | **+1** |

```
maximise   Σ pref_weight·x
         − 1000·Σ floor_gap
         −  100·Σ kamut_gap
         −   10·Σ target_gap
         −    5·Σ rest_violation
```

> **Note on P4:** because availability is hard (H1), every assignment matches a preference, so with the single-level POC form the P4 term reduces to "+1 per shift worked". This is harmless — it is dominated by P1–P3 and merely acts as a gentle tie-breaker toward using willing guards. Enabling the reserved `strength` column (§3.1) restores real discriminating power if the rosters ever feel arbitrary.

---

## 5. GOOGLE OR-TOOLS CP-SAT — PRIMER

OR-Tools is a free, Apache-2.0 optimisation library from Google (`pip install ortools`). CP-SAT is its constraint-programming solver.

Rather than writing an algorithm that *builds* a schedule, you **declare** the problem:

1. **Variables** — one boolean per possibility: `x[guard, day, shift]`. For 8 guards × 7 days × 5 shifts = 280 booleans.
2. **Constraints** — rules in near-English: `sum(x[g, mon, night] for g) <= 2`, or `x[g, mon, night] + x[g, tue, morning] <= 1`.
3. **Objective** — the weighted score from §4.2.

CP-SAT then searches with clause learning across parallel workers and returns a **provably optimal** assignment. At this problem size it returns in well under one second.

Its one sharp edge: a contradictory *hard* constraint yields `INFEASIBLE` with no explanation — a terrible experience for a manager on a Wednesday evening. This specification therefore keeps the hard set minimal (§4.1) and makes every business goal soft, guaranteeing the solver always returns a schedule plus a readable coverage report.

---

## 6. DATABASE SCHEMA (SUPABASE / POSTGRESQL)

### 6.1 Types

```sql
CREATE TYPE shift_type  AS ENUM ('morning', 'afternoon', 'night', 'day12', 'night12');
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
  claimed_at    TIMESTAMPTZ
);

-- 2. Guard / manager profiles
CREATE TABLE profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  employee_code TEXT NOT NULL UNIQUE CHECK (employee_code ~ '^[0-9]{6}$'),
  display_name  TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'guard',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  week_start   DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
  strength    SMALLINT NOT NULL DEFAULT 1 CHECK (strength IN (1, 2)), -- reserved; POC always 1
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
  guard_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  UNIQUE (run_id, target_date, shift, guard_id)
);

CREATE INDEX idx_prefs_week        ON weekly_wish_preferences (week_start, guard_id);
CREATE INDEX idx_assign_run        ON schedule_assignments (run_id, target_date);
CREATE INDEX idx_runs_week_pub     ON schedule_runs (week_start, is_published);
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

| Function | Purpose |
|---|---|
| `current_week_start()` | The Sunday starting the week containing today, in Asia/Jerusalem |
| `deadline_for_week(d)` | Wednesday 19:00, `week_start − 4` |
| `opens_for_week(d)` | Saturday 20:00, `week_start − 8` |
| `ensure_roster_weeks()` | Idempotent lifecycle: creates and opens/locks the current week and the next (§12.1) |
| `set_week_status(d, s, h)` | Manager override; extends or clears the deadline and stamps `status_overridden_at` (§12.3) |
| `save_week_preferences(d, jsonb)` | Atomic replace of one guard's week; `SECURITY INVOKER`, so RLS still applies |
| `carry_in_shifts(d)` | Previous Saturday's published shifts, for cross-week rest (§2.8) |
| `next_run_version(d)` | Next draft version number for a week |
| `claim_rate_ok` / `record_claim_attempt` | Badge-claim throttling (§8) |

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
`SOLVER_SECRET`, and re-check the caller's role server-side. It does *not* gather data, compute
`effective_kamut`, verify the result or write the roster — that would mean a third Deno copy of
rules that already exist twice (TypeScript and Python), and the twin-referee design depends on
there being exactly two implementations held in step by shared fixtures. Every write the client
makes afterwards is still governed by RLS, which does not trust the client's claim about its role.

**Fallback.** If the solver is unreachable — Render's free tier sleeps after 15 minutes idle, with
roughly a 50-second cold start — the app falls back to the in-browser mock rather than failing. The
mock is always *legal* (every hard rule is checked before each assignment) but not optimal; see
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
  "guards": [
    { "id": "uuid", "effective_kamut": 3,
      "availability": { "0": ["morning"], "1": ["morning","night"] },  // day index → base shifts
      "twelve_hour_day":   [1, 2],   // day indices where day12 is allowed
      "twelve_hour_night": [1]       // day indices where night12 is allowed
    }
  ],
  "carry_in": { "uuid": "night" },   // previous Saturday's shift, or null
  "weights": { "floor": 1000, "kamut": 100, "target": 10, "rest8": 5, "pref": 1 }
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

### 9.4 Mock versus CP-SAT — measured, not assumed

Both engines are held to the same referee over the same fixtures, so their outputs are directly
comparable. On the first real week of team availability (8 guards, morning target 2):

| | mock (greedy) | CP-SAT |
|---|---|---|
| Assignments | 29 | **33** |
| Floor breaches (empty shifts) | **2** | **0** |
| Guards short of כמות | 1 | **0** |
| Target gaps | 7 | **5** |
| Objective | −2266 | **−37** |

The mock is a hill-climber: it takes the best single move available and stops when nothing improves
the score, so it cannot back out of a good-looking early choice that blocks a later one. It got
*worse* when the input improved, because more 12h options give a greedy algorithm more ways to go
wrong.

**The mock is a fallback, not the product.** Rosters judged during development should come from
CP-SAT, or the model will be tuned against an engine that will not ship.

The five remaining target gaps on that dataset were genuine capacity: five of the eight guards sat
at the 5-shift ceiling. No solver can fix that — only more people, a higher cap, or more 12h uptake.

---

## 10. FRONTEND STACK

| Concern | Choice |
|---|---|
| Framework | React 18 + Vite + TypeScript |
| Styling | Tailwind CSS, RTL-first (`dir="rtl"`, logical properties) |
| Server state | TanStack Query (cache, optimistic updates, invalidation) |
| Session state | React Context (auth only) |
| Validation | Zod at every I/O boundary |
| Backend SDK | `@supabase/supabase-js` v2 |
| Live updates | Supabase Realtime, both directions — `schedule_runs`/`schedule_assignments`/`roster_weeks` push a publish or edit to guards (`useRosterRealtime`, migration 15); `weekly_submissions`/`weekly_wish_preferences` push a guard's save to the manager (`useManagerSubmissionsRealtime`, migration 18) |

> **Environment variables:** Vite exposes only `VITE_`-prefixed variables. Use `VITE_SUPABASE_URL`
> and `VITE_SUPABASE_PUBLISHABLE_KEY` (Supabase replaced the legacy `anon` JWT with
> `sb_publishable_…`; the client accepts either). The `NEXT_PUBLIC_*` names in v1 of this document
> were a Next.js convention and resolve to `undefined` here.
>
> `VITE_SOLVER_MODE` selects the engine: `mock` runs in the browser, `remote` calls the Edge
> Function. Server-only values — `SUPABASE_ACCESS_TOKEN`, `SOLVER_SECRET`, `SOLVER_URL` — must never
> carry a `VITE_` prefix, which would publish them in the browser bundle.

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

**Short-staffed reads the same way empty does.** A morning or night block with *some* coverage but
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

The manager can export a **published** roster as a JPEG (`src/lib/exportRoster.ts`,
`src/components/manager/RosterExport.tsx`). The team coordinates in a WhatsApp group, so a picture
is how the roster reaches eight phones regardless of what the app does.

Three decisions worth keeping:

1. **The grid is drawn onto a canvas, not screenshotted from the DOM.** A DOM-to-canvas library
   would track the styling for free but has to reimplement a layout engine, and this app is exactly
   the kind that breaks it — Tailwind v4 emits `oklch()`, shift colours are CSS custom properties,
   chips carry rings. Half-rendered output is worse than none, because the manager would not notice
   until the picture was already in the group chat.
2. **Published runs only.** A draft is a proposal still being moved around; once an image of it is
   in the chat it is *the roster* as far as the guards are concerned, and no later edit catches up
   with it. Publishing is when the roster becomes a promise, so it is when it becomes shareable.
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
has genuinely passed, so locking a week *early* cannot accidentally become an extension.

### 12.4 Team Management (migrations 20–21)

A dedicated page (`/manage/team`, `src/pages/TeamManagement.tsx`) gives the manager CRUD over the
team itself, as opposed to ManagerDashboard's week-by-week workflow. Reached via a back-linked
button on `ManagerDashboard`, not a bottom-nav tab — it is a config screen, not something opened
every day.

| Operation | Mechanism |
|---|---|
| **Add employee** | `INSERT INTO roster_codes` — the same action `seed.sql` did by hand for the first eight. The employee still sets their own PIN through the ordinary "קוד עובד" login flow; nothing here creates an account directly. |
| **Delete employee** | `delete_employee(employee_code)` RPC (migration 21) — a genuine, irreversible deletion, not a deactivation. Cascades through `auth.users → profiles → {schedule_assignments, weekly_wish_preferences, weekly_submissions, weekly_guard_targets}`, so the person's shift history is gone from every roster, including a published one. Refuses to let a manager delete their own account. Works identically on a still-pending invitation (no profile exists yet, so only `roster_codes` is touched). |
| **Default כמות** | Edits `profiles.default_kamut` (claimed) or `roster_codes.default_kamut` (not yet claimed) — the §2.7 baseline, not the per-week override the `Stepper` on `TeamTable` already edits. |

> **v1 of this feature deactivated instead of deleting** (`profiles.is_active = false`), reasoned
> from the same cascade this table describes: deleting the row would erase a person's shift history
> out of a published roster. The manager tried it and asked for real deletion anyway — a fully
> informed call about their own data, not a case of the concern being missed. `is_active` still
> exists and still gates scheduling eligibility (§2.1) exactly as before; there is simply no more UI
> path to flip it, since there is nothing left to flip once the row is gone.

Three points worth keeping:

1. **`claim-code` is untouched.** It is the one publicly-reachable *unauthenticated* write path in
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
   row's already-*stored* deadline — an existing week's stored `submission_deadline` is not rewritten
   retroactively. To change one specific week's deadline right now, the lock/reopen flow (§12.3,
   migrations 11–12) is still how. Also changed: both functions went from `IMMUTABLE` to `STABLE`,
   since their result can now change between calls if a manager edits the settings row — `IMMUTABLE`
   tells the planner it may cache or fold a call forever, which would go stale the moment settings
   change.

### 12.6 Seed Data Is Bootstrap-Only

`seed.sql` is not just start-of-project scaffolding — `npm run db:apply` reruns it on **every**
invocation, migration or not, and it originally seeded `roster_codes` with
`ON CONFLICT (employee_code) DO NOTHING`. That combination has a sharp edge: once real team
management existed (§12.4) and a manager could genuinely *delete* an employee, a deleted row is no
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

---

## 13. OPEN ITEMS

| # | Item | Status / default |
|---|---|---|
| 1 | 2-level preference strength (`יכול` / `מעדיף`) | **Deferred** — column reserved, POC uses the single-level form |
| 2 | `night → next-day afternoon` is legal at exactly 8h rest | Allowed with −5 penalty, per §2.6 |
| 3 | `day12 → day12` on consecutive days is unpenalised (12h rest) | Allowed; bounded only by the 5-shift ceiling |
| 4 | Fairness / rotation of weekend and night shifts across guards | Not modelled |
| 5 | Public holidays | Treated as ordinary days |
| 6 | **Should availability be soft?** (§3.2) | **Decided (8 August): stays hard.** On the one real dataset tested, CP-SAT hit zero floor breaches without a soft fallback — insurance against a scenario that hasn't materialized, not a fix for an observed one. No code change. |
| 7 | Posts (סריקה / בוטקה / בקרה / שמירה) | **Dropped at Ben's request.** The column itself was later dropped too (migration 23) — nothing had read or written it since the feature was cut |
| 8 | `pg_cron` for the week sweep | Not configured; the sweep runs on app load (§12.1) |

---

## 14. BUILD STATUS AND ROADMAP

### 14.1 What is built

| Step | Scope | State |
|---|---|---|
| **A** | Schema, RLS, seed, helper functions | ✅ complete |
| **B** | Badge-code + PIN auth, `claim-code` Edge Function | ✅ complete, deployed |
| **C** | Guard preference submission, atomic save RPC | ✅ complete |
| **D** | Manager dashboard: week controls, coverage matrix, כמות editor | ✅ complete |
| **E** | Solver contract, twin referees, mock + CP-SAT, generate → publish | ✅ complete; **CP-SAT deployed** |
| **F1–F5** | Fine-tuning batch (per-day 12h, week lifecycle, Mon–Fri target, archive, US week) | ✅ complete |
| **G** | Manual grid editing, editable/deletable published rosters, Realtime both directions, shared grid, measured columns, image export, free-text submission notes (§3.6), per-guard default כמות (§2.7) | ✅ complete |
| **H** | Team management: add/delete employees (real deletion, not deactivation), edit default כמות (§12.4) | ✅ complete |
| **I** | Manager dashboard defaults to next week; configurable submission window (§12.5); short-staffed dash convention (§10.1) | ✅ complete |
| **J** | Cleanup pass: dropped the dead `schedule_assignments.post` column (migration 23); fixed `seed.sql` re-seeding a deleted employee on every `db:apply`; removed the two never-hired placeholder codes; this document brought back in sync with the code | ✅ complete |

### 14.2 Verification

Eleven suites, all green. Every gate runs against the live project except the PGlite one.

| Suite | Command | Covers |
|---|---|---|
| Gate A (local) | `npm run test:rls` | RLS logic in PGlite, all migrations applied from disk |
| Gate A (cloud) | `node supabase/tests/rls.cloud.test.mjs` | RLS through real PostgREST + GoTrue JWTs |
| Gate B | `node supabase/tests/auth.cloud.test.mjs` | Badge claim, PIN login, rate limiting |
| Gate B (client) | `node supabase/tests/client.cloud.test.mjs` | The `supabase-js` path the browser runs |
| Gate C | `node supabase/tests/preferences.cloud.test.mjs` | Persistence, atomicity, deadline, isolation, notes (§3.6) |
| Gate D | `node supabase/tests/manager.cloud.test.mjs` | Week controls, כמות, lock/reopen override |
| Gate E (cloud) | `npm run test:generate` | Generate → verify stored rows → publish |
| Gate E (engines) | `npm run test:fixtures`, `solver/tests/test_scheduler.py` | 8 golden fixtures, both engines |
| Gate E (edit) | `npm run test:edit` | Draft and published-roster editing, deletion |
| Gate F (realtime) | `npm run test:realtime` | Live push both directions: roster changes to guards, submissions to the manager |

`npm run test:cloud` chains every cloud suite in this table (rls → auth → client → preferences →
manager → generate → edit → realtime) and stops at the first failure. `npm run test:compare` asserts
CP-SAT never scores below the mock.

### 14.3 What is left

Nothing. All three items resolved, deploy live on a stable domain (§11.2), GitHub auto-deploy
connected.

**Completed since v2.2 was drafted:** repository pushed to
`github.com/BenLachovitz/Work-Organizer`; the CP-SAT service is live at
`https://guard-solver.onrender.com`; `SOLVER_URL` and `SOLVER_SECRET` are set as Supabase Edge
Function secrets; `VITE_SOLVER_MODE=remote`. Verified end to end — a guard calling
`generate-schedule` is rejected 403, a manager receives `OPTIMAL` in roughly 2.5 seconds. The 7 mock
guard accounts were renamed to `{שם} - דמה` (migration 25), making the placeholder-badge-number
question (old item 2) moot. Open item 6 (soft availability, §13) is decided: stays hard, no code
change. The manager-facing week cycle now advances on the configured open-time rather than real
midnight (`admin_current_week_start()`, migration 26), while guard-facing visibility stays
calendar-pinned. **The frontend is deployed to Vercel and live** (§11.2) — build step A–J's last
blocker is cleared.

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
*Specification v2.2 — revised 8 August 2026.*
