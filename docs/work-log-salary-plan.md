# Personal Work Log + Estimated Gross Salary

## Shipped since this plan was written (status, not part of the original plan)
Everything below this line was the original v1 plan. Since then, implemented and deployed to the `feature/work-log-salary` branch (migrations 58-64, all applied to production):
- **Rate model replaced**: a single flat hourly rate per role (guard/manager) became an **append-only rate history** (`payroll_rates`, migration 62) — a rate change takes effect from its own `effective_from` date forward only, never recalculating a month that already passed. Manager Settings shows each role's history + an "add a new rate" form.
- **Breakdown restructured** from `{regular, ot125, ot150, shabbat}` into five RAW percentage buckets — `hours100/125/150/175/200` — since a rest day's base rate and a weekday's 2nd overtime tier are both 150% (no reason to track separately), and this is also what fixed a real bug: the old `shabbatHours` was pay-weighted but displayed under a plain "hours" label.
- **Night-shift + stacking corrections**: a night shift (≥2h inside 22:00-06:00) gets a 7h standard day, not 8 (overtime starts an hour earlier); overtime stacks **additively** on the applicable base rate (150→175→200%), not multiplicatively (187.5/225%, which was wrong).
- **Major-holiday premium** (the "Future, not scoped now" item below — now built): 8 Yom Tov days (Rosh Hashanah ×2, Sukkot day 1, Shmini Atzeret, Pesach day 1 & 7, Shavuot) carry the same rest-day premium as Shabbat, via `isMajorJewishHoliday()` in `holidays.ts` (fixed Hebrew-calendar dates, same technique as the existing Yom Kippur check, no new dependency).
- **Monthly view can now edit**, not just the weekly view (`useUpsertWorkLogEntry`/`useDeleteWorkLogEntry` no longer bind to one week).
- **Sick/vacation absences** (migration 64, `work_log_absences`): a separate "add absence" flow, not worked time, no balance/ledger (deliberate — the app never checks whether a guard actually has days left). Value = `averageDailyGross()` (the guard's own historical average gross per worked day, windowed to end at the absence's own date) × 100% for vacation, or × the Israeli Sick Pay Law's 0/50/100% tier (by `consecutiveSickDayCount`) for sick days.
- **Security fix**: `my_hourly_rate_history()` was callable by a fully unauthenticated caller (Supabase's default `anon` grant on new functions); closed in migration 63.

## Context (original v1)
Today the app tracks only *which shift type* a guard is scheduled for (`schedule_assignments.shift`, a `shift_type` enum) — there is no clock-in/out time, no wage/rate field, and no pay concept anywhere in the codebase or spec. The owner wants to give each guard a personal, self-service tool to estimate their own gross (pre-tax) salary: auto-seeded from their published roster, editable when they stay late or pick up an ad-hoc shift, and computed under full standard Israeli overtime/Shabbat law. This is explicitly **not** connected to any real payroll system — there is no manager-approval gate; a guard who inflates their own hours is only misleading themselves. Decided already: one flat hourly rate for every guard and a separate one for the manager (not per-individual — everyone but the manager is paid the same), full Israeli-law overtime/Shabbat rules, and a weekly view with a monthly rollup (Israeli salaries are paid monthly, and a Sun–Sat roster week can straddle two calendar months).

## Branching & rollout
All of this (migrations + code, Phases 1–5 below) happens on a dedicated branch, e.g. `feature/work-log-salary` — never committed directly to `main`. `main` stays exactly as it is in production until the owner is happy with the feature; only then does it get merged, and the owner will handle pointing Vercel's production deployment at the new code themselves (switching which branch Vercel builds as production), not as part of this plan's automation. The one-time backfill script (see below) also only ever runs against the owner's own Supabase project once they choose to, never automatically.

## Data model
**New table `work_log_entries`** — kept fully decoupled from `schedule_assignments`/`schedule_runs` (the solver's own domain); cross-referenced only for seeding provenance via a nullable FK, so pay data can never affect scheduling/solver integrity.

```sql
CREATE TYPE work_log_source AS ENUM ('roster', 'edited', 'manual');

CREATE TABLE work_log_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id              uuid NOT NULL REFERENCES profiles(id),
  target_date           date NOT NULL,              -- shift's start calendar date
  shift                 shift_type,                 -- NULL allowed for free-form manual entries
  source                work_log_source NOT NULL DEFAULT 'manual',
  source_assignment_id  uuid REFERENCES schedule_assignments(id) ON DELETE SET NULL,
  scheduled_start       timestamptz,                 -- nominal, from SHIFTS[shift]; NULL for pure manual
  scheduled_end         timestamptz,
  actual_start          timestamptz NOT NULL,
  actual_end            timestamptz NOT NULL,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actual_end_after_start CHECK (actual_end > actual_start)
);
CREATE UNIQUE INDEX work_log_one_per_assignment
  ON work_log_entries (source_assignment_id) WHERE source_assignment_id IS NOT NULL;
CREATE INDEX work_log_guard_date ON work_log_entries (guard_id, target_date);
```

`source` distinguishes: `'roster'` = untouched seed, `'edited'` = seeded then the guard changed actual times, `'manual'` = never existed in any roster. `actual_start`/`actual_end` are computed client-side from `target_date` + `SHIFTS[shift]` nominal offsets (`src/lib/shifts.ts`), using the same DST-safe Jerusalem-offset pattern as `restHours()`/`submissionDeadline()` in `src/lib/dates.ts` — this is what makes overnight shifts (`night`, `night12`, `kippur_day1`) and DST-change nights correct.

**Hourly rate (revised — global, not per-guard)**: a singleton `payroll_settings` table (`id boolean primary key default true check(id)`, same trick as the existing `scheduler_settings`) holds `guard_hourly_rate` and `manager_hourly_rate`, both `numeric(8,2)`, NULL until set. No read policy for guards at all — a `SECURITY DEFINER` function `my_hourly_rate()` resolves to the caller's own effective rate (`manager_hourly_rate` when `is_manager()`, else `guard_hourly_rate`) without ever exposing the other one. The manager edits both directly (RLS `is_manager()`-gated) from a new Manager Settings section. No per-guard column, no `guard_profile_columns()` change needed.

**RLS**, mirroring the existing per-guard-row pattern (e.g. `weekly_wish_preferences`):
```sql
CREATE POLICY work_log_read ON work_log_entries
  FOR SELECT USING (guard_id = auth.uid() OR is_manager());
CREATE POLICY work_log_self_write ON work_log_entries
  FOR ALL USING (guard_id = auth.uid()) WITH CHECK (guard_id = auth.uid());
CREATE POLICY work_log_manager_write ON work_log_entries
  FOR ALL USING (is_manager()) WITH CHECK (is_manager());
```
Manager read/write at the DB layer is a support escape hatch (consistent with every other table); the UI never exposes editing another guard's hours.

**Verified**: `shift_type` enum already has all 9 values the UI uses (`morning/afternoon/night/day12/night12` from migration 1, plus `afternoon_early/afternoon_late` added in `20260903000053`, `kippur_day1/kippur_day2` added in `20260916000056`) — no enum changes needed for seeding any shift type.

## Seeding mechanics
Seed **lazily, on first read of a week** (not via a publish-time trigger — simpler, self-healing, doesn't need to special-case re-generation). `useWorkLogWeek(weekStart)`: fetch existing `work_log_entries` for that guard+week, fetch the guard's **published** assignments for that week, and insert a `source='roster'` row (`actual_* = scheduled_*`) for any assignment with no matching `source_assignment_id` — a plain per-row upsert, RLS-safe, no RPC.

A guard's `'edited'`/`'manual'` rows are never touched by reseeding. If a manager republishes a different roster for the same week, an old `source_assignment_id` may point at an assignment that no longer exists for that guard — `ON DELETE SET NULL` leaves the entry in place, now functionally manual-shaped, rather than silently deleting a guard's logged hours. This favors preserving what the guard logged over perfect roster sync, consistent with the owner's stated risk tolerance.

## Overtime/Shabbat calculation engine
New pure module **`src/lib/payroll.ts`** — zero Supabase imports, fully unit-testable in isolation.

```ts
export interface PayrollBreakdown {
  regularHours: number; ot125Hours: number; ot150Hours: number;
  shabbatHours: number; grossEstimate: number;
}
export function computePayroll(entries: WorkLogEntry[], hourlyRate: number): PayrollBreakdown
```

Algorithm:
1. **Group by `target_date`** — an overnight entry attributes its whole duration to its start date (matches how the app already thinks about a shift).
2. **Daily split**: per day, sum durations; hours 1–8 → regular, 9–10 → 125%, 11+ → 150% (Israeli daily-overtime rule). Multiple entries on one day sum before splitting.
3. **Weekly 42h reconciliation**: sum each week's post-daily-split regular hours; hours beyond 42 are reclassified into the 125% bucket — catches guards stacking many short days that never individually trigger daily OT.
4. **Shabbat/holiday overlay**: for every entry, compute overlap with the weekly-rest window — v1 scope is the **Friday/Saturday weekend only** (a fixed cutoff, e.g. Friday 16:00 local → end of Saturday, documented as an approximation since no sunset/candle-lighting data exists in the repo). **Verified**: `src/lib/holidays.ts` today only implements Yom-Kippur-specific detection (`getYomKippurWeekInfo`) — there is no general "is this date a Hebrew-calendar holiday" helper, so extending the premium to *other* Jewish holidays (Rosh Hashana, Sukkot, Passover, etc.) is real added scope, not a one-line reuse. **Recommendation: ship v1 with the Friday/Saturday weekend premium only**, and treat "extend to other holidays" as a clearly separate follow-up phase, not bundled into Phase 4.
   Overlapping hours move into `shabbatHours` at minimum 150%; when an hour is also daily/weekly OT, rates **multiply** (e.g. an 11th hour on Saturday = 150%×150%) — explicitly an estimate-only simplification, documented in-app, not a legal ruling.
5. `grossEstimate = hourlyRate × (regularHours + 1.25×ot125Hours + 1.5×ot150Hours + 1.5×shabbatHours)`.

## UI/UX
New guard route **`/worklog` → `src/pages/WorkLog.tsx`**, added to `AppShell`'s nav and `App.tsx`'s routes.
- Week list (newest-first), each a card with a total-hours/total-pay header strip.
- Per-entry row (date, shift label or "ידני" for manual, actual times, pay-bucket badges) opens **`WorkLogEntryEditor`** — a bottom-sheet modal copying `RosterEditor`'s existing `SlotEditor` pattern (`fixed inset-0 z-50 … rounded-t-2xl … sm:rounded-2xl`), with `<input type="time">` pairs (the one existing precedent, `SubmissionWindowSettings.tsx:157-162`) plus a date field for manual entries.
- "הוסף משמרת" button opens the same modal in create mode (`source: 'manual'`, free start/end, no `shift` required).
- Month-selector segment control at the top rolls up by **calendar month of each `target_date`** (not by `roster_weeks.week_start`, since a week can straddle two months).

Manager-facing: two rate inputs (guard rate, manager rate) in a new `PayrollRateSettings.tsx` on the Manager Settings page, same Collapsible pattern as `DefaultMorningTargetSettings.tsx`, via `useUpdatePayrollSettings`. Every guard (and the manager) sees their own resolved rate read-only in `WorkLog.tsx`'s header, via `useMyHourlyRate()`.

## Hooks/data layer (new `src/hooks/useWorkLog.ts`)
- `useWorkLogWeek(weekStart)` — query + lazy-seed from the section above; key `workLogKeys.week(guardId, weekStart)`.
- `useUpsertWorkLogEntry()` — single-row `.upsert()`, direct (no RPC — one entry at a time, no cross-row atomicity need, unlike the whole-week preference-replace RPCs elsewhere in the codebase).
- `useDeleteWorkLogEntry()`.
- `useMyHourlyRate()` (RPC-backed, works for guard or manager) / `usePayrollSettings()` + `useUpdatePayrollSettings()` (manager-only, `PayrollRateSettings.tsx`).
- `useMonthlySalarySummary(guardId, monthKey)` — queries by month-of-`target_date`, runs `computePayroll()` client-side.

## Migration plan
(Last existing migration is `20260923000057_morning_override_any_day_value_one.sql`; new ones use today's date to stay chronological.)
1. `20261029000058_work_log_entries.sql` — `work_log_source` enum, `work_log_entries` table, indexes, constraint.
2. `20261029000059_work_log_rls.sql` — the three RLS policies above.
3. `20261029000060_work_log_touch_updated_at.sql` — attach the existing `touch_updated_at()` trigger to `work_log_entries`.
4. `20261029000061_payroll_settings.sql` — singleton `payroll_settings` (`guard_hourly_rate`, `manager_hourly_rate`), manager-only RLS, and the `my_hourly_rate()` SECURITY DEFINER function.

Also update `src/types/database.ts` by hand (it mirrors migrations manually, not generated) to add `WorkLogEntry`/`WorkLogSource`. No new `Profile` field — the rate is global, not per-guard.

## Phased build order (each independently shippable)
1. **Phase 1** — Migrations 1–4; `PayrollRateSettings.tsx` (guard + manager rate) on Manager Settings. No guard-facing surface yet.
2. **Phase 2** — `useWorkLogWeek` (seed-only); `/worklog` route, read-only entry list.
3. **Phase 3** — `WorkLogEntryEditor` modal: edit actual times on seeded rows (→ `'edited'`), add manual entries, delete. Add a sanity cap on manual-entry duration (e.g. reject >16h) before this ships.
4. **Phase 4** — `src/lib/payroll.ts` (Friday/Saturday weekend premium only, per the recommendation above) + weekly total card.
5. **Phase 5** — Monthly rollup view via `useMonthlySalarySummary`.
6. **Phase 6 (one-time, run manually once development is done)** — a backfill script so the owner sees real results immediately across the whole team instead of waiting for each guard to open `/worklog` and trigger the lazy per-guard seed. See "One-time backfill script" below.
7. *(Future, not scoped now)* — extend the Shabbat/holiday premium to other Jewish holidays via a generalized `holidays.ts` helper.

## One-time backfill script
A standalone Node script, e.g. `supabase/scripts/backfill-worklog-month.mjs`, connecting with the Supabase service-role key (same connection pattern as `supabase/apply.mjs`). Run once, manually, by the owner after Phases 1–5 are implemented and deployed to the feature branch's own environment — not part of any ongoing automation, and not something this plan runs on its own.

What it does:
1. Determines the current calendar month's date range.
2. Finds every `roster_weeks` row overlapping that month whose status is **`published`** — explicitly excluding `open`/`locked`/`generated` weeks, since only a published roster represents real, confirmed shifts a guard actually worked.
3. For each such week, loads its published run's `schedule_assignments` (same query the app's own `useVisibleRosters`/`useWorkLogWeek` logic uses, to guarantee the backfill and the lazy seed never disagree).
4. For every (guard, assignment) pair, inserts a `work_log_entries` row with `source='roster'`, `actual_* = scheduled_*`, using `ON CONFLICT (source_assignment_id) WHERE source_assignment_id IS NOT NULL DO NOTHING` — so the script is safe to re-run (idempotent) and never clobbers an entry a guard has already edited.
5. Logs a per-guard summary (how many entries inserted vs. already present) so the owner can immediately see it worked, without needing to log in as each guard.

This script is for the **current month only** (the owner's stated goal: "see the results immediately" after finishing development) — it is not a general historical backfill tool, and it is separate from the ongoing lazy-seed mechanic in Phase 2, which keeps handling all future weeks automatically as each guard opens their work log.

## Testing/verification
Pure unit tests in `src/lib/payroll.test.ts`: hand-computed fixtures for a plain 8h day, a 12h day (125/150 split), an overnight night shift (date attribution), and a Friday-evening-into-Saturday shift (weekend overlay + stacking). No Supabase dependency, runs standalone.

**Explicitly avoid the cloud-test-against-production trap** already on record for this repo (`test:cloud` and friends hit the live Supabase project, no separate test DB — a past hardcoded-fixture-date test once deleted real production data). Do not add a `*.cloud.test.mjs` that writes `work_log_entries` against the live project. For manual UI verification, use the existing `is_demo`/`VITE_DEMO_MODE` convention (a seeded demo guard or local in-memory data) — never a real guard's row.

## Open risks/edge cases (flagged, not resolved here)
- No rate-history: a mid-month rate change silently applies to the *whole* month when a summary is recomputed later — needs in-app documentation, not a schema fix, for v1.
- A guard deactivated mid-month with existing logged hours — summary should likely still render for past months; not yet decided.
- No validation bounds proposed yet for manual-entry duration beyond the Phase-3 sanity cap mentioned above.
- DST changeover nights (Israel's two clock-change weekends) through the nominal-time seeding math.
- Multiple concurrent `schedule_runs` for one week — only the published run should ever seed; confirm the existing published-roster query already filters this correctly before reusing it here.

## Critical files
- `src/types/database.ts`, `src/lib/shifts.ts`, `src/lib/dates.ts`, `src/lib/holidays.ts`
- `src/hooks/useGuardPortal.ts`, `src/hooks/useManager.ts` (mutation patterns to copy)
- `src/components/manager/RosterEditor.tsx` (modal pattern), `src/components/manager/DefaultMorningTargetSettings.tsx` (settings-section pattern)
- `src/components/layout/AppShell.tsx`, `src/App.tsx` (new route)
- `supabase/migrations/20260806000002_functions_triggers.sql` (`guard_profile_columns`), `20260806000003_rls_policies.sql`

## Verification plan
1. `npm run typecheck` after each phase.
2. Run the new `src/lib/payroll.test.ts` fixtures and confirm hand-computed totals match.
3. Start the dev server, sign in as a demo/seeded guard (not a real one), walk through: viewing a seeded week, editing an entry's actual time, adding a manual entry, confirming the weekly total card updates, switching to the monthly view.
4. As the manager, confirm both rate fields in `PayrollRateSettings.tsx` save and that a guard calling `my_hourly_rate()` only ever gets `guard_hourly_rate`, never the manager's.
