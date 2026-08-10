import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { cn } from '@/components/ui';

/**
 * Segmented numeric entry for the 6-digit badge code and the PIN.
 *
 * Forced to dir="ltr" regardless of the RTL page: a badge code like 005396 is a
 * number, and in an RTL flow the boxes would fill right-to-left and read back
 * reversed. Digits are LTR even inside Hebrew.
 */
export function CodeInput({
  value,
  onChange,
  length = 6,
  autoFocus = false,
  masked = false,
  disabled = false,
  invalid = false,
  onComplete,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  autoFocus?: boolean;
  masked?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  onComplete?: (v: string) => void;
  ariaLabel?: string;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (value.length === length && firedFor.current !== value) {
      firedFor.current = value;
      onComplete?.(value);
    }
    if (value.length !== length) firedFor.current = null;
  }, [value, length, onComplete]);

  const setDigit = (index: number, digit: string) => {
    const next = value.padEnd(length, ' ').split('');
    next[index] = digit;
    onChange(next.join('').replace(/ /g, '').slice(0, length));
    if (digit && index < length - 1) refs.current[index + 1]?.focus();
  };

  const handleKeyDown = (index: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (value[index]) {
        onChange(value.slice(0, index) + value.slice(index + 1));
      } else if (index > 0) {
        onChange(value.slice(0, index - 1) + value.slice(index));
        refs.current[index - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      refs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < length - 1) {
      refs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (digits) {
      onChange(digits);
      refs.current[Math.min(digits.length, length - 1)]?.focus();
    }
  };

  return (
    // gap-1.5 + size-10 at the base size, not gap-2 + size-12: six FIXED-width
    // boxes never shrink below their set size (flex's automatic min-width
    // floor), so the old sizing needed 328px just for the row -- past the
    // CSS viewport width some real phones report (360-393px) once the card's
    // own padding and the page's outer padding are added on top. That forced
    // the whole page to scroll horizontally, which is what exposed a strip
    // of the plain body background down one side. sm:size-14 for anything
    // wide enough to afford it is unchanged.
    <div dir="ltr" className="flex justify-center gap-1.5 sm:gap-2" role="group" aria-label={ariaLabel}>
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type={masked ? 'password' : 'text'}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          disabled={disabled}
          value={value[i] ?? ''}
          onChange={(e) => setDigit(i, e.target.value.replace(/\D/g, '').slice(-1))}
          onKeyDown={handleKeyDown(i)}
          onPaste={handlePaste}
          onFocus={(e) => e.target.select()}
          className={cn(
            'size-10 rounded-xl border-2 bg-white text-center text-lg font-bold dark:bg-slate-800',
            'transition-all duration-150 focus:outline-none sm:size-14 sm:text-2xl',
            invalid
              ? 'border-rose-400 text-rose-700 dark:text-rose-400'
              : value[i]
                ? 'border-brand-500 text-slate-900 dark:text-slate-100'
                : 'border-slate-300 text-slate-900 dark:border-slate-600 dark:text-slate-100',
            'focus:border-brand-600 focus:ring-4 focus:ring-brand-500/15',
            disabled && 'cursor-not-allowed bg-slate-100 opacity-60 dark:bg-slate-700',
          )}
        />
      ))}
    </div>
  );
}
