import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
const env={};
for (const l of (await readFile('.env.local','utf8')).split('\n')) {
  const m=l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if(m&&!l.trimStart().startsWith('#')) env[m[1]]=m[2];
}
const REF=env.VITE_SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./)[1];
const sql=async(q)=>{const r=await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query:q})});const b=await r.json().catch(()=>null);if(!r.ok)throw new Error(b?.message??r.status);return b;};

const G='990701', MGR='990702', PIN='T-' + randomBytes(12).toString('hex'), WEEK='2026-09-27';
const clean=()=>sql(`DELETE FROM roster_weeks WHERE week_start='${WEEK}';
                     DELETE FROM auth.users WHERE email LIKE '9907%@guards.local';
                     DELETE FROM roster_codes WHERE employee_code LIKE '9907%';`);
await clean();
await sql(`
  INSERT INTO roster_weeks (week_start,morning_target_slots,submission_deadline,status)
  VALUES ('${WEEK}',2,NOW()+INTERVAL '30 days','open');
  INSERT INTO roster_codes (employee_code,display_name,initial_role) VALUES
    ('${G}','שומר-RT','guard'), ('${MGR}','מנהל-RT','manager');
  INSERT INTO auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
    raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,
    email_change_token_new,email_change)
  SELECT '00000000-0000-0000-0000-000000000000',gen_random_uuid(),'authenticated','authenticated',
    c.code||'@guards.local',extensions.crypt('${PIN}',extensions.gen_salt('bf')),NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,NOW(),NOW(),'','','',''
    FROM (VALUES ('${G}'),('${MGR}')) AS c(code);
  INSERT INTO profiles (id,employee_code,display_name,role,is_active)
  SELECT u.id,split_part(u.email,'@',1),split_part(u.email,'@',1),
    CASE split_part(u.email,'@',1) WHEN '${MGR}' THEN 'manager'::user_role ELSE 'guard'::user_role END,TRUE
    FROM auth.users u WHERE u.email LIKE '9907%@guards.local';
  INSERT INTO schedule_runs (id,week_start,version,solver_status,is_published)
  VALUES ('eeeeeeee-0000-0000-0000-000000000001','${WEEK}',1,'OPTIMAL',TRUE);`);

// Subscribe exactly as a guard's phone does: signed in, publishable key only.
const db=createClient(env.VITE_SUPABASE_URL,env.VITE_SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const { error:e1 }=await db.auth.signInWithPassword({email:`${G}@guards.local`,password:PIN});
if(e1) throw new Error(e1.message);

const events=[];
const ch=db.channel(`roster-${WEEK}`)
  .on('postgres_changes',{event:'*',schema:'public',table:'schedule_assignments'},p=>events.push('assignment:'+p.eventType))
  .on('postgres_changes',{event:'*',schema:'public',table:'schedule_runs',filter:`week_start=eq.${WEEK}`},p=>events.push('run:'+p.eventType))
  .on('postgres_changes',{event:'*',schema:'public',table:'roster_weeks',filter:`week_start=eq.${WEEK}`},p=>events.push('week:'+p.eventType));

await new Promise((res,rej)=>{ const t=setTimeout(()=>rej(new Error('subscribe timeout')),20000);
  ch.subscribe(s=>{ if(s==='SUBSCRIBED'){clearTimeout(t);res();} if(s==='CHANNEL_ERROR'){clearTimeout(t);rej(new Error('channel error'));} }); });
console.log('  guard subscribed to the roster channel');

const gid=(await sql(`SELECT id FROM profiles WHERE employee_code='${G}'`))[0].id;
await sql(`INSERT INTO schedule_assignments (run_id,target_date,shift,guard_id)
           VALUES ('eeeeeeee-0000-0000-0000-000000000001','${WEEK}'::date,'morning','${gid}')`);
await new Promise(r=>setTimeout(r,2500));
await sql(`DELETE FROM schedule_assignments WHERE run_id='eeeeeeee-0000-0000-0000-000000000001'`);
await new Promise(r=>setTimeout(r,2500));
await sql(`UPDATE roster_weeks SET status='generated' WHERE week_start='${WEEK}'`);
await new Promise(r=>setTimeout(r,2500));

console.log('  events received:', events.length ? events.join(', ') : '(none)');
const okIns = events.some(e=>e==='assignment:INSERT');
const okDel = events.some(e=>e==='assignment:DELETE');
const okWeek= events.some(e=>e==='week:UPDATE');
console.log(`  ${okIns?'PASS':'FAIL'}  guard is pushed a NEW assignment (a shift added)`);
console.log(`  ${okDel?'PASS':'FAIL'}  guard is pushed a REMOVED assignment (sick guard dropped)`);
console.log(`  ${okWeek?'PASS':'FAIL'}  guard is pushed a week status change (roster deleted/unpublished)`);
await db.removeChannel(ch);

// ----------------------------------------------------------------------------
// Migration 18: a guard's submission pushed to the MANAGER's screen, the other
// direction from everything above. save_week_preferences does a DELETE then an
// INSERT on weekly_wish_preferences (spec's atomic-replace design), so a DELETE
// event reaching the manager is the real test of REPLICA IDENTITY FULL -- with
// the default identity the old row carries only its primary key, not guard_id,
// and the subs_read/prefs_read policy could not be evaluated against it.
// ----------------------------------------------------------------------------
// The guard-side block above intentionally flipped the week's status to
// 'generated' to exercise the roster_weeks DELETE-signal path; undo that here
// so is_week_open() lets the guard submit again below.
await sql(`UPDATE roster_weeks SET status='open' WHERE week_start='${WEEK}'`);

const mgrDb=createClient(env.VITE_SUPABASE_URL,env.VITE_SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const { error:e2 }=await mgrDb.auth.signInWithPassword({email:`${MGR}@guards.local`,password:PIN});
if(e2) throw new Error(e2.message);

const mgrEvents=[];
const mgrCh=mgrDb.channel(`submissions-${WEEK}`)
  .on('postgres_changes',{event:'*',schema:'public',table:'weekly_submissions',filter:`week_start=eq.${WEEK}`},p=>mgrEvents.push('sub:'+p.eventType))
  .on('postgres_changes',{event:'*',schema:'public',table:'weekly_wish_preferences',filter:`week_start=eq.${WEEK}`},p=>mgrEvents.push('pref:'+p.eventType));

await new Promise((res,rej)=>{ const t=setTimeout(()=>rej(new Error('manager subscribe timeout')),20000);
  mgrCh.subscribe(s=>{ if(s==='SUBSCRIBED'){clearTimeout(t);res();} if(s==='CHANNEL_ERROR'){clearTimeout(t);rej(new Error('channel error'));} }); });
console.log('\n  manager subscribed to the submissions channel');

const { error:e3 } = await db.rpc('save_week_preferences', {
  p_week_start: WEEK,
  p_slots: [{ date: WEEK, shift: 'morning', allows12h: false }],
  p_notes: 'עדיפות למשמרות לילה',
});
if (e3) throw new Error(e3.message);
await new Promise(r=>setTimeout(r,2500));
// Re-saving triggers the DELETE-then-INSERT this test exists to catch.
await db.rpc('save_week_preferences', {
  p_week_start: WEEK,
  p_slots: [{ date: WEEK, shift: 'night', allows12h: false }],
});
await new Promise(r=>setTimeout(r,2500));

console.log('  events received:', mgrEvents.length ? mgrEvents.join(', ') : '(none)');
const okSub  = mgrEvents.some(e=>e==='sub:INSERT'||e==='sub:UPDATE');
const okPrefIns = mgrEvents.some(e=>e==='pref:INSERT');
const okPrefDel = mgrEvents.some(e=>e==='pref:DELETE');
console.log(`  ${okSub?'PASS':'FAIL'}  manager is pushed the guard's submission (and note)`);
console.log(`  ${okPrefIns?'PASS':'FAIL'}  manager is pushed a new preference row`);
console.log(`  ${okPrefDel?'PASS':'FAIL'}  manager is pushed the DELETE from a re-save (REPLICA IDENTITY FULL)`);
await mgrDb.removeChannel(mgrCh);

await clean();
process.exit(okIns&&okDel&&okWeek&&okSub&&okPrefIns&&okPrefDel?0:1);
