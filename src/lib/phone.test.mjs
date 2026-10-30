/**
 * Hand-computed fixtures for Israeli phone validation/normalization
 * (src/lib/phone.ts). No Supabase dependency -- pure function in, string/
 * boolean out.
 *
 *   node --experimental-strip-types src/lib/phone.test.mjs
 *
 * Same "resolve extension-less relative TS imports" loader as
 * payroll.test.mjs/shifts.test.mjs -- phone.ts has no relative imports of
 * its own, but the loader is kept for consistency and in case that changes.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');

register(
  `data:text/javascript,
   const SRC = ${JSON.stringify(SRC)};
   export function resolve(spec, ctx, next) {
     if (spec.startsWith('@/')) {
       return next('file:///' + SRC + '/' + spec.slice(2) + '.ts', ctx);
     }
     if ((spec.startsWith('./') || spec.startsWith('../')) && !/\\.[a-zA-Z]+$/.test(spec)) {
       return next(spec + '.ts', ctx);
     }
     return next(spec, ctx);
   }`,
  import.meta.url,
);

const { normalizeIsraeliPhone, isValidIsraeliPhone, formatPhoneForDisplay } =
  await import('./phone.ts');

let failures = 0;

function checkValue(name, actual, expected) {
  if (actual === expected) {
    console.log(`  \x1b[32mok\x1b[0m   ${name}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} -- expected ${expected}, got ${actual}`);
  }
}

const E164 = '+972501234567';

// 1-3. Three equivalent raw inputs all normalize to the same E.164 value.
checkValue(
  'local dashed form normalizes to E.164',
  normalizeIsraeliPhone('050-1234567'),
  E164,
);
checkValue(
  'local undashed form normalizes to E.164',
  normalizeIsraeliPhone('0501234567'),
  E164,
);
checkValue(
  'an already-E.164 input normalizes to itself',
  normalizeIsraeliPhone('+972501234567'),
  E164,
);

// 4. A landline (02/03/04/08/09 prefix) is rejected -- mobile-only by design,
//    since a landline can't receive a WhatsApp chat.
checkValue(
  'a landline number is rejected',
  normalizeIsraeliPhone('03-1234567'),
  null,
);

// 5. Too few digits is rejected, not silently truncated/padded.
checkValue(
  'a too-short number is rejected',
  normalizeIsraeliPhone('050-123'),
  null,
);

// 6. Garbage input is rejected cleanly, not a thrown error.
checkValue(
  'non-numeric input is rejected',
  normalizeIsraeliPhone('not a phone number'),
  null,
);

// 7. isValidIsraeliPhone mirrors normalizeIsraeliPhone's accept/reject split.
checkValue('isValidIsraeliPhone accepts a valid number', isValidIsraeliPhone('0501234567'), true);
checkValue('isValidIsraeliPhone rejects a landline', isValidIsraeliPhone('031234567'), false);

// 8. formatPhoneForDisplay round-trips E.164 back to the familiar local
//    dashed form.
checkValue(
  'formatPhoneForDisplay shows E.164 as a local dashed number',
  formatPhoneForDisplay(E164),
  '050-1234567',
);

// 9. formatPhoneForDisplay is '' for null, not 'null' or a thrown error --
//    the common case for a guard with no number on file yet.
checkValue('formatPhoneForDisplay is empty for null', formatPhoneForDisplay(null), '');

if (failures > 0) {
  console.error(`\n${failures} fixture(s) failed.\n`);
  process.exit(1);
}
console.log('\nAll phone fixtures passed.\n');
