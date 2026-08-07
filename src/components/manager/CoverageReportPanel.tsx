import { Alert, Card } from '@/components/ui';
import { HEBREW_DAYS } from '@/lib/dates';
import { SEGMENT_DEFS, SHIFTS, type Segment } from '@/lib/shifts';
import type { CoverageReport, Profile } from '@/types/database';

/**
 * What the roster could NOT achieve, ordered by how much it should worry a
 * manager. Every number here is recomputed by the referee from the assignments
 * that were actually stored -- it is not the solver's own account of its work.
 */
export function CoverageReportPanel({
  report,
  guards,
}: {
  report: CoverageReport;
  guards: Profile[];
}) {
  const nameOf = (id: string) => guards.find((g) => g.id === id)?.display_name ?? id.slice(0, 8);
  const dayName = (d: number) => HEBREW_DAYS[d] ?? `יום ${d}`;
  const segName = (s: string) => SEGMENT_DEFS[s as Segment]?.he ?? s;

  const clean =
    report.floor_breaches.length === 0 &&
    report.unmet_kamut.length === 0 &&
    report.target_gaps.length === 0 &&
    report.rest_violations.length === 0;

  if (clean) {
    return (
      <Alert tone="success" title="הסידור עומד בכל היעדים">
        כל חלונות הכיסוי מאוישים במלואם, כל המאבטחים הגיעו ליעד הכמות, ואין מנוחות קצרות.
      </Alert>
    );
  }

  return (
    <Card className="space-y-3">
      <p className="font-bold text-slate-900">דוח כיסוי</p>

      {report.floor_breaches.length > 0 && (
        <Alert tone="error" title={`${report.floor_breaches.length} משמרות מתחת לרצפת הבטיחות`}>
          <p className="mb-1.5">
            אין מספיק מתנדבים כדי לאייש את המינימום. שום הרצה חוזרת לא תפתור זאת - צריך לפנות
            למאבטחים.
          </p>
          <ul className="space-y-0.5">
            {report.floor_breaches.slice(0, 8).map((b, i) => (
              <li key={i}>
                יום {dayName(b.day)} · {segName(b.segment)} — {b.assigned} מתוך {b.required}
              </li>
            ))}
            {report.floor_breaches.length > 8 && (
              <li className="text-slate-500">ועוד {report.floor_breaches.length - 8}…</li>
            )}
          </ul>
        </Alert>
      )}

      {report.unmet_kamut.length > 0 && (
        <Alert tone="warn" title={`${report.unmet_kamut.length} מאבטחים מתחת ליעד הכמות`}>
          <ul className="space-y-0.5">
            {report.unmet_kamut.map((u, i) => (
              <li key={i}>
                {nameOf(u.guard_id)} — שובץ {u.assigned} מתוך {u.effective_kamut}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {report.rest_violations.length > 0 && (
        <Alert tone="warn" title={`${report.rest_violations.length} מנוחות של 8 שעות`}>
          <p className="mb-1.5">מותר, אך לא מומלץ. המנוע מעדיף 12 שעות מנוחה ומעלה.</p>
          <ul className="space-y-0.5">
            {report.rest_violations.slice(0, 6).map((r, i) => (
              <li key={i}>
                {nameOf(r.guard_id)} — {SHIFTS[r.from].he} ביום {dayName(r.day)} ואז{' '}
                {SHIFTS[r.to].he} למחרת
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {report.target_gaps.length > 0 && (
        <Alert tone="info" title={`${report.target_gaps.length} מקומות פנויים מתחת ליעד`}>
          מעל רצפת הבטיחות, אך לא מלא. זה תקין כשאין מספיק זמינות - הרצפה היא מה שחייב להתקיים.
        </Alert>
      )}
    </Card>
  );
}
