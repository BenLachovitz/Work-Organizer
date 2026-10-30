**Status:** shipped, v2.29.0 (spec §1.33, `docs/BACKLOG.md` Step AJ). Kept here as the planning
record for anyone revisiting this feature — the shipped shape may have drifted slightly from the
plan below in small ways during implementation; the spec and BACKLOG are the source of truth for
what actually exists today.

---

# Tap-to-call / tap-to-WhatsApp on the "currently on shift" card

## Context
The "who's on shift right now" homepage card (shipped v2.28.0) currently lists names only. Ben
wants to go one step further: let anyone tap a guard's entry to either call them or open a WhatsApp
chat with them directly, instead of having to look their number up elsewhere. Confirmed with Ben:
the whole team already has each other's phone numbers, so every guard being able to see every other
guard's number (needed for this to work at all) is fine.

Both link types turn out to be equally simple — a WhatsApp "click to chat" link (`https://wa.me/<number>`)
needs no WhatsApp Business API, account, or backend integration at all; it's a plain URL, exactly
like a `tel:` link. The only real cost for either is the same prerequisite: **a phone number has to
exist for each guard**, which the schema doesn't have today.

This isn't new ground for this project — a `phone_number` column existed once before (for a
self-service WhatsApp-OTP forgot-PIN feature), and was later fully reverted, but for an **unrelated**
reason (a production session-persistence bug, nothing to do with the phone number itself — see
`docs/BACKLOG.md`, Step AB "fully reverted"). That old design (migration, trigger, view, validation
helper, manager UI) is reusable almost as-is; this plan restores it with one deliberate change: a
phone number is **optional everywhere** now (confirmed with Ben), not required when adding a new
employee like it was before, since nothing critical depends on it this time.

## What's already confirmed by reading the code/history (not assumed)
- **`profiles` RLS SELECT is already `USING (TRUE)`** (`supabase/migrations/20260806000003_rls_policies.sql:56-58`,
  never modified since) — any authenticated guard already reads every column of every other guard's
  `profiles` row. `useVisibleRosters()`'s `profiles.select('*')` (`src/hooks/useGuardPortal.ts:277`)
  already proves this. **No RLS change needed** — adding the column is enough for it to flow through
  everywhere `Profile`/`guards` already does.
- **The old migration 48** (`supabase/migrations/20260822000048_employee_phone_number.sql`, still on
  disk, never deleted per this project's "migrations are discovered, never edited" discipline) is the
  exact reusable reference: `phone_number TEXT` nullable on both `roster_codes` (pre-claim) and
  `profiles` (post-claim), no CHECK constraint, deliberately **no uniqueness constraint** (Ben's past
  explicit instruction, still the right default — not re-raising it), a dedicated
  `copy_phone_number()`/`trg_profiles_phone_number` trigger (mirrors `copy_is_demo()`'s shape, one
  trigger per copied column), and `roster_code_status` view extended with
  `COALESCE(p.phone_number, c.phone_number) AS phone_number`.
- **The old revert** (migration 50) dropped all of the above for a reason specific to that feature
  (the WhatsApp Business API path was abandoned) — it is not evidence against re-adding the column.
- **The old validation helper**, `src/lib/phone.ts` (deleted, recovered from git history at commit
  `25544cf`), is a small pure module: `normalizeIsraeliPhone()` (Israeli-mobile-only `^05\d{8}$`,
  normalizes to E.164 `+972501234567`), `isValidIsraeliPhone()`, `formatPhoneForDisplay()` (E.164 →
  `050-1234567`). Reusable verbatim.
- **The old manager UI shape**, recovered from git history (`AddEmployeeCard`/`EmployeeRow` in
  `src/pages/TeamManagement.tsx`, commit `25544cf` before it was torn out in `b6e4b37`): a toggle/
  expand panel for an existing employee, the *exact* shape the current `EmployeeRow`'s PIN-reset panel
  already uses today (`src/pages/TeamManagement.tsx:296-308` toggle button, `:338-360` expand panel) —
  confirmed by reading the CURRENT file, not just the old diff, so the new phone panel slots in next
  to that one using the identical pattern.
- **`useTeam.ts`'s `useUpdateDefaultKamut()`** (`src/hooks/useTeam.ts:139-158`) is the exact mutation
  shape to mirror for a new `useUpdateEmployeePhone()`: writes to `profiles` if `profileId` is set
  (claimed), else `roster_codes` (pending) — same dual-table pattern.
- **`CurrentlyOnShiftCard.tsx`** (full current content read) has no icons/links today — `entry.name`
  is plain text. The app has **zero existing `<a href="tel:"` / `wa.me` / external-link precedent
  anywhere** — this is the first one. Icons elsewhere are hand-written inline SVGs
  (`viewBox="0 0 20 20" fill="currentColor"`, sized via Tailwind `size-4`/`size-5`, e.g. Modal's close
  button and DateField's calendar icon in `src/components/ui/index.tsx`) — no icon library is
  installed. New icons should match that convention.
- **`RosterCodeStatus`** (`src/hooks/useManager.ts:242-257`) is `TeamManagement.tsx`'s per-row type,
  fed by `useRosterCodeStatus()`'s `roster_code_status.select('*')` (`useManager.ts:266-268`) — once
  the view gains `phone_number`, adding the field to this interface is enough for it to flow through
  unchanged.

## Design decisions (confirmed with Ben)
- Phone number is **optional everywhere** — adding a new employee needs no phone number; an existing
  guard with none on file just shows a name with no call/WhatsApp icons on the shift card.
- No uniqueness constraint (same as before — not revisiting unless Ben asks).
- Scope is the "currently on shift" card only, not a broader change to the roster grid or anywhere
  else guard names appear — matches what was actually asked for.
- WhatsApp link opens a plain chat (`https://wa.me/<number>`), no pre-filled message text.

## Implementation

### 1. New migration — `supabase/migrations/20261031000066_employee_phone_number.sql`
Re-adds, essentially verbatim from migration 48 (header updated to explain the new purpose instead
of the old WhatsApp-OTP one, and to note this is a *second* add of a previously-reverted column, same
number sequence discipline as every other migration in this project):
- `ALTER TABLE roster_codes/profiles ADD COLUMN phone_number TEXT;` (nullable, no CHECK, no UNIQUE).
- `copy_phone_number()` / `trg_profiles_phone_number` (`BEFORE INSERT ON profiles`), identical to
  migration 48's.
- Rebuild `roster_code_status` (`CREATE OR REPLACE VIEW`, starting from migration 50's current shape
  — the latest one on disk — plus the `COALESCE(p.phone_number, c.phone_number) AS phone_number`
  column back), `GRANT SELECT ... TO authenticated`.
- No RLS policy changes — confirmed above that none are needed.

### 2. Types
- `src/types/database.ts`: add `phone_number: string | null;` to `Profile`.
- `src/hooks/useManager.ts`: add `phone_number: string | null;` to `RosterCodeStatus`.

### 3. Restore `src/lib/phone.ts`
Verbatim from git history (`normalizeIsraeliPhone`, `isValidIsraeliPhone`, `formatPhoneForDisplay`,
the `^05\d{8}$` regex). Add a small `src/lib/phone.test.mjs` (same throwaway-node-runnable pattern as
`shifts.test.mjs`/`payroll.test.mjs`) covering: a local `050-...`/`0501234567` input normalizes to the
same E.164 value, an invalid/landline number is rejected, and display formatting round-trips.

### 4. `src/hooks/useTeam.ts` — new `useUpdateEmployeePhone()`
Mirrors `useUpdateDefaultKamut()` exactly: `mutationFn` takes `{ employeeCode, profileId, value:
string | null }`, writes `phone_number` to `profiles` (claimed) or `roster_codes` (pending), same
`invalidateCodes` on success. The mutation takes an already-normalized E.164 string or `null`
(empty → clear) — normalization happens in the UI layer before calling `.mutate()`.

### 5. `src/pages/TeamManagement.tsx`
- `AddEmployeeCard` (currently lines 97-189): add an optional phone `<input type="tel">` (placeholder
  `050-1234567`), validated only if non-empty (`phone.trim() === '' || isValidIsraeliPhone(phone)`),
  included in `useAddEmployee()`'s insert when present. `useAddEmployee`/`AddEmployeeInput`
  (`useTeam.ts:47-76`) needs a new optional `phoneNumber?: string | null` field threaded into the
  `roster_codes` insert.
- `EmployeeRow` (currently lines 230-376): new `editingPhone`/`phoneDraft` state, a toggle `Button`
  next to the existing PIN-reset one (same `size="sm" variant="ghost"` styling, label flips
  `הוספת טלפון`/`עריכת טלפון` ↔ `ביטול`), an expand panel identical in shape to the PIN-reset one
  (`rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800`) with a phone `<input>` and a `שמירת טלפון` button
  disabled unless the draft is empty or valid, calling `useUpdateEmployeePhone()`. Row header shows
  `formatPhoneForDisplay(row.phone_number)` next to the employee code when present (e.g.
  `050-1234567`), nothing extra when absent.

### 6. `src/components/guard/CurrentlyOnShiftCard.tsx`
- Extend `OnShiftEntry` with `phoneNumber: string | null`.
- In the `useMemo`, change the `names` lookup (`new Map(guards.map(g => [g.id, g.display_name]))`)
  to also carry `phone_number` (either a second map, or switch to `new Map(guards.map(g => [g.id, g]))`
  and read `.display_name`/`.phone_number` off the found `Profile`).
- Per row, when `entry.phoneNumber` is set, render two small icon tap-targets next to the name: a
  phone icon → `<a href={`tel:${entry.phoneNumber}`}>` and a WhatsApp icon →
  `<a href={`https://wa.me/${entry.phoneNumber.replace('+', '')}`} target="_blank" rel="noopener noreferrer">`
  (E.164 has a `+`; wa.me wants the digits only). New inline SVGs matching the existing
  `viewBox="0 0 20 20" fill="currentColor"` convention, each wrapped with `aria-label` ("התקשרות
  אל {name}" / "וואטסאפ עם {name}") since they're icon-only tap targets, sized `size-7` or similar for
  a comfortable mobile tap target (bigger than the existing `size-4`/`size-5` decorative icons, since
  these are the first *functional* icon buttons in the app). When `phoneNumber` is `null`, render the
  row exactly as it is today — no empty icon placeholders.

## Explicitly out of scope
- Showing these icons anywhere else (the full roster grid, "my shifts" week cards, etc.) — not asked
  for.
- A pre-filled WhatsApp message.
- Re-adding a uniqueness constraint on `phone_number`.
- Landline numbers (the old `^05\d{8}$` regex stays mobile-only, matching this team's actual usage).

## Verification
1. `npm run typecheck`.
2. `npm run test:phone` (new fixtures) — normalize/validate/format round-trip.
3. Apply the new migration (`npm run db:apply`) and confirm `roster_code_status` returns
   `phone_number` for a manager query; confirm a guard's own `profiles.select('*')` already includes
   it (no RLS change needed, per the research above, but worth a live spot-check).
4. Manual browser check (`npm run dev`, Ben's own login, consistent with this project's "no demo
   account" convention): in Team Management, add a phone number to an existing guard, confirm it
   displays and persists; confirm the "currently on shift" card shows tap-to-call/WhatsApp icons for
   a guard with a number on file and plain text for one without; tap each icon on a real phone to
   confirm the dialer and WhatsApp both open correctly with the right number.
5. Follow this project's documentation discipline: bump `package.json`/`GitVersion.yml`, add a spec
   changelog entry and a `docs/BACKLOG.md` "Step" entry, tag the release commit.
