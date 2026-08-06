# TECHNICAL SPECIFICATION & ARCHITECTURE BLUEPRINT: AUTOMATED SECURITY GUARD SCHEDULER
**Version:** 2.0 (revised after Checkpoint 1 review)
**Roster Context:** Flexible team size, 6–12 registered guards, 8 currently active
**Target Roster Week:** Sunday 9 August 2026 – Saturday 15 August 2026
**Document Date:** 6 August 2026

---

## 1. EXECUTIVE SUMMARY

This document specifies the operational rules, database schema, Row-Level Security (RLS) policies, and constraint-programming model for a custom security-guard scheduling application (**סידור אמריקאי**).

Active guards submit weekly availability from their phones, replacing manual WhatsApp coordination. A manager sets a per-week morning capacity target and a per-guard **כמות** (minimum shift target), then triggers a **Google OR-Tools CP-SAT** solver that produces a mathematically optimal, conflict-free draft roster in seconds. The manager audits the draft on a visual grid, assigns posts manually, and publishes — pushing the roster to every guard's phone.

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
| `day12` | יום 12ש׳ | 06:45 – 18:45 | 12 | Extended | Requires `can_work_12h_day` opt-in |
| `night12` | לילה 12ש׳ | 18:45 – 06:45 (+1) | 12 | Extended | Requires `can_work_12h_night` opt-in |

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

| Segment | Target Capacity | Critical Floor |
|---|---|---|
| **S1** (morning window) | Manager-set: **2 or 3** | **1** if target = 2; **2** if target = 3 |
| **S2** (early afternoon) | 2 | 1 |
| **S3** (late afternoon) | 2 | 1 |
| **S4** (night window) | 2 | 1 |

- The **target is a hard ceiling** — the solver never over-staffs a segment.
- The **floor is a soft constraint with a heavy penalty** (weight 1000). It is effectively never breached, but a breach returns a readable *coverage report* instead of a bare `INFEASIBLE`.
- It is fully acceptable for segments to sit between floor and target. The solver satisfies floors first, then כמות, then fills remaining target slots.

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
| Morning target = 3 | 392h needed | ⚠️ Requires substantial 12h uptake |

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

### 2.8 Cross-Week Carry-In

The solver accepts a `carry_in` map of `{guard_id → shift worked on the previous Saturday}`, read from the previous week's **published** run. The full rest matrix (§2.6) is applied between that shift and each guard's Sunday assignment. In particular, a guard who worked Saturday `night` or `night12` cannot work Sunday `morning` or `day12`.

The current week's Saturday assignments become the next week's carry-in, closing the loop.

---

## 3. GUARD PREFERENCE MODEL

### 3.1 Submission Structure

Per week, each guard submits:
1. **Availability:** any subset of the 21 base slots (7 days × בוקר/צהריים/לילה). An empty subset is valid.
2. ~~**Preference strength** (2-level `יכול` / `מעדיף`)~~ — **deferred for the POC.** The form is single-level: a slot is either marked or not. The `strength` column is reserved in the schema with a default of `1`, so the two-level scale can be switched on later with no migration.
3. **Two week-level opt-ins:** `can_work_12h_day`, `can_work_12h_night`.

### 3.2 Availability Is Hard

The solver will **never** assign a guard to a slot they did not mark. If that leaves a segment below target, the shortfall is reported to the manager rather than silently overridden. This is a deliberate trade: guard trust over automatic coverage.

### 3.3 12h Eligibility Derivation

| Shift | Assignable when |
|---|---|
| `day12` | guard marked **בוקר** that day **AND** `can_work_12h_day = TRUE` |
| `night12` | guard marked **לילה** that day **AND** `can_work_12h_night = TRUE` |

The preference form states this explicitly in Hebrew, e.g. *"אם תסמן, ייתכן שתשובץ 06:45–18:45 בימים שסימנת בהם בוקר."*

### 3.4 Empty Submissions

A guard may submit a completely empty sheet. This is a normal, non-error state. Because §2.7 auto-lowers `effective_kamut` to 0 when there are no available days, the solver simply does not schedule them. The system distinguishes three states:

| State | Meaning |
|---|---|
| **Not submitted** | No row in `weekly_submissions` — manager should chase them |
| **Submitted, empty** | Row exists, zero preference rows — deliberately unavailable |
| **Submitted, partial/full** | Row exists with ≥1 preference row |

### 3.5 Submission Lock

Guards may create and edit preferences until the week's `submission_deadline` (default **Thursday 20:00 Asia/Jerusalem**). After that, RLS blocks guard writes at the database engine level. Only managers can edit and only managers can trigger generation.

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

Its one sharp edge: a contradictory *hard* constraint yields `INFEASIBLE` with no explanation — a terrible experience for a manager on a Thursday night. This specification therefore keeps the hard set minimal (§4.1) and makes every business goal soft, guaranteeing the solver always returns a schedule plus a readable coverage report.

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
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. One row per guard per week: proves submission occurred + holds the 12h opt-ins.
--    Opt-ins live here (not per-slot) so they cannot self-contradict.
CREATE TABLE weekly_submissions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  week_start         DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  can_work_12h_day   BOOLEAN NOT NULL DEFAULT FALSE,
  can_work_12h_night BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guard_id, week_start)
);

-- 5. Availability. Row present == available. No row == unavailable.
CREATE TABLE weekly_wish_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  week_start  DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  target_date DATE NOT NULL,
  shift       base_shift NOT NULL,
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

-- 8. The assignments themselves. `post` is set MANUALLY by the manager after generation.
CREATE TABLE schedule_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES schedule_runs(id) ON DELETE CASCADE,
  target_date DATE NOT NULL,
  shift       shift_type NOT NULL,
  guard_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  post        TEXT CHECK (post IN ('סריקה', 'בוטקה', 'בקרה', 'שמירה')), -- nullable, manual
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

-- schedule_runs: guards see published runs only; drafts are manager-only.
CREATE POLICY runs_read ON schedule_runs
  FOR SELECT TO authenticated USING (is_published OR is_manager());
CREATE POLICY runs_manager_write ON schedule_runs
  FOR ALL TO authenticated USING (is_manager()) WITH CHECK (is_manager());

-- schedule_assignments: visibility inherited from the parent run.
CREATE POLICY assign_read ON schedule_assignments
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM schedule_runs r
            WHERE r.id = run_id AND (r.is_published OR is_manager()))
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
      │  manager clicks "צור סידור"
      ▼
[Supabase Edge Function: generate-schedule]   ← holds SOLVER_SECRET
      │  1. verifies caller is a manager
      │  2. reads prefs/targets/controls/carry-in
      │  3. computes effective_kamut  (§2.7)
      │  4. POSTs SolverInput  ──────────────► [Render: FastAPI + CP-SAT]
      │  5. writes schedule_runs + assignments ◄── SolverOutput
      ▼
[Supabase Postgres]
```

The solver secret never reaches the browser. Note that Render's free tier sleeps after 15 minutes idle (~50s cold start); the UI shows a "מחמם מנוע…" state on first call.

### 9.2 Solver Contract

```jsonc
// SolverInput
{
  "week_start": "2026-08-09",
  "morning_target_slots": 2,
  "guards": [
    { "id": "uuid", "effective_kamut": 3,
      "can_work_12h_day": true, "can_work_12h_night": false,
      "availability": { "0": ["morning"], "1": ["morning","night"] }   // day index → base shifts
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
                ok = ((s in ('morning', 'afternoon', 'night') and s in avail)
                      or (s == 'day12'   and 'morning' in avail and g['can_work_12h_day'])
                      or (s == 'night12' and 'night'   in avail and g['can_work_12h_night']))
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
| Live updates | Supabase Realtime on `schedule_runs` — publishing pushes to phones instantly |

> **Environment variables:** Vite exposes only `VITE_`-prefixed variables. Use `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` — the `NEXT_PUBLIC_*` names in v1 of this document were a Next.js convention and would resolve to `undefined` here.

---

## 11. DEPLOYMENT

```
[Local]
   │ git push
   ▼
[GitHub: work-orgenizer] ──► [Vercel]  React app        (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
                         ──► [Render]  FastAPI + CP-SAT (SOLVER_SECRET)
                                  ▲
                         [Supabase]  Postgres + Auth + Edge Functions (SERVICE_ROLE_KEY, SOLVER_URL, SOLVER_SECRET)
```

---

## 12. OPERATIONS WORKFLOW

1. **Sunday–Thursday 20:00 — submission window.** Guards submit availability + 12h opt-ins. Empty submissions are valid. RLS locks writes at the deadline.
2. **Thursday evening — configuration.** Manager sets the morning target (2 or 3) and each guard's כמות.
3. **Pre-flight.** The system computes `effective_kamut` and shows any auto-overrides for review.
4. **Generate.** CP-SAT returns an optimal draft plus a coverage report (floor breaches, target gaps, unmet כמות, rest violations).
5. **Audit.** Manager reviews the colour-coded grid, makes manual swaps, and assigns posts (סריקה / בוטקה / בקרה / שמירה).
6. **Publish.** The run is marked `is_published`; Realtime pushes it to every guard's phone. Saturday's assignments become next week's carry-in.

---

## 13. OPEN ITEMS

| # | Item | Default if unanswered |
|---|---|---|
| 1 | 2-level preference strength (`יכול` / `מעדיף`) | **Deferred** — column reserved, POC uses the single-level form |
| 2 | `night → next-day afternoon` is legal at exactly 8h rest | Allowed with −5 penalty, per §2.6 |
| 5 | `day12 → day12` on consecutive days is unpenalised (12h rest) | Allowed; bounded only by the 5-shift ceiling |
| 3 | Fairness/rotation of weekend shifts across guards | Not modelled in v2.0 |
| 4 | Israeli public holidays | Treated as ordinary days |

---
*Specification v2.0 — revised 6 August 2026.*
