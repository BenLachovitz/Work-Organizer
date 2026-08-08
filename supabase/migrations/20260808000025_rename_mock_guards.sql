-- ============================================================================
-- Migration 25 : Rename the 7 mock guard accounts to "{שם} - דמה"
--
-- Ben is starting to collect the team's real badge codes and wants to
-- register them for real without a badge-code collision against the mock
-- accounts already sitting on 100001-100007. This is a RENAME only -- the
-- mocked preference data on the current test week stays live and usable
-- while he keeps testing. He deletes the mock accounts himself, via the real
-- delete_employee() feature (migration 21), once real registration is
-- complete. This migration does not delete anything.
--
-- Both profiles.display_name (what's shown everywhere in the app today) and
-- roster_codes.display_name (inert for these 7 since they're already
-- claimed, but kept in sync so a stale bare name can't resurface if a code
-- is ever reset) are updated. Ben (005396, בן) is untouched.
--
-- Matched by exact CURRENT name/code, so a second db:apply is a no-op: after
-- the first run 'יובל' no longer matches anything, same idempotence every
-- other migration here already has.
-- ============================================================================

UPDATE profiles SET display_name = 'יובל - דמה' WHERE display_name = 'יובל';
UPDATE profiles SET display_name = 'לוק - דמה' WHERE display_name = 'לוק';
UPDATE profiles SET display_name = 'הודיה - דמה' WHERE display_name = 'הודיה';
UPDATE profiles SET display_name = 'שלי - דמה' WHERE display_name = 'שלי';
UPDATE profiles SET display_name = 'ים - דמה' WHERE display_name = 'ים';
UPDATE profiles SET display_name = 'עידן - דמה' WHERE display_name = 'עידן';
UPDATE profiles SET display_name = 'ניתאי - דמה' WHERE display_name = 'ניתאי';

UPDATE roster_codes SET display_name = 'יובל - דמה' WHERE employee_code = '100001';
UPDATE roster_codes SET display_name = 'לוק - דמה' WHERE employee_code = '100002';
UPDATE roster_codes SET display_name = 'הודיה - דמה' WHERE employee_code = '100003';
UPDATE roster_codes SET display_name = 'שלי - דמה' WHERE employee_code = '100004';
UPDATE roster_codes SET display_name = 'ים - דמה' WHERE employee_code = '100005';
UPDATE roster_codes SET display_name = 'עידן - דמה' WHERE employee_code = '100006';
UPDATE roster_codes SET display_name = 'ניתאי - דמה' WHERE employee_code = '100007';
