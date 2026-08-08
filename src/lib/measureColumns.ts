import type { ShiftType } from '@/lib/shifts';

/**
 * Works out how wide every roster column has to be so that no cell truncates.
 *
 * The columns must all be the SAME width -- a grid whose columns each size to
 * their own content reads as ragged. But picking that width by eye does not
 * work either: a hardcoded guess was wide enough for "יובל עד 18:45" and too
 * narrow for the handover cell "יובל / שלי", so the names were clipped. The
 * width has to come from the widest thing actually on screen.
 *
 * So the text is measured rather than estimated, with a canvas using the same
 * fonts the chips render in, and the padding the chips actually apply.
 */

// Mirrors the chip styles in RosterGrid. If those change, change these.
const NAME_FONT = "600 11px Heebo, system-ui, -apple-system, 'Segoe UI', Arial, sans-serif";
const SUFFIX_FONT = "400 9px Heebo, system-ui, -apple-system, 'Segoe UI', Arial, sans-serif";
const CHIP_PADDING_X = 12; // px-1.5 on both sides
const NAME_SUFFIX_GAP = 4; // gap-1
const HANDOVER_SLASH = 8; // the "/" glyph
const HANDOVER_GAPS = 8; // gap-1 either side of the slash
const CELL_PADDING_X = 12; // p-1.5 on both sides
const MIN_COLUMN = 64;
const MAX_COLUMN = 200; // beyond this the grid is unusable anyway; truncate instead

let ctx: CanvasRenderingContext2D | null | undefined;

function measure(text: string, font: string): number {
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return text.length * 6; // canvas unavailable: rough fallback
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * Canvas metrics and DOM layout agree to within a pixel or so, but not exactly
 * -- subpixel rounding, letter-spacing, and the ring on a highlighted chip all
 * nudge it. TOLERANCE buys back that difference: being two pixels too wide is
 * invisible, being two pixels too narrow puts an ellipsis in someone's name.
 */
const TOLERANCE = 3;

const chipWidth = (name: string, suffix?: string) =>
  measure(name, NAME_FONT) +
  (suffix ? NAME_SUFFIX_GAP + measure(suffix, SUFFIX_FONT) : 0) +
  CHIP_PADDING_X +
  TOLERANCE;

export interface MeasurableAssignment {
  target_date: string;
  shift: ShiftType;
  guard_id: string;
}

/**
 * The width, in pixels, of the widest cell in the grid.
 *
 * Every cell is considered: a morning or night chip carries its 12h suffix, and
 * an afternoon handover holds two chips plus the slash between them -- which is
 * almost always the widest thing in the table and the case a guessed width got
 * wrong.
 */
export function widestRosterColumn(
  dates: string[],
  assignments: MeasurableAssignment[],
  nameOf: (guardId: string) => string,
  /**
   * The editor stacks every assignment as its own full-width chip, so it has no
   * two-names-in-a-row cell. Measuring it as if it did would leave the columns
   * roughly twice as wide as anything in them.
   */
  opts: { handover?: boolean } = { handover: true },
): number {
  let widest = MIN_COLUMN;

  for (const date of dates) {
    const day = assignments.filter((a) => a.target_date === date);

    for (const a of day) {
      const suffix =
        a.shift === 'day12' ? 'עד 18:45' : a.shift === 'night12' ? 'מ 18:45' : undefined;
      widest = Math.max(widest, chipWidth(nameOf(a.guard_id), suffix));
    }

    if (!opts.handover) continue;

    // The handover: two names side by side, paired the way the grid pairs them
    // -- day12 on the left of the slash, night12 on the right.
    //
    // Both halves are `flex-1`, so they split the cell EQUALLY however long the
    // two names are. The cell therefore has to fit twice the longer name, not
    // the sum of the two: sizing for the sum let a short name donate space its
    // neighbour was never going to receive, and the long one still clipped.
    const early = day.filter((a) => a.shift === 'day12');
    const late = day.filter((a) => a.shift === 'night12');
    for (let i = 0; i < Math.max(early.length, late.length); i++) {
      const a = early[i] ? chipWidth(nameOf(early[i]!.guard_id)) : chipWidth('—');
      const b = late[i] ? chipWidth(nameOf(late[i]!.guard_id)) : chipWidth('—');
      widest = Math.max(widest, 2 * Math.max(a, b) + HANDOVER_SLASH + HANDOVER_GAPS);
    }
  }

  return Math.min(MAX_COLUMN, Math.ceil(widest + CELL_PADDING_X));
}
