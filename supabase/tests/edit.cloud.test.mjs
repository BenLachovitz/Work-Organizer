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

const MGR='990601', G1='990602', G2='990603', PIN='Edit-1234', WEEK='2026-09-20';
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
  const { error } = await g1.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[]});
  error?ok('a guard cannot edit a roster'):bad('guard edit','succeeded');
}
{
  await sql(`UPDATE schedule_runs SET is_published=TRUE WHERE id='${RUN}'`);
  const { error } = await mgr.rpc('save_run_assignments',{p_run_id:RUN,p_assignments:[]});
  error && /published/i.test(error.message)
    ? ok('editing a PUBLISHED roster is refused')
    : bad('published edit', error?error.message:'succeeded');
}
{
  const rows=await sql(`SELECT COUNT(*)::int n FROM schedule_assignments WHERE run_id='${RUN}'`);
  rows[0].n===1 ? ok('the refused edit left the published roster intact') : bad('intact',JSON.stringify(rows));
}
await clean();
console.log(`\n\x1b[1mResult:\x1b[0m \x1b[32m${pass} passed\x1b[0m, ${fails.length?`\x1b[31m${fails.length} failed\x1b[0m`:'0 failed'}`);
process.exit(fails.length?1:0);
