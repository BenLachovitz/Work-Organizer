import { SHIFTS, SHIFT_TYPES, type ShiftType } from '@/lib/shifts';
import { cn } from '@/components/ui';

export function ShiftChip({
  shift,
  size = 'md',
  showTime = true,
  className,
}: {
  shift: ShiftType;
  size?: 'sm' | 'md';
  showTime?: boolean;
  className?: string;
}) {
  const def = SHIFTS[shift];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-lg font-semibold text-white',
        size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        className,
      )}
      style={{ backgroundColor: def.colorVar }}
    >
      {def.he}
      {showTime && <span className="num text-[11px] opacity-90">{def.label}</span>}
    </span>
  );
}

/** The colour key. Shown once on the roster so the mapping is learned in one place. */
export function ShiftLegend() {
  return (
    <div className="flex flex-wrap gap-2">
      {SHIFT_TYPES.map((s) => (
        <ShiftChip key={s} shift={s} size="sm" />
      ))}
    </div>
  );
}
