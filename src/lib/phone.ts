/**
 * Israeli phone number normalization for the WhatsApp OTP forgot-PIN flow.
 *
 * Client-side only -- the whatsapp-pin-reset Edge Function trusts whatever's
 * already stored on profiles/roster_codes.phone_number and never re-normalizes
 * or accepts a phone number in any request body itself. Landlines are
 * excluded (05\d{8}) since they cannot receive WhatsApp messages at all.
 */

const ISRAELI_MOBILE_RE = /^05\d{8}$/;

/** '050-1234567' / '0501234567' / '+972501234567' -> '+972501234567', or null if invalid. */
export function normalizeIsraeliPhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  // Already E.164-shaped input ("+972...") strips to "972...".
  const local = digits.startsWith('972') ? `0${digits.slice(3)}` : digits;
  if (!ISRAELI_MOBILE_RE.test(local)) return null;
  return `+972${local.slice(1)}`;
}

export function isValidIsraeliPhone(input: string): boolean {
  return normalizeIsraeliPhone(input) !== null;
}

/** For display on an input already holding a normalized E.164 value. */
export function formatPhoneForDisplay(e164: string | null): string {
  if (!e164) return '';
  const local = e164.replace('+972', '0');
  return local.length === 10 ? `${local.slice(0, 3)}-${local.slice(3)}` : local;
}
