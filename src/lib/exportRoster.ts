import {
  HEBREW_DAYS_SHORT,
  formatWeekRange,
  parseDateKey,
  weekDates,
  type DateKey,
} from '@/lib/dates';
import {
  SHIFTS,
  isWeekendDay,
  segmentFloors,
  segmentTargets,
  type MorningTarget,
  type MorningTargetOverrides,
  type Segment,
  type SecondaryTargetOverrides,
} from '@/lib/shifts';
import type { Profile, ScheduleAssignment } from '@/types/database';

/**
 * Renders a published roster as an image for sending to the team.
 *
 * The grid is DRAWN onto a canvas rather than screenshotted from the DOM. That
 * is a deliberate trade: a DOM-to-canvas library would track the styling for
 * free, but it also has to reimplement a browser's layout engine, and this app
 * is exactly the kind that breaks it -- Tailwind v4 emits oklch() colours,
 * shift colours come from CSS custom properties, and chips carry rings and
 * gradients. Half-rendered output would be worse than none, since the manager
 * would not notice until the picture was already in the group chat.
 *
 * Drawing also lets the image be built FOR its destination. What works on a
 * phone at 390px -- 11px text, a table that scrolls sideways -- is unreadable
 * as a WhatsApp thumbnail. So the type is larger, nothing scrolls, and the week
 * and legend are printed on the image itself, because a picture in a chat
 * arrives with no page around it to explain it.
 *
 * The layout still mirrors RosterGrid rule for rule: same three blocks, same
 * "עד 18:45" annotations, same 18:45 handover in one afternoon cell, same
 * coverage tinting. If one changes, change both.
 */

const SCALE = 2; // drawn at 2x so the text stays crisp when a phone scales it up

const FONT = "Heebo, system-ui, -apple-system, 'Segoe UI', Arial, sans-serif";
const PAD = 28;
const TITLE_H = 78;
const HEADER_H = 52;
const LABEL_W = 104;
const CELL_PAD = 8;
const CHIP_H = 34;
const CHIP_GAP = 6;
const CHIP_PAD_X = 12;
const NAME_SUFFIX_GAP = 6;
const HANDOVER_GAP = 10; // either side of the slash
const SLASH_W = 10;
const MIN_COL = 132;
const LEGEND_H = 54;
const FOOTER_H = 34;

const NAME_FONT = `600 17px ${FONT}`;
const SUFFIX_FONT = `400 13px ${FONT}`;
const DAY_FONT = `700 18px ${FONT}`;
const DATE_FONT = `400 14px ${FONT}`;
const BLOCK_FONT = `700 16px ${FONT}`;
const BLOCK_TIME_FONT = `400 13px ${FONT}`;
const TITLE_FONT = `800 26px ${FONT}`;
const SUBTITLE_FONT = `400 16px ${FONT}`;
const LEGEND_FONT = `600 14px ${FONT}`;
const FOOTER_FONT = `400 13px ${FONT}`;

const INK = '#0f172a';
const MUTED = '#64748b';
const FAINT = '#94a3b8';
const WEEKEND = '#d97706';
const PAPER = '#ffffff';

/** Cell tints, matching the ring/bg pairs RosterGrid uses on screen. */
const TONES = {
  below: { fill: '#fff1f2', stroke: '#fda4af' },
  short: { fill: '#fffbeb', stroke: '#fde68a' },
  ok: { fill: '#f0fdf4', stroke: '#bbf7d0' },
} as const;

const EMPTY_INK = '#e11d48';
const GAP_FILL = '#ffe4e6';
const GAP_INK = '#fb7185';

export interface RosterImageInput {
  weekStart: DateKey;
  morningTarget: MorningTarget;
  /** Per-day exceptions to morningTarget for this week (§1). */
  morningTargetOverrides?: MorningTargetOverrides;
  /** S2/S3/S4's own, independent per-day exceptions to their flat target of 2 (§1). */
  segmentTargetOverrides?: SecondaryTargetOverrides;
  assignments: ScheduleAssignment[];
  guards: Profile[];
  /** Printed under the title. Defaults to the week range. */
  subtitle?: string;
}

/**
 * Resolves the shift palette from CSS rather than duplicating the hex codes.
 *
 * SHIFTS[x].colorVar is a `var(--color-shift-*)` reference, which means nothing
 * to a canvas. Reading the computed value keeps one source of truth: recolour a
 * shift in index.css and the exported image follows.
 *
 * Dark mode overrides these same variables under `.dark` (index.css) so the
 * on-screen chips read a shade less vivid against a dark background -- but the
 * export is a picture that ends up in the team's WhatsApp group regardless of
 * which theme the manager happened to be in, so it must always match the one
 * canonical (light) palette. `.dark` is stripped from <html> for the instant it
 * takes to read the computed values, then restored -- synchronous, so nothing
 * else observes the flip.
 */
function shiftColors(): Record<string, string> {
  const root = document.documentElement;
  const wasDark = root.classList.contains('dark');
  if (wasDark) root.classList.remove('dark');

  const style = getComputedStyle(root);
  const out: Record<string, string> = {};
  for (const [key, def] of Object.entries(SHIFTS)) {
    const name = def.colorVar.replace(/^var\(|\)$/g, '').trim();
    out[key] = style.getPropertyValue(name).trim() || '#64748b';
  }

  if (wasDark) root.classList.add('dark');
  return out;
}

/**
 * ctx.roundRect is recent enough that an older phone may not have it, and a
 * missing method would throw halfway through drawing -- leaving the manager
 * with an error instead of a roster. arcTo has been there forever.
 */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const rad = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** A guard's manager-written before/after notes for this cell (§2.2c). */
interface CellNotes {
  notePrefix?: string;
  noteSuffix?: string;
}

/** One drawable line inside a cell: a single chip, an empty slot, or a two-name handover. */
type Row =
  | ({ kind: 'chip'; shift: string; name: string; suffix?: string } & CellNotes)
  | { kind: 'gap' }
  | {
      kind: 'handover';
      early: ({ shift: string; name: string } & CellNotes) | null;
      late: ({ shift: string; name: string } & CellNotes) | null;
    };

/**
 * The rows for one cell, derived exactly as RosterGrid derives them.
 *
 * A day12 guard therefore appears twice -- in the morning block and as the
 * first half of an afternoon handover -- because that is what they are working.
 *
 * Filled-but-short of `target` gets a dash per missing guard (the same
 * "shown, not hidden" convention as an unpaired handover half). A block with
 * nobody at all stays "ריק" (drawn by the caller when `rows.length === 0`)
 * -- the stronger signal for nobody, versus this one for short-staffed.
 */
function rowsFor(
  block: 'morning' | 'afternoon' | 'night',
  day: ScheduleAssignment[],
  nameOf: (id: string | null) => string,
  target = 0,
): Row[] {
  if (block === 'morning') {
    const dayRows = day.filter((a) => a.shift === 'morning' || a.shift === 'day12');
    const rows: Row[] = dayRows.map((a) => ({
      kind: 'chip' as const,
      shift: a.shift,
      name: nameOf(a.guard_id),
      suffix: a.shift === 'day12' ? 'עד 18:45' : undefined,
      notePrefix: a.note_before ?? undefined,
      noteSuffix: a.note_after ?? undefined,
    }));
    if (rows.length > 0) {
      // A placeholder (§12.9) renders as an extra chip but is not a real
      // body -- padding is driven by the REAL count, or a cosmetic note
      // could hide a genuine shortfall.
      const realCount = dayRows.filter((a) => a.guard_id != null).length;
      for (let i = realCount; i < target; i++) rows.push({ kind: 'gap' });
    }
    return rows;
  }
  if (block === 'night') {
    const dayRows = day.filter((a) => a.shift === 'night' || a.shift === 'night12');
    const rows: Row[] = dayRows.map((a) => ({
      kind: 'chip' as const,
      shift: a.shift,
      name: nameOf(a.guard_id),
      suffix: a.shift === 'night12' ? 'מ 18:45' : undefined,
      notePrefix: a.note_before ?? undefined,
      noteSuffix: a.note_after ?? undefined,
    }));
    if (rows.length > 0) {
      const realCount = dayRows.filter((a) => a.guard_id != null).length;
      for (let i = realCount; i < target; i++) rows.push({ kind: 'gap' });
    }
    return rows;
  }

  const fullAssignments = day.filter((a) => a.shift === 'afternoon');
  const rows: Row[] = fullAssignments.map((a) => ({
    kind: 'chip' as const,
    shift: a.shift,
    name: nameOf(a.guard_id),
    notePrefix: a.note_before ?? undefined,
    noteSuffix: a.note_after ?? undefined,
  }));

  const early = day.filter((a) => a.shift === 'day12');
  const late = day.filter((a) => a.shift === 'night12');
  for (let i = 0; i < Math.max(early.length, late.length); i++) {
    rows.push({
      kind: 'handover',
      early: early[i]
        ? {
            shift: 'day12',
            name: nameOf(early[i]!.guard_id),
            notePrefix: early[i]!.note_before ?? undefined,
            noteSuffix: early[i]!.note_after ?? undefined,
          }
        : null,
      late: late[i]
        ? {
            shift: 'night12',
            name: nameOf(late[i]!.guard_id),
            notePrefix: late[i]!.note_before ?? undefined,
            noteSuffix: late[i]!.note_after ?? undefined,
          }
        : null,
    });
  }
  // Filled but short of target: a slot with neither a full-block guard nor
  // either handover half is drawn the same single-dash way morning/night mark
  // a missing guard -- there's nothing to say it would have been a handover
  // rather than a plain shift. A block with nobody at all stays "ריק",
  // drawn by the caller when rows.length === 0 (checked before any padding).
  if (rows.length > 0) {
    // Same real-vs-rendered split as morning/night, generalised to the
    // handover pairing: a pair counts as real if either half is real.
    const realFull = fullAssignments.filter((a) => a.guard_id != null).length;
    let realPairs = 0;
    for (let i = 0; i < Math.max(early.length, late.length); i++) {
      if (early[i]?.guard_id != null || late[i]?.guard_id != null) realPairs++;
    }
    const realRows = realFull + realPairs;
    for (let i = realRows; i < target; i++) rows.push({ kind: 'gap' });
  }
  return rows;
}

const BLOCKS = [
  { key: 'morning', he: 'בוקר', label: '06:45-14:45', segs: ['S1'] as Segment[] },
  { key: 'afternoon', he: 'צהריים', label: '14:45-22:45', segs: ['S2', 'S3'] as Segment[] },
  { key: 'night', he: 'לילה', label: '22:45-06:45', segs: ['S4'] as Segment[] },
] as const;

const LEGEND = [
  { shift: 'morning', he: 'בוקר' },
  { shift: 'day12', he: 'יום 12ש׳' },
  { shift: 'afternoon', he: 'צהריים' },
  { shift: 'night12', he: 'לילה 12ש׳' },
  { shift: 'night', he: 'לילה' },
] as const;

/**
 * Draws the roster and returns it as a JPEG blob.
 *
 * JPEG only -- this exists to post into the team's WhatsApp group, where a
 * smaller file matters and nothing in a solid-colour chip grid benefits from
 * PNG's lossless edges.
 *
 * Awaits the web font first: a canvas silently falls back to a system face if
 * Heebo has not loaded, which both looks wrong and measures wrong, so the
 * columns would be sized for one font and painted in another.
 */
export async function renderRosterImage(input: RosterImageInput): Promise<Blob> {
  await document.fonts?.ready;

  const { weekStart, morningTarget, morningTargetOverrides, segmentTargetOverrides, assignments, guards } =
    input;
  const dates = weekDates(weekStart);
  const colors = shiftColors();
  // A placeholder (id === null) has no name at all -- '' lets the note text
  // carry the whole chip, distinct from '—', which flags a real data problem.
  const nameOf = (id: string | null) => (id ? (guards.find((g) => g.id === id)?.display_name ?? '—') : '');

  const measurer = document.createElement('canvas').getContext('2d');
  if (!measurer) throw new Error('לא ניתן ליצור תמונה בדפדפן הזה.');

  const textW = (text: string, font: string) => {
    measurer.font = font;
    return measurer.measureText(text).width;
  };

  const onDay = (date: DateKey) => assignments.filter((a) => a.target_date === date);

  // --- layout ---------------------------------------------------------------
  // Same rule as the on-screen grid: every column is the width of the widest
  // cell anywhere in the table, so the columns line up and nothing truncates.
  const grid = dates.map((date, di) => {
    const day = onDay(date);
    const targets = segmentTargets(morningTarget, di, morningTargetOverrides, segmentTargetOverrides);
    return BLOCKS.map((b) =>
      rowsFor(
        b.key,
        day,
        nameOf,
        // Afternoon's early (S2) and late (S3) halves can now carry independent
        // targets -- pad up to whichever demands more rows, same as
        // buildAfternoonRows() in RosterGrid.tsx.
        b.key === 'morning'
          ? targets.S1
          : b.key === 'night'
            ? targets.S4
            : Math.max(targets.S2, targets.S3),
      ),
    );
  });

  // Up to four parts share the chip: a before-note, the name, an after-note,
  // and the 12h suffix -- same generalisation as measureColumns.ts's
  // chipWidth(). Missing parts contribute neither width nor a gap.
  const chipW = (name: string, suffix?: string, notePrefix?: string, noteSuffix?: string) => {
    const parts: { text: string; font: string }[] = [];
    if (notePrefix) parts.push({ text: notePrefix, font: SUFFIX_FONT });
    // A placeholder (§12.9) has no name -- nameOf() returns '' for it, and an
    // empty part would still cost a gap on either side for nothing.
    if (name) parts.push({ text: name, font: NAME_FONT });
    if (noteSuffix) parts.push({ text: noteSuffix, font: SUFFIX_FONT });
    if (suffix) parts.push({ text: suffix, font: SUFFIX_FONT });
    const textWidth = parts.reduce((sum, p) => sum + textW(p.text, p.font), 0);
    return textWidth + Math.max(0, parts.length - 1) * NAME_SUFFIX_GAP + CHIP_PAD_X * 2;
  };

  let colWidth = MIN_COL;
  for (const blocks of grid) {
    for (const rows of blocks) {
      for (const row of rows) {
        if (row.kind === 'chip') {
          colWidth = Math.max(
            colWidth,
            chipW(row.name, row.suffix, row.notePrefix, row.noteSuffix) + CELL_PAD * 2,
          );
        } else if (row.kind === 'handover') {
          // Both halves are drawn the same width, so the cell must fit twice
          // the LONGER name -- not their sum, which would let a short name
          // donate space its neighbour never receives.
          const a = chipW(row.early?.name ?? '—', undefined, row.early?.notePrefix, row.early?.noteSuffix);
          const b = chipW(row.late?.name ?? '—', undefined, row.late?.notePrefix, row.late?.noteSuffix);
          colWidth = Math.max(
            colWidth,
            2 * Math.max(a, b) + SLASH_W + HANDOVER_GAP * 2 + CELL_PAD * 2,
          );
        }
      }
    }
  }
  colWidth = Math.ceil(colWidth);

  // Each block row is as tall as its fullest cell across the week; an empty
  // cell still needs room for the "ריק" marker.
  const rowHeights = BLOCKS.map((_, bi) => {
    const maxRows = Math.max(1, ...grid.map((blocks) => blocks[bi]!.length));
    return maxRows * CHIP_H + (maxRows - 1) * CHIP_GAP + CELL_PAD * 2;
  });

  const gridW = LABEL_W + colWidth * 7;
  const width = PAD * 2 + gridW;
  const height =
    PAD * 2 + TITLE_H + HEADER_H + rowHeights.reduce((a, b) => a + b, 0) + LEGEND_H + FOOTER_H;

  // --- canvas ---------------------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('לא ניתן ליצור תמונה בדפדפן הזה.');
  ctx.scale(SCALE, SCALE);
  // Hebrew throughout. Digits inside a string ("עד 18:45") stay left-to-right
  // on their own; the bidi algorithm handles that without help.
  ctx.direction = 'rtl';
  ctx.textBaseline = 'middle';

  // JPEG has no alpha, so an unpainted background comes out black.
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);

  // The label column reads first in RTL, so it sits at the CANVAS's right
  // edge -- the day columns occupy the region to its left. `colRight` used to
  // start from the canvas edge directly, which left no room for the label and
  // pushed it out to the far left instead.
  const dayAreaRight = width - PAD - LABEL_W;
  /** x of a day column's right edge. Day 0 (ראשון) sits rightmost, as on screen. */
  const colRight = (i: number) => dayAreaRight - colWidth * i;

  // --- title ----------------------------------------------------------------
  ctx.textAlign = 'right';
  ctx.fillStyle = INK;
  ctx.font = TITLE_FONT;
  ctx.fillText('סידור שבועי', width - PAD, PAD + 18);
  ctx.font = SUBTITLE_FONT;
  ctx.fillStyle = MUTED;
  ctx.fillText(input.subtitle ?? formatWeekRange(weekStart), width - PAD, PAD + 48);

  const top = PAD + TITLE_H;

  // --- day headers ----------------------------------------------------------
  ctx.textAlign = 'center';
  dates.forEach((date, i) => {
    const cx = colRight(i) - colWidth / 2;
    ctx.font = DAY_FONT;
    ctx.fillStyle = isWeekendDay(i) ? WEEKEND : INK;
    ctx.fillText(HEBREW_DAYS_SHORT[i]!, cx, top + 16);
    ctx.font = DATE_FONT;
    ctx.fillStyle = FAINT;
    const d = parseDateKey(date);
    ctx.fillText(`${d.getUTCDate()}.${d.getUTCMonth() + 1}`, cx, top + 38);
  });

  // --- blocks ---------------------------------------------------------------
  let y = top + HEADER_H;

  BLOCKS.forEach((block, bi) => {
    const rowH = rowHeights[bi]!;

    // Block label, right-aligned at the canvas's own right edge -- the same
    // edge the day columns hang off of, on the near side of them.
    ctx.textAlign = 'right';
    const labelRight = width - PAD;
    ctx.font = BLOCK_FONT;
    ctx.fillStyle = INK;
    ctx.fillText(block.he, labelRight, y + rowH / 2 - 10);
    ctx.font = BLOCK_TIME_FONT;
    ctx.fillStyle = FAINT;
    ctx.fillText(block.label, labelRight, y + rowH / 2 + 12);

    dates.forEach((date, di) => {
      const day = onDay(date);
      const x = colRight(di) - colWidth + 3;
      const w = colWidth - 6;

      // Coverage tint, same thresholds the grid uses: red below the floor,
      // amber below target, green otherwise. A placeholder (§12.9) is not a
      // real body and must never count toward it.
      const covers = (seg: Segment) =>
        day.filter((a) => a.guard_id && SHIFTS[a.shift].covers.includes(seg)).length;
      const floors = segmentFloors(morningTarget, di, morningTargetOverrides, segmentTargetOverrides);
      const targets = segmentTargets(morningTarget, di, morningTargetOverrides, segmentTargetOverrides);
      const below = block.segs.some((s) => covers(s) < floors[s]);
      const short = !below && block.segs.some((s) => covers(s) < targets[s]);
      const tone = below ? TONES.below : short ? TONES.short : TONES.ok;

      ctx.fillStyle = tone.fill;
      ctx.strokeStyle = tone.stroke;
      ctx.lineWidth = 1;
      roundRect(ctx, x, y + 3, w, rowH - 6, 10);
      ctx.fill();
      ctx.stroke();

      const rows = grid[di]![bi]!;
      if (rows.length === 0) {
        ctx.textAlign = 'center';
        ctx.font = BLOCK_FONT;
        ctx.fillStyle = EMPTY_INK;
        ctx.fillText('ריק', x + w / 2, y + rowH / 2);
        return;
      }

      const innerX = x + CELL_PAD;
      const innerW = w - CELL_PAD * 2;
      rows.forEach((row, ri) => {
        const ry = y + 3 + CELL_PAD + ri * (CHIP_H + CHIP_GAP);
        if (row.kind === 'chip') {
          drawChip(
            ctx,
            innerX,
            ry,
            innerW,
            colors[row.shift]!,
            row.name,
            row.suffix,
            row.notePrefix,
            row.noteSuffix,
          );
        } else if (row.kind === 'gap') {
          drawGap(ctx, innerX, ry, innerW);
        } else {
          // The 18:45 handover. Early (day12) on the right, late (night12) on
          // the left, matching the RTL flex order on screen -- the slash IS the
          // boundary, so neither half repeats the time.
          const half = (innerW - SLASH_W - HANDOVER_GAP * 2) / 2;
          const rightX = innerX + innerW - half;
          if (row.early) {
            drawChip(
              ctx,
              rightX,
              ry,
              half,
              colors[row.early.shift]!,
              row.early.name,
              undefined,
              row.early.notePrefix,
              row.early.noteSuffix,
            );
          } else {
            drawGap(ctx, rightX, ry, half);
          }
          ctx.textAlign = 'center';
          ctx.font = BLOCK_FONT;
          ctx.fillStyle = FAINT;
          ctx.fillText('/', innerX + half + HANDOVER_GAP + SLASH_W / 2, ry + CHIP_H / 2);
          if (row.late) {
            drawChip(
              ctx,
              innerX,
              ry,
              half,
              colors[row.late.shift]!,
              row.late.name,
              undefined,
              row.late.notePrefix,
              row.late.noteSuffix,
            );
          } else {
            drawGap(ctx, innerX, ry, half);
          }
        }
      });
    });

    y += rowH;
  });

  // --- legend ---------------------------------------------------------------
  y += 14;
  let lx = width - PAD;
  ctx.textAlign = 'right';
  ctx.font = LEGEND_FONT;
  for (const item of LEGEND) {
    ctx.fillStyle = colors[item.shift]!;
    roundRect(ctx, lx - 14, y - 7, 14, 14, 4);
    ctx.fill();
    ctx.fillStyle = MUTED;
    ctx.fillText(item.he, lx - 20, y);
    lx -= 20 + ctx.measureText(item.he).width + 22;
  }

  // A picture in a chat has no page around it to say what the slash means.
  y += 26;
  ctx.font = FOOTER_FONT;
  ctx.fillStyle = FAINT;
  ctx.fillText('בצהריים, שני שמות מופרדים ב־/ הם חילוף ב־18:45 · הראשון עד, השני מ־18:45', width - PAD, y);

  return await toBlob(canvas);
}

/**
 * Draws a chip's text, in reading order: an optional manager note before the
 * name, the name itself, an optional manager note after the name, then the
 * 12h suffix. In RTL, the first part sits rightmost -- so the group is laid
 * out right-to-left from a right edge computed to keep the WHOLE group
 * centered in the chip, generalising the old name+suffix-only centering.
 */
function drawChip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  color: string,
  name: string,
  suffix?: string,
  notePrefix?: string,
  noteSuffix?: string,
) {
  ctx.fillStyle = color;
  roundRect(ctx, x, y, w, CHIP_H, 7);
  ctx.fill();

  const cy = y + CHIP_H / 2;
  ctx.fillStyle = '#ffffff';

  const parts: { text: string; font: string; muted?: boolean }[] = [];
  if (notePrefix) parts.push({ text: notePrefix, font: SUFFIX_FONT, muted: true });
  // A placeholder has no name -- nameOf() returns '' for it, and an empty
  // part would still cost a gap on either side for nothing.
  if (name) parts.push({ text: name, font: NAME_FONT });
  if (noteSuffix) parts.push({ text: noteSuffix, font: SUFFIX_FONT, muted: true });
  if (suffix) parts.push({ text: suffix, font: SUFFIX_FONT, muted: true });

  if (parts.length === 1 && parts[0]!.text === name) {
    ctx.textAlign = 'center';
    ctx.font = NAME_FONT;
    ctx.fillText(name, x + w / 2, cy, w - CHIP_PAD_X);
    return;
  }

  const widths = parts.map((p) => {
    ctx.font = p.font;
    return ctx.measureText(p.text).width;
  });
  const totalW = widths.reduce((a, b) => a + b, 0) + Math.max(0, parts.length - 1) * NAME_SUFFIX_GAP;
  let right = x + w / 2 + totalW / 2;

  ctx.textAlign = 'right';
  parts.forEach((p, i) => {
    ctx.font = p.font;
    ctx.globalAlpha = p.muted ? 0.9 : 1;
    ctx.fillText(p.text, right, cy);
    ctx.globalAlpha = 1;
    right -= widths[i]! + NAME_SUFFIX_GAP;
  });
}

/** An uncovered half of a handover -- shown, not hidden, as on screen. */
function drawGap(ctx: CanvasRenderingContext2D, x: number, y: number, w: number) {
  ctx.fillStyle = GAP_FILL;
  roundRect(ctx, x, y, w, CHIP_H, 7);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.font = NAME_FONT;
  ctx.fillStyle = GAP_INK;
  ctx.fillText('—', x + w / 2, y + CHIP_H / 2);
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('יצירת התמונה נכשלה.'))),
      'image/jpeg',
      0.92,
    );
  });
}

export function rosterFileName(weekStart: DateKey): string {
  return `roster-${weekStart}.jpg`;
}

/** Saves the blob to the user's downloads. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; one tick is
  // enough for the click to have been handled.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
