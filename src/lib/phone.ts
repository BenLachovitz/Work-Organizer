/**
 * Israeli mobile phone number validation/normalization -- pure, no Supabase
 * dependency. Mobile-only by design (landlines can't receive a WhatsApp
 * chat, and the "currently on shift" card's tap-to-WhatsApp link is the
 * whole reason this exists). Canonical storage form is E.164
 * ("+972501234567"); the display form is the familiar local dash form
 * ("050-1234567").
 */

const ISRAELI_MOBILE_RE = /^05\d{8}$/;

/** Accepts "050-1234567", "0501234567", or an already-E.164 "+972501234567".
 *  Returns the canonical E.164 form, or null if it's not a valid Israeli
 *  mobile number. */
export function normalizeIsraeliPhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  const local = digits.startsWith('972') ? `0${digits.slice(3)}` : digits;
  if (!ISRAELI_MOBILE_RE.test(local)) return null;
  return `+972${local.slice(1)}`;
}

export function isValidIsraeliPhone(input: string): boolean {
  return normalizeIsraeliPhone(input) !== null;
}

/** E.164 -> "050-1234567", for showing an already-stored number back to a
 *  manager in an editable field. */
export function formatPhoneForDisplay(e164: string | null): string {
  if (!e164) return '';
  const local = e164.replace('+972', '0');
  return local.length === 10 ? `${local.slice(0, 3)}-${local.slice(3)}` : local;
}
