import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
const env = {};
for (const line of (await readFile('.env.local','utf8')).split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2];
}
const REF = env.VITE_SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./)[1];
const sql = async (q) => { const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query:q})}); const b=await r.json().catch(()=>null); if(!r.ok) throw new Error(b?.message??r.status); return b; };
let pass=0; const fails=[];
const ok=(l)=>{pass++;console.log(`  \x1b[32mPASS\x1b[0m  ${l}`)};
const bad=(l,d)=>{fails.push(l);console.log(`  \x1b[31mFAIL\x1b[0m  ${l}\n        ${d}`)};

const MGR='990601', G1='990602', G2='990603', PIN='T-' + randomBytes(12).toString('hex'), WEEK='2026-09-20';
const clean=()=>sql(`DELETE FROM roster_weeks WHERE week_start='${WEEK}';
                     DELETE FROM auth.users WHERE email LIKE '9906%@guards.local';
                     DELETE FROM roster_codes WHERE employee_code LIKE '9906%';`);
await clean();
await sql(`
  INSERT INTO roster_weeks (week_start,morning_target_slots,submission_deadline,status)
  VALUES ('${WEEK}',2,NOW()+INTERVAL '30 days','open');
  INSERT INTO roster_codes (employee_code,display_name,initial_role) VALUES
    ('${MGR}','מנהל','manager'),('${G1}','שומר-א','guard'),('${G2}','שומר-ב','guard');
  INSERT INTO auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
    raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,
    email_change_token_new,email_change)
  SELECT '00000000-0000-0000-0000-000000000000',gen_random_uuid(),'authenticated','authenticated',
    c.code||'@guards.local',extensions.crypt('${PIN}',extensions.gen_salt('bf')),NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,NOW(),NOW(),'','','',''
  FROM (VALUES ('${MGR}'),('${G1}'),('${G2}')) AS c(code);
  INSERT INTO profiles (id,employee_code,display_name,role,is_active)
  SELECT u.id,split_part(u.email,'@',1),'בדיקה',
    CASE WHEN split_part(u.email,'@',1)='${MGR}' THEN 'manager'::user_role ELSE 'guard'::user_role END,TRUE
  FROM auth.users u WHERE u.email LIKE '9906%@guards.local';
  INSERT INTO schedule_runs (id,week_start,version,solver_status)
  VALUES ('dddddddd-0000-0000-0000-000000000001','${WEEK}',1,'OPTIMAL');`);

const ids = await sql(`SELECT employee_code, id FROM profiles WHERE employee_code LIKE '9906%'`);
const idOf=(c)=>ids.find(r=>r.employee_code===c).id;
const RUN='dddddddd-0000-0000-0000-000000000001';
await sql(`INSERT INTO schedule_assignments (run_id,target_date,shift,guard_id) VALUES
  ('${RUN}','${WEEK}'::date,'morning','${idOf(G1)}'),
  ('${RUN}','${WEEK}'::date+1,'night','${idOf(G2)}');`);

const signIn=async(c)=>{const db=createClient(env.VITE_SUPABASE_URL,env.VITE_SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});const {error}=await db.auth.signInWithPassword({email:`${c}@guards.local`,password:PIN});if(error)throw new Error(error.message);return db;};
const mgr=await signIn(MGR), g1=await signIn(G1);

console.log('\n\x1b[1mEdit a draft roster\x1b[0m');
{
  // Swap the two guards -- the exact operation Ben described.
  const { error } = await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'morning',guard_id:idOf(G2)},
    {date:new Date(Date.parse(WEEK)+86400000).toISOString().slice(0,10),shift:'night',guard_id:idOf(G1)},
  ]});
  error?bad('swap two guards',error.message):ok('manager swaps two guards');
}
{
  const rows=await sql(`SELECT p.employee_code c, a.shift::text s FROM schedule_assignments a JOIN profiles p ON p.id=a.guard_id WHERE a.run_id='${RUN}' ORDER BY a.target_date`);
  JSON.stringify(rows)===JSON.stringify([{c:G2,s:'morning'},{c:G1,s:'night'}])
    ? ok('the swap actually persisted') : bad('swap persisted',JSON.stringify(rows));
}
{
  // Change a shift type: 8h morning -> 12h day.
  await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'day12',guard_id:idOf(G2)},
  ]});
  const rows=await sql(`SELECT shift::text s, COUNT(*)::int n FROM schedule_assignments WHERE run_id='${RUN}' GROUP BY shift`);
  rows.length===1&&rows[0].s==='day12'&&rows[0].n===1
    ? ok('shift type changed to day12, and the removed row is gone')
    : bad('shift change',JSON.stringify(rows));
}
{
  const rows=await sql(`SELECT solver_status FROM schedule_runs WHERE id='${RUN}'`);
  /\+EDITED$/.test(rows[0].solver_status)
    ? ok(`run marked hand-edited (${rows[0].solver_status})`)
    : bad('edit marker',JSON.stringify(rows));
}
{
  // Free text before/after the guard's name (§2.2c) -- trimmed and NULLed when
  // blank, same convention weekly_submissions.notes already uses.
  await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'day12',guard_id:idOf(G2),note_before:'  (מ-10:45)  ',note_after:'  '},
  ]});
  const rows=await sql(`SELECT note_before nb, note_after na FROM schedule_assignments WHERE run_id='${RUN}'`);
  rows.length===1 && rows[0].nb==='(מ-10:45)' && rows[0].na===null
    ? ok('note_before is trimmed and saved, blank note_after becomes NULL')
    : bad('note round-trip',JSON.stringify(rows));
}
{
  // A note over the 40-character cap is rejected by the CHECK constraint.
  const { error } = await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'day12',guard_id:idOf(G2),note_after:'x'.repeat(41)},
  ]});
  error ? ok('a note over 40 characters is rejected') : bad('note length cap','succeeded');
}
{
  // save_run_assignments does DELETE then INSERT inside one function call, so
  // a rejected INSERT must roll back the DELETE too -- the prior note should
  // still be there, not gone.
  const rows=await sql(`SELECT note_before nb FROM schedule_assignments WHERE run_id='${RUN}'`);
  rows.length===1 && rows[0].nb==='(מ-10:45)'
    ? ok('the rejected edit rolled back cleanly -- the prior note is still there')
    : bad('rollback after rejected note',JSON.stringify(rows));
}

console.log('');
console.log('Placeholder (guard-less) assignment rows (§12.9, migration 39)');
{
  // "Yam is alone in the morning until 10:45, then Shely joins" -- a real
  // guard (G1) plus a placeholder chip (no guard_id) annotating the same
  // morning cell, without a second real assignment for anyone.
  await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'morning',guard_id:idOf(G1)},
    {date:WEEK,shift:'morning',guard_id:null,note_before:'- /'},
  ]});
  const rows=await sql(`SELECT guard_id gid, note_before nb FROM schedule_assignments WHERE run_id='${RUN}' AND target_date='${WEEK}'::date ORDER BY guard_id NULLS LAST`);
  rows.length===2 && rows[0].gid===idOf(G1) && rows[1].gid===null && rows[1].nb==='- /'
    ? ok('a real guard and a placeholder coexist in the same cell')
    : bad('real + placeholder in one cell',JSON.stringify(rows));
}
{
  // A second placeholder, same day, different shift -- proves NULL guard_id
  // never collides with itself under one_shift_per_guard_per_day (standard
  // SQL: NULLs are always distinct from each other in a UNIQUE index).
  await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'morning',guard_id:idOf(G1)},
    {date:WEEK,shift:'morning',guard_id:null,note_before:'- /'},
    {date:WEEK,shift:'night',guard_id:null,note_after:'(עד 02:00)'},
  ]});
  const rows=await sql(`SELECT COUNT(*)::int n FROM schedule_assignments WHERE run_id='${RUN}' AND target_date='${WEEK}'::date AND guard_id IS NULL`);
  rows[0].n===2
    ? ok('two placeholders on the same day, different shifts, saved without collision')
    : bad('two placeholders same day',JSON.stringify(rows));
}
{
  // The exact scenario this feature exists for: G1's own REAL shift that day
  // is 'afternoon'; an unrelated 'morning' placeholder (no guard_id at all)
  // saves right alongside it -- nothing ties the placeholder to G1's
  // identity, so there is nothing for the referee or the DB to see as a
  // double-booking.
  const { error } = await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'afternoon',guard_id:idOf(G1)},
    {date:WEEK,shift:'morning',guard_id:null,note_before:'- / (עד 10:45 לבד)'},
  ]});
  error ? bad('real guard + unrelated placeholder',error.message) : ok("a real guard's own shift and an unrelated placeholder on the same day both save fine");
}
{
  // Contrast: giving G1 a SECOND REAL shift the same day (not a placeholder)
  // is still correctly refused -- placeholders don't weaken this guarantee,
  // which is exactly the constraint that made the manual workaround (adding
  // Shely a second time, for real) fail in the first place.
  const { error } = await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'afternoon',guard_id:idOf(G1)},
    {date:WEEK,shift:'morning',guard_id:idOf(G1)},
  ]});
  error ? ok('a genuine second REAL shift for the same guard is still rejected') : bad('double real booking','succeeded');
}
{
  // A placeholder with no text at all is meaningless -- the DB rejects it as
  // a backstop (RosterEditor.tsx already drops these before saving).
  const { error } = await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'night',guard_id:null},
  ]});
  error ? ok('a placeholder with no note at all is rejected') : bad('blank placeholder','succeeded');
}

console.log('');
console.log('Placeholder occupies_slot (§12.9, migration 52)');
{
  // A placeholder marked as occupying a slot still needs a note (Ben's call:
  // occupies_slot does not relax placeholder_needs_a_note) -- with one, it
  // saves and persists occupies_slot = true.
  await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'night',guard_id:null,note_before:'מכוסה - לא רשום',occupies_slot:true},
  ]});
  const rows=await sql(`SELECT guard_id gid, occupies_slot os FROM schedule_assignments WHERE run_id='${RUN}' AND target_date='${WEEK}'::date AND shift='night'`);
  rows.length===1 && rows[0].gid===null && rows[0].os===true
    ? ok('a placeholder with a note and occupies_slot:true saves and persists the flag')
    : bad('occupies_slot true placeholder',JSON.stringify(rows));
}
{
  // A REAL assignment can never set occupies_slot -- it's meaningless there
  // (a real assignment already occupies its own slot), enforced by the new
  // occupies_slot_only_on_placeholder CHECK.
  const { error } = await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'morning',guard_id:idOf(G1),occupies_slot:true},
  ]});
  error ? ok('occupies_slot:true on a real assignment is rejected') : bad('occupies_slot on real row','succeeded');
}
{
  // Omitting occupies_slot entirely (old-shaped client payload) defaults to
  // false -- backward compatible with a client that predates this column.
  await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'night',guard_id:null,note_before:'הערה בלבד'},
  ]});
  const rows=await sql(`SELECT occupies_slot os FROM schedule_assignments WHERE run_id='${RUN}' AND target_date='${WEEK}'::date AND shift='night'`);
  rows.length===1 && rows[0].os===false
    ? ok('occupies_slot defaults to false when omitted from the payload')
    : bad('occupies_slot default',JSON.stringify(rows));
}

console.log('');
console.log('Afternoon segment shifts: afternoon_early / afternoon_late (migration 53)');
{
  // The exact scenario this feature exists for: a real guard occupying just
  // S2 (afternoon_early), and a coverage-occupying placeholder for just S3
  // (afternoon_late), on the same cell -- neither tied to the full 8h
  // afternoon shift or a 12h day12/night12.
  await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'afternoon_early',guard_id:idOf(G1)},
    {date:WEEK,shift:'afternoon_late',guard_id:null,note_before:'מכוסה עד הסגירה',occupies_slot:true},
  ]});
  const rows=await sql(`SELECT shift::text s, guard_id gid, occupies_slot os FROM schedule_assignments WHERE run_id='${RUN}' AND target_date='${WEEK}'::date AND shift IN ('afternoon_early','afternoon_late') ORDER BY shift`);
  rows.length===2 && rows[0].s==='afternoon_early' && rows[0].gid===idOf(G1) &&
  rows[1].s==='afternoon_late' && rows[1].gid===null && rows[1].os===true
    ? ok('a real guard on afternoon_early and an occupies_slot placeholder on afternoon_late coexist in one cell')
    : bad('afternoon_early + afternoon_late in one cell',JSON.stringify(rows));
}
{
  // The same guard can't hold BOTH halves of the same day -- the
  // one_shift_per_guard_per_day unique index is keyed by (run_id,
  // target_date, guard_id), so it collides regardless of which two distinct
  // shift values are involved, same guard-rail as any other double-booking.
  const { error } = await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'afternoon_early',guard_id:idOf(G1)},
    {date:WEEK,shift:'afternoon_late',guard_id:idOf(G1)},
  ]});
  error ? ok('the same guard cannot hold both afternoon halves the same day') : bad('same-guard double half','succeeded');
}

{
  const { error } = await g1.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[]});
  error?ok('a guard cannot edit a roster'):bad('guard edit','succeeded');
}

console.log('');
console.log('publish_roster (migration 43) -- atomic publish, single-run-per-week enforcement');
const RUN2 = 'dddddddd-0000-0000-0000-000000000002';
{
  await sql(`INSERT INTO schedule_runs (id,week_start,version,solver_status)
             VALUES ('${RUN2}','${WEEK}',2,'OPTIMAL');`);
}
{
  const { error } = await g1.rpc('publish_roster',{p_run_id:RUN});
  error ? ok('a guard cannot publish a roster') : bad('guard publish','succeeded');
}
{
  const { error } = await mgr.rpc('publish_roster',{p_run_id:RUN});
  error ? bad('manager publishes RUN',error.message) : ok('manager publishes a draft via publish_roster');
}
{
  const r=await sql(`SELECT is_published p, (published_at IS NOT NULL) has_ts FROM schedule_runs WHERE id='${RUN}'`);
  const w=await sql(`SELECT status::text s FROM roster_weeks WHERE week_start='${WEEK}'`);
  r[0].p===true && r[0].has_ts===true && w[0].s==='published'
    ? ok('is_published, published_at, and the week status all flip together, in one call')
    : bad('publish_roster effects',JSON.stringify({r,w}));
}
{
  // Publishing a second run for the same week must unpublish the first --
  // the partial unique index one_published_run_per_week only allows this
  // atomically, which is the whole reason to wrap it in an RPC.
  const { error } = await mgr.rpc('publish_roster',{p_run_id:RUN2});
  const r=await sql(`SELECT id, is_published p FROM schedule_runs WHERE week_start='${WEEK}' ORDER BY version`);
  const runRow=r.find(x=>x.id===RUN), run2Row=r.find(x=>x.id===RUN2);
  !error && runRow?.p===false && run2Row?.p===true
    ? ok('publishing a second run atomically unpublishes the first')
    : bad('single published run per week',JSON.stringify({error:error?.message,r}));
}
{
  const { error } = await mgr.rpc('publish_roster',{p_run_id:'00000000-0000-0000-0000-000000000000'});
  error ? ok('publishing an unknown run id is rejected') : bad('unknown run','succeeded');
}
{
  // RUN2 was only needed to prove the single-published-run switch above; the
  // rest of this file's assertions assume exactly one run (RUN) exists.
  await sql(`DELETE FROM schedule_runs WHERE id='${RUN2}';`);
}

console.log('');
console.log('A published roster stays under the manager control');
{
  await sql(`UPDATE schedule_runs SET is_published=TRUE WHERE id='${RUN}';
             UPDATE roster_weeks SET status='published' WHERE week_start='${WEEK}';`);
  // Somebody calls in sick mid-week: drop them from the live roster.
  const { error } = await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[]});
  error ? bad('edit published',error.message) : ok('manager edits a LIVE published roster');
}
{
  const rows=await sql(`SELECT COUNT(*)::int n FROM schedule_assignments WHERE run_id='${RUN}'`);
  rows[0].n===0 ? ok('the sick guard was removed from the live roster') : bad('live edit',JSON.stringify(rows));
}
{
  // Swap somebody in on a live roster.
  await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[
    {date:WEEK,shift:'morning',guard_id:idOf(G1)},
  ]});
  const rows=await sql(`SELECT p.employee_code c FROM schedule_assignments a JOIN profiles p ON p.id=a.guard_id WHERE a.run_id='${RUN}'`);
  rows.length===1&&rows[0].c===G1 ? ok('a replacement guard can be swapped in live') : bad('live swap',JSON.stringify(rows));
}
{
  const { error } = await g1.rpc('unpublish_run',{p_run_id:RUN});
  error ? ok('a guard cannot unpublish') : bad('guard unpublish','succeeded');
}
{
  await mgr.rpc('unpublish_run',{p_run_id:RUN});
  const r=await sql(`SELECT r.is_published p, w.status::text s FROM schedule_runs r JOIN roster_weeks w ON w.week_start=r.week_start WHERE r.id='${RUN}'`);
  r[0].p===false && r[0].s==='generated'
    ? ok('unpublish clears the flag AND reverts the week status')
    : bad('unpublish',JSON.stringify(r));
}
{
  const { error } = await g1.rpc('delete_schedule_run',{p_run_id:RUN});
  error ? ok('a guard cannot delete a roster') : bad('guard delete','succeeded');
}
{
  // Re-publish, then delete the live roster outright.
  await sql(`UPDATE schedule_runs SET is_published=TRUE WHERE id='${RUN}';
             UPDATE roster_weeks SET status='published' WHERE week_start='${WEEK}';`);
  const { error } = await mgr.rpc('delete_schedule_run',{p_run_id:RUN});
  error ? bad('delete published',error.message) : ok('manager deletes a PUBLISHED roster');
}
{
  const runs=await sql(`SELECT COUNT(*)::int n FROM schedule_runs WHERE id='${RUN}'`);
  const asg=await sql(`SELECT COUNT(*)::int n FROM schedule_assignments WHERE run_id='${RUN}'`);
  const wk=await sql(`SELECT status::text s FROM roster_weeks WHERE week_start='${WEEK}'`);
  runs[0].n===0 && asg[0].n===0 && wk[0].s==='locked'
    ? ok('run and assignments gone; week no longer claims to be published')
    : bad('delete cascade',JSON.stringify({runs,asg,wk}));
}
await clean();
console.log(`\n\x1b[1mResult:\x1b[0m \x1b[32m${pass} passed\x1b[0m, ${fails.length?`\x1b[31m${fails.length} failed\x1b[0m`:'0 failed'}`);
process.exit(fails.length?1:0);
