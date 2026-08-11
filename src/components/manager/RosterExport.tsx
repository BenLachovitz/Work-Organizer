import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card } from '@/components/ui';
import { downloadBlob, renderRosterImage, rosterFileName } from '@/lib/exportRoster';
import type { DateKey } from '@/lib/dates';
import type { MorningTarget, MorningTargetOverrides, SecondaryTargetOverrides } from '@/lib/shifts';
import type { Profile, ScheduleAssignment } from '@/types/database';

/**
 * Exporting the published roster as a JPEG, for the team's WhatsApp group.
 *
 * Offered ONLY for a published run. A draft is a proposal the manager is still
 * moving people around in; once an image of it is in the group chat it is a
 * roster as far as eight guards are concerned, and no later edit catches up
 * with it. Publishing is the moment the roster becomes a promise, so it is the
 * moment it becomes shareable.
 *
 * The preview lives behind a button rather than inline. RosterExport is always
 * rendered directly under the on-screen RosterGrid it is a picture OF -- an
 * inline preview would put the same grid on screen twice at once. Opening it
 * in a lightbox is also the only way to actually check it: shrunk to card
 * width, the names are too small to read, which is the one check this exists
 * for.
 */
export function RosterExport({
  weekStart,
  morningTarget,
  morningTargetOverrides,
  segmentTargetOverrides,
  assignments,
  guards,
}: {
  weekStart: DateKey;
  morningTarget: MorningTarget;
  /** Per-day exceptions to morningTarget for this week (§1). */
  morningTargetOverrides?: MorningTargetOverrides;
  /** S2/S3/S4's own, independent per-day exceptions to their flat target of 2 (§1). */
  segmentTargetOverrides?: SecondaryTargetOverrides;
  assignments: ScheduleAssignment[];
  guards: Profile[];
}) {
  const [image, setImage] = useState<{ url: string; blob: Blob } | null>(null);
  const [busy, setBusy] = useState<'preview' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // The parent rebuilds `assignments` with .filter() on every render, so its
  // identity churns even when nothing changed. Rendering is not free enough to
  // redo on every unrelated re-render, so a stale cached image is invalidated
  // by CONTENT rather than by array identity.
  const signature = useMemo(
    () =>
      [
        weekStart,
        morningTarget,
        JSON.stringify(morningTargetOverrides ?? {}),
        JSON.stringify(segmentTargetOverrides ?? {}),
        guards.length,
        ...assignments.map((a) => `${a.target_date}|${a.shift}|${a.guard_id}`).sort(),
      ].join(','),
    [weekStart, morningTarget, morningTargetOverrides, segmentTargetOverrides, assignments, guards],
  );

  useEffect(() => {
    setImage((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    // Content, not identity -- see `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image.url);
    },
    [image],
  );

  const ensureImage = async () => {
    if (image) return image;
    const blob = await renderRosterImage({
      weekStart,
      morningTarget,
      morningTargetOverrides,
      segmentTargetOverrides,
      assignments,
      guards,
    });
    const built = { url: URL.createObjectURL(blob), blob };
    setImage(built);
    return built;
  };

  const onPreview = async () => {
    setBusy('preview');
    setError(null);
    try {
      await ensureImage();
      setOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'יצירת התמונה נכשלה.');
    } finally {
      setBusy(null);
    }
  };

  const onDownload = async () => {
    setBusy('download');
    setError(null);
    try {
      const built = await ensureImage();
      downloadBlob(built.blob, rosterFileName(weekStart));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'יצירת התמונה נכשלה.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <p className="font-bold text-slate-900 dark:text-slate-100">שליחת הסידור לקבוצה</p>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          תמונה של הסידור המפורסם, מוכנה לשליחה בוואטסאפ.
        </p>
      </div>

      {error && (
        <div className="px-4 pt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      <div className="flex gap-2 p-4">
        <Button
          className="flex-1"
          variant="secondary"
          loading={busy === 'preview'}
          disabled={busy !== null}
          onClick={() => void onPreview()}
        >
          תצוגה מקדימה
        </Button>
        <Button
          className="flex-1"
          loading={busy === 'download'}
          disabled={busy !== null}
          onClick={() => void onDownload()}
        >
          הורדת JPEG
        </Button>
      </div>

      {open && image && (
        <PreviewModal url={image.url} onClose={() => setOpen(false)} onDownload={onDownload} />
      )}
    </Card>
  );
}

function PreviewModal({
  url,
  onClose,
  onDownload,
}: {
  url: string;
  onClose: () => void;
  onDownload: () => Promise<void>;
}) {
  // Esc closes it -- the manager is about to send this to the whole team, and
  // a modal with no keyboard escape reads as stuck, not careful.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <p className="font-bold text-slate-900 dark:text-slate-100">תצוגה מקדימה</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="סגירה"
          >
            <svg className="size-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M4.3 4.3a1 1 0 0 1 1.4 0L10 8.6l4.3-4.3a1 1 0 1 1 1.4 1.4L11.4 10l4.3 4.3a1 1 0 0 1-1.4 1.4L10 11.4l-4.3 4.3a1 1 0 0 1-1.4-1.4L8.6 10 4.3 5.7a1 1 0 0 1 0-1.4Z" />
            </svg>
          </button>
        </div>
        <div className="overflow-auto p-3">
          <img src={url} alt="תצוגה מקדימה של הסידור" className="w-full rounded-lg" />
        </div>
        <div className="border-t border-slate-200 p-3 dark:border-slate-800">
          <Button fullWidth onClick={() => void onDownload()}>
            הורדת JPEG
          </Button>
        </div>
      </div>
    </div>
  );
}
