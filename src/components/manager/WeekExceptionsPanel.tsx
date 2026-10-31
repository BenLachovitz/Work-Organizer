import { Alert, Button, Collapsible, cn } from '@/components/ui';
import { HEBREW_DAYS } from '@/lib/dates';
import {
  SEGMENT_DEFS,
  morningTargetForDay,
  secondaryTargetForDay,
  segmentFloors,
  type DoubleShiftHours,
  type MorningTarget,
  type MorningTargetOverrides,
  type SecondarySegment,
  type SecondaryTarget,
  type SecondaryTargetOverrides,
} from '@/lib/shifts';
import type { RosterWeek } from '@/types/database';

/** Every day of the week is overridable for all four segments, including
 *  morning (migration 57) -- only the STANDING week-level morning target
 *  toggle above this section stays weekday-only. */
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** Segment-level per-day overrides shown in the "החרגה ליום ספציפי" section.
 *  Morning's value range is 1/2/3 (SEGMENT_DEFS.S1); S2/S3/S4 stay 1/2 --
 *  they have no "raised" tier the way morning does. */
const SECONDARY_SEGMENTS: SecondarySegment[] = ['S2', 'S3', 'S4'];

/**
 * This week's exceptions to the standing scheduler defaults (§ManagerSettings):
 * the selected week's own morning target, its per-day morning/S2/S3/S4
 * overrides, and the double-shift display-hours toggle. Grouped together and
 * collapsed by default -- occasional-use controls, deliberately kept on this
 * page rather than a separate route because changing any of them has an
 * immediate, visible effect on CoverageMatrix directly below on the same
 * page; a route would force tabbing back and forth just to see that effect.
 *
 * Double-shift-hours is a purely cosmetic display setting, not a coverage
 * target like the other two -- there's no standing/global equivalent of it
 * to split it out to, so it stays here but under its own "תצוגה" heading
 * rather than blurred into the coverage-target list above it.
 */
export function WeekExceptionsPanel({
  week,
  onSetMorningTarget,
  morningTargetOverrides,
  onSetDayOverride,
  segmentTargetOverrides,
  onSetSegmentDayOverride,
  onSetDoubleShiftHours,
  onSetAsNewNormal,
  settingNewNormal,
  newNormalSuccess,
  newNormalError,
  saving,
}: {
  week: RosterWeek | null;
  onSetMorningTarget: (t: MorningTarget) => void;
  /** Per-day exceptions to the week's own morning target, for THIS week only
   *  (§1) -- e.g. a holiday week needing Mon-Wed at 2 but Thu-Fri at 3. */
  morningTargetOverrides: MorningTargetOverrides;
  onSetDayOverride: (dayIndex: number, target: MorningTarget) => void;
  /** S2/S3/S4's own, independent per-day exceptions to their flat target of
   *  2 (§1) -- e.g. a quiet Sunday needing only 1 guard overnight. */
  segmentTargetOverrides: SecondaryTargetOverrides;
  onSetSegmentDayOverride: (
    dayIndex: number,
    segment: SecondarySegment,
    target: SecondaryTarget,
  ) => void;
  onSetDoubleShiftHours: (h: DoubleShiftHours) => void;
  /** Snapshots this week's per-day overrides + display-hours setting into
   *  the standing defaults every future week is seeded from (migration 67)
   *  -- a deliberate, separate action, never automatic, so a one-off
   *  special week never silently becomes next month's standard. */
  onSetAsNewNormal: () => void;
  settingNewNormal: boolean;
  newNormalSuccess: boolean;
  newNormalError: string | null;
  saving: boolean;
}) {
  if (!week) return null;

  const target = (week.morning_target_slots ?? 2) as MorningTarget;
  // Day index 1 (Monday) stands for a working day; the setting only ever
  // differs between Mon-Fri and the weekend.
  const workingFloor = segmentFloors(target, 1).S1;
  const totalOverrideCount =
    Object.keys(morningTargetOverrides).length +
    SECONDARY_SEGMENTS.reduce((n, seg) => n + Object.keys(segmentTargetOverrides[seg] ?? {}).length, 0);

  return (
    <Collapsible
      variant="card"
      title="חריגות לשבוע זה"
      summary={
        totalOverrideCount > 0
          ? `יעד בוקר ${target} · ${totalOverrideCount} חריגות יום`
          : `יעד בוקר ${target} · ללא חריגות יום`
      }
      defaultExpanded={false}
    >
      <div className="space-y-4">
        {/* ---------------- coverage-target exceptions ---------------- */}
        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            יעדי כיסוי חריגים
          </p>

          <div>
            <p className="mb-1 text-sm font-bold text-slate-700 dark:text-slate-300">
              יעד משמרת בוקר{' '}
              <span className="font-normal text-slate-400 dark:text-slate-500">
                · ימי שני-שישי
              </span>
            </p>
            <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
              מספר המאבטחים הרצוי במשמרת הבוקר בימי העבודה. הרצפה נגזרת אוטומטית.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {([2, 3] as MorningTarget[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={saving}
                  onClick={() => onSetMorningTarget(t)}
                  className={cn(
                    'rounded-xl border-2 px-3 py-2.5 text-center transition-all disabled:opacity-50',
                    target === t
                      ? 'border-brand-600 bg-brand-50 dark:bg-brand-950/50'
                      : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600',
                  )}
                >
                  <span className="block text-lg font-extrabold text-slate-900 dark:text-slate-100">
                    {t}
                  </span>
                  <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                    רצפה {segmentFloors(t, 1).S1}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              ימי שני-שישי: יעד {target}, לפחות {workingFloor} מאבטחים במשמרת.
            </p>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              שבת וראשון הם ימי מנוחה - יעד הבוקר בהם תמיד 2, גם כשנבחר 3.
            </p>
          </div>

          <div className="mt-3">
            <Collapsible
              variant="plain"
              title={
                <>
                  החרגה ליום ספציפי
                  {totalOverrideCount > 0 && (
                    <span className="ms-1.5 font-normal text-brand-600 dark:text-brand-400">
                      ({totalOverrideCount} חריגות)
                    </span>
                  )}
                </>
              }
            >
              <div className="space-y-2">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  לשבוע חריג (למשל חג, או יום מצוקת כוח אדם) אפשר לקבוע יעד שונה מהיעד הרגיל ליום
                  ספציפי -- לבוקר, לצהריים המוקדם/המאוחר וללילה, בכל יום בשבוע כולל שבת וראשון. יום
                  שלא הוחרג ימשיך אחרי היעד הרגיל למעלה, גם אם הוא ישתנה בהמשך.
                </p>
                {ALL_DAYS.map((dayIndex) => (
                  <div
                    key={dayIndex}
                    className="rounded-lg bg-slate-50 px-2.5 py-1.5 dark:bg-slate-800"
                  >
                    <p className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-300">
                      יום {HEBREW_DAYS[dayIndex]}
                    </p>
                    <div className="space-y-1">
                      <SegmentOverrideRow
                        label={SEGMENT_DEFS.S1.he}
                        options={[1, 2, 3]}
                        effective={morningTargetForDay(target, dayIndex, morningTargetOverrides)}
                        overridden={morningTargetOverrides[String(dayIndex)] != null}
                        saving={saving}
                        onSelect={(t) => onSetDayOverride(dayIndex, t as MorningTarget)}
                      />
                      {SECONDARY_SEGMENTS.map((seg) => (
                        <SegmentOverrideRow
                          key={seg}
                          label={SEGMENT_DEFS[seg].he}
                          options={[1, 2]}
                          effective={secondaryTargetForDay(seg, dayIndex, segmentTargetOverrides)}
                          overridden={segmentTargetOverrides[seg]?.[String(dayIndex)] != null}
                          saving={saving}
                          onSelect={(t) => onSetSegmentDayOverride(dayIndex, seg, t as SecondaryTarget)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Collapsible>
          </div>
        </div>

        {/* ---------------- display-only ---------------- */}
        <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            תצוגה
          </p>
          <p className="mb-1 text-sm font-bold text-slate-700 dark:text-slate-300">
            תצוגת משמרת כפולה (12 שעות)
          </p>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            המשמרת עצמה תמיד נספרת כ-12 שעות מלאות בכיסוי, בכמות ובמנוחה. הבחירה כאן משנה רק את
            השעה המוצגת ליד השם -- "עד 17:45" במקום "עד 18:45", או "מ 19:45" במקום "מ 18:45".
            כשאין כיסוי אחר לצהריים באותו יום, התצוגה נשארת 12 שעות כדי לא לרמוז על שעה ריקה בפועל.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {([12, 11] as DoubleShiftHours[]).map((h) => (
              <button
                key={h}
                type="button"
                disabled={saving}
                onClick={() => onSetDoubleShiftHours(h)}
                className={cn(
                  'rounded-xl border-2 px-3 py-2.5 text-center transition-all disabled:opacity-50',
                  (week.double_shift_display_hours ?? 12) === h
                    ? 'border-brand-600 bg-brand-50 dark:bg-brand-950/50'
                    : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600',
                )}
              >
                <span className="block text-lg font-extrabold text-slate-900 dark:text-slate-100">
                  {h} שעות
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* ---------------- make this week's setup the new standard ---------------- */}
        <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
          <p className="mb-1 text-sm font-bold text-slate-700 dark:text-slate-300">
            קביעת ברירת המחדל הקבועה
          </p>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            החרגות היום והתצוגה של שבוע זה יהפכו לברירת המחדל שכל שבוע חדש ייפתח איתה מעכשיו, עד
            שתלחץ שוב. לא משנה שבועות שכבר נוצרו, ולא נוגע ביעד הבוקר הרגיל (יש לו ברירת מחדל
            משלו בהגדרות).
          </p>
          {newNormalError && <Alert tone="error">{newNormalError}</Alert>}
          {newNormalSuccess && !newNormalError && (
            <Alert tone="success">נשמר - כך ייראה כל שבוע חדש מעכשיו.</Alert>
          )}
          <Button
            size="sm"
            variant="secondary"
            fullWidth
            loading={settingNewNormal}
            onClick={onSetAsNewNormal}
            className="mt-2"
          >
            קביעת ברירת המחדל הקבועה
          </Button>
        </div>
      </div>
    </Collapsible>
  );
}

/** One segment's toggle row inside a day's per-day-override card -- the same
 *  small inline toggle style the morning row used before this section grew
 *  to cover S2/S3/S4 too, just reused per segment instead of duplicated. */
function SegmentOverrideRow({
  label,
  options,
  effective,
  overridden,
  saving,
  onSelect,
}: {
  label: string;
  options: readonly number[];
  effective: number;
  overridden: boolean;
  saving: boolean;
  onSelect: (t: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">
        {label}
        {overridden && (
          <span className="ms-1.5 text-[10px] font-bold text-brand-600 dark:text-brand-400">
            הוחרג
          </span>
        )}
      </span>
      <div className="flex gap-1.5">
        {options.map((t) => (
          <button
            key={t}
            type="button"
            disabled={saving}
            onClick={() => onSelect(t)}
            className={cn(
              'rounded-lg border-2 px-2.5 py-1 text-sm font-bold transition-all disabled:opacity-50',
              effective === t
                ? 'border-brand-600 bg-brand-50 text-brand-800 dark:bg-brand-950/50 dark:text-brand-300'
                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600',
            )}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
