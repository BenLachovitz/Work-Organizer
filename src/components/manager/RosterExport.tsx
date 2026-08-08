import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card } from '@/components/ui';
import {
  canShareImage,
  downloadBlob,
  renderRosterImage,
  rosterFileName,
} from '@/lib/exportRoster';
import { formatWeekRange, type DateKey } from '@/lib/dates';
import type { MorningTarget } from '@/lib/shifts';
import type { Profile, ScheduleAssignment } from '@/types/database';

/**
 * Exporting the published roster as a picture, for the team's WhatsApp group.
 *
 * Offered ONLY for a published run. A draft is a proposal the manager is still
 * moving people around in; once an image of it is in the group chat it is a
 * roster as far as eight guards are concerned, and no later edit catches up
 * with it. Publishing is the moment the roster becomes a promise, so it is the
 * moment it becomes shareable.
 *
 * A preview is shown rather than just a button. The manager is about to send
 * this to the whole team, and the one thing worse than no export is an export
 * with somebody's name cut off -- so they see the actual image first.
 */
export function RosterExport({
  weekStart,
  morningTarget,
  assignments,
  guards,
}: {
  weekStart: DateKey;
  morningTarget: MorningTarget;
  assignments: ScheduleAssignment[];
  guards: Profile[];
}) {
  const [busy, setBusy] = useState<'png' | 'jpeg' | 'share' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // Probed once. The answer cannot change mid-session, and building a throwaway
  // File on every render to ask again would be pure waste.
  const [shareable] = useState(canShareImage);

  // The parent rebuilds `assignments` with .filter() on every render, so its
  // identity churns even when nothing changed. Keying the effect on CONTENT
  // stops the preview being torn down and redrawn on every unrelated re-render.
  const signature = useMemo(
    () =>
      [
        weekStart,
        morningTarget,
        guards.length,
        ...assignments
          .map((a) => `${a.target_date}|${a.shift}|${a.guard_id}`)
          .sort(),
      ].join(','),
    [weekStart, morningTarget, assignments, guards],
  );

  // Rendering is cheap, but the roster changes under this component whenever
  // the manager edits or switches version -- so the preview is rebuilt from the
  // current assignments, never cached across them.
  useEffect(() => {
    let alive = true;
    let url: string | null = null;

    void renderRosterImage({ weekStart, morningTarget, assignments, guards }, 'png')
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setPreview(url);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'שגיאה'));

    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
    // Content, not identity -- see `signature`.
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const build = async (format: 'png' | 'jpeg') =>
    renderRosterImage({ weekStart, morningTarget, assignments, guards }, format);

  const onDownload = async (format: 'png' | 'jpeg') => {
    setBusy(format);
    setError(null);
    try {
      downloadBlob(await build(format), rosterFileName(weekStart, format));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'יצירת התמונה נכשלה.');
    } finally {
      setBusy(null);
    }
  };

  const onShare = async () => {
    setBusy('share');
    setError(null);
    try {
      const blob = await build('png');
      const file = new File([blob], rosterFileName(weekStart, 'png'), { type: 'image/png' });
      await navigator.share({
        files: [file],
        title: `סידור שבועי · ${formatWeekRange(weekStart)}`,
      });
    } catch (e) {
      // Dismissing the OS share sheet rejects with AbortError. That is the
      // manager changing their mind, not a failure -- saying "it failed" would
      // be a lie and would send them looking for a problem.
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError(e instanceof Error ? e.message : 'השיתוף נכשל.');
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3">
        <p className="font-bold text-slate-900">שליחת הסידור לקבוצה</p>
        <p className="mt-0.5 text-sm text-slate-500">
          תמונה של הסידור המפורסם, מוכנה לשליחה בוואטסאפ.
        </p>
      </div>

      {error && (
        <div className="px-4 pt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      <div className="p-4">
        <div className="overflow-hidden rounded-xl bg-slate-100 ring-1 ring-slate-200">
          {preview ? (
            // Squeezed into a phone-width card the names are too small to
            // check, which is the one thing the preview is for. Opening it
            // shows the image at full size.
            <a href={preview} target="_blank" rel="noreferrer" title="פתיחה בגודל מלא">
              <img src={preview} alt="תצוגה מקדימה של הסידור" className="w-full" />
            </a>
          ) : (
            <div className="grid h-40 place-items-center text-sm text-slate-400">
              מכין תצוגה מקדימה…
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {shareable && (
            <Button
              className="flex-1"
              loading={busy === 'share'}
              disabled={!preview || busy !== null}
              onClick={() => void onShare()}
            >
              שיתוף
            </Button>
          )}
          <Button
            className="flex-1"
            variant={shareable ? 'secondary' : 'primary'}
            loading={busy === 'png'}
            disabled={!preview || busy !== null}
            onClick={() => void onDownload('png')}
          >
            הורדה PNG
          </Button>
          <Button
            className="flex-1"
            variant="secondary"
            loading={busy === 'jpeg'}
            disabled={!preview || busy !== null}
            onClick={() => void onDownload('jpeg')}
          >
            הורדה JPEG
          </Button>
        </div>

        <p className="mt-2 text-xs text-slate-400">
          PNG חד יותר לטקסט; JPEG קל יותר. וואטסאפ דוחס בכל מקרה.
        </p>
      </div>
    </Card>
  );
}
