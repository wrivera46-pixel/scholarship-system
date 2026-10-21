import { PGlite } from '@electric-sql/pglite';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();

// ---- minimal Supabase stand-ins (only used by this local harness) ----
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key, instance_id uuid, aud text, role text, email text,
    encrypted_password text, email_confirmed_at timestamptz,
    raw_app_meta_data jsonb, raw_user_meta_data jsonb, created_at timestamptz, updated_at timestamptz);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`);
await db.exec(readFileSync(join(root, 'supabase/schema.sql'), 'utf8'));
await db.exec(readFileSync(join(root, 'supabase/seed.sql'), 'utf8'));

const STAFF = 'd0000000-0000-0000-0000-000000000001';
await db.exec(`
  insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
  values ('${STAFF}', 'staff.test@example.test', '{"full_name":"Staff Tester"}', now(), now());
  update public.profiles set role = 'staff' where id = '${STAFF}';
`);
const S = (n) => `b0000000-0000-0000-0000-00000000000${n}`;   // scholar B0n
const R = (n) => `c0000000-0000-0000-0000-00000000000${n}`;   // submission of B0n

async function as(uid) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]);
  await db.exec('set role authenticated');
}
async function admin() { await db.exec('reset role'); }
async function run(sql, params = []) {
  try { const r = await db.query(sql, params); return { ok: true, rows: r.rows }; }
  catch (e) { return { ok: false, error: e.message }; }
}

const results = [];
const rec = (id, action, expected, actual, pass, evidence) =>
  results.push({ id, action, expected, actual, pass, evidence });

async function evaluate(n) {
  await as(STAFF);
  return run('select * from public.evaluate_submission($1)', [R(n)]);
}
const reasonsOf = (r) => (r.ok ? r.rows[0].deficiency_reasons : []);

// ---------- TC01 ----------
{
  const r = await evaluate(1);
  const row = r.rows?.[0];
  const pass = r.ok && row.compliance_result === 'Compliant' && row.is_late === false;
  rec('TC01', 'Evaluate B01 (Excellence, GWA 2.00, 18 units, submitted exactly 2026-11-06 17:00)',
      'Compliant (exact GWA and deadline boundaries pass)',
      r.ok ? `${row.compliance_result}; late=${row.is_late}; reasons=[${row.deficiency_reasons}]` : r.error, pass, 'run-tests.mjs TC01');
}
// ---------- TC02 ----------
{
  const r = await evaluate(2); const rs = reasonsOf(r);
  const pass = r.ok && r.rows[0].compliance_result === 'With Deficiency' && rs.length === 1 && /GWA/.test(rs[0]);
  rec('TC02', 'Evaluate B02 (Excellence, GWA 2.01)', 'With Deficiency, one GWA reason',
      r.ok ? `${r.rows[0].compliance_result}; ${rs.join(' | ')}` : r.error, pass, 'run-tests.mjs TC02');
}
// ---------- TC03 ----------
{
  const r = await evaluate(3);
  const pass = r.ok && r.rows[0].compliance_result === 'Compliant';
  rec('TC03', 'Evaluate B03 (Access, GWA 2.50, 15 units, 1 dropped)', 'Compliant (Access allows 1 dropped subject)',
      r.ok ? `${r.rows[0].compliance_result}; reasons=[${r.rows[0].deficiency_reasons}]` : r.error, pass, 'run-tests.mjs TC03');
}
// ---------- TC04 ----------
{
  const r = await evaluate(4); const rs = reasonsOf(r);
  const pass = r.ok && r.rows[0].compliance_result === 'With Deficiency' && rs.length === 2
    && rs.some(x => /units/i.test(x)) && rs.some(x => /Incomplete/i.test(x));
  rec('TC04', 'Evaluate B04 (Access, 14 units, 1 incomplete)', 'With Deficiency: insufficient units AND incomplete grade',
      r.ok ? `${r.rows[0].compliance_result}; ${rs.join(' | ')}` : r.error, pass, 'run-tests.mjs TC04');
}
// ---------- TC05 ----------
{
  const r = await evaluate(5); const rs = reasonsOf(r);
  const pass = r.ok && r.rows[0].compliance_result === 'With Deficiency' && r.rows[0].is_late === true
    && rs.some(x => /Failed/i.test(x)) && rs.some(x => /Late/i.test(x));
  rec('TC05', 'Evaluate B05 (Excellence, 1 failed, submitted 17:01)', 'With Deficiency: failing subject AND late submission',
      r.ok ? `${r.rows[0].compliance_result}; ${rs.join(' | ')}` : r.error, pass, 'run-tests.mjs TC05');
}
// ---------- TC06 ----------
{
  await as(STAFF);
  const ev = await run('select * from public.evaluate_submission($1)', [R(6)]);
  const rn = await run(`select * from public.decide_renewal($1, 'Approved', 'try')`, [R(6)]);
  const pass = !ev.ok && !rn.ok;
  rec('TC06', 'Staff attempt to evaluate and approve renewal for B06 (Pending verification)',
      'Both blocked until verified and evaluated',
      `evaluate: ${ev.ok ? 'ALLOWED' : ev.error} || approve: ${rn.ok ? 'ALLOWED' : rn.error}`, pass, 'run-tests.mjs TC06');
}
// ---------- Dashboard (rubric: dashboard) ----------
{
  await as(STAFF);
  const r = await run(`select public.dashboard_stats('2026-2027', 1) as s`);
  const s = r.rows?.[0]?.s;
  const pass = r.ok && s.total_assigned == 6 && s.pending == 1 && s.compliant == 2 && s.deficiency == 3;
  rec('DASH', 'Dashboard stats AY 2026-2027 Sem 1 after TC01-TC06',
      'assigned 6, pending 1, compliant 2, with deficiency 3', r.ok ? JSON.stringify(s) : r.error, pass, 'run-tests.mjs DASH');
  const f = await run(`select student_id from public.submission_details
                       where academic_year='2026-2027' and semester=1 and program_code='ACC' and compliance_result='With Deficiency'`);
  rec('DASH-F', 'Filter program = Access, compliance = With Deficiency', 'only B04 (2026-0004)',
      f.ok ? f.rows.map(x => x.student_id).join(',') : f.error, f.ok && f.rows.length === 1 && f.rows[0].student_id === '2026-0004', 'run-tests.mjs DASH-F');
  const q = await run(`select student_id from public.submission_details where full_name ilike '%santos%' or student_id ilike '%santos%'`);
  rec('DASH-S', 'Search "santos"', 'only B01 (2026-0001)',
      q.ok ? q.rows.map(x => x.student_id).join(',') : q.error, q.ok && q.rows.length === 1 && q.rows[0].student_id === '2026-0001', 'run-tests.mjs DASH-S');
}
// ---------- TC07 ----------
{
  await as(S(1));
  const dup = await run(`select * from public.submit_grades('2026-2027',1,2.00,18,0,0,0,'X')`);
  const g = await run(`select * from public.submit_grades('2026-2027',2,0.50,18,0,0,0,'X')`);
  const n = await run(`select * from public.submit_grades('2026-2027',2,2.00,-1,0,0,0,'X')`);
  const pass = !dup.ok && /already exists/i.test(dup.error) && !g.ok && /between 1.00 and 5.00/.test(g.error) && !n.ok && /non-negative/.test(n.error);
  rec('TC07', 'B01 scholar: (a) duplicate AY2026-2027 sem 1, (b) GWA 0.50, (c) units -1',
      'All three rejected with clear messages',
      `(a) ${dup.error} || (b) ${g.error} || (c) ${n.error}`, pass, 'run-tests.mjs TC07');
}
// ---------- TC08 ----------
{
  await as(S(2));
  const own = await run('select id from public.submissions');
  const other = await run('select id from public.submissions where id = $1', [R(1)]);
  const view = await run('select student_id from public.submission_details');
  const ver = await run(`select * from public.verify_submission($1,'Verified',null)`, [R(1)]);
  const upd = await run(`update public.submissions set renewal_decision='Approved' where id=$1`, [R(2)]);
  const prof = await run('select id from public.profiles');
  const pass = own.rows.length === 1 && other.rows.length === 0 && view.rows.length === 1
    && !ver.ok && /Staff access required/.test(ver.error) && !upd.ok && prof.rows.length === 1;
  rec('TC08', 'As scholar B02: read all submissions, read B01 record by id, call verify_submission, direct UPDATE, read profiles',
      'Only own row visible; other record invisible; verify denied; direct write denied',
      `visible submissions=${own.rows.length}; B01 by id=${other.rows.length}; view rows=${view.rows.length}; profiles visible=${prof.rows.length}; verify -> ${ver.error}; update -> ${upd.error}`,
      pass, 'run-tests.mjs TC08');
  await as(STAFF);
  const all = await run('select id from public.submissions');
  rec('TC08b', 'Same query as staff', 'All 6 seeded submissions visible', `visible=${all.rows.length}`, all.rows.length === 6, 'run-tests.mjs TC08b');
}
// ---------- TC09 ----------
{
  await as(STAFF);
  const ret = await run(`select * from public.verify_submission($1,'Returned','Grade document unreadable')`, [R(6)]);
  await as(S(6));
  const bad = await run(`select * from public.resubmit_grades($1,2.25,15,0,0,0,'')`, [R(6)]);
  const fix = await run(`select * from public.resubmit_grades($1,2.25,15,0,0,0,'GRADEDOC-2026-B06-v2')`, [R(6)]);
  await admin();   // simulate "refresh": re-read from the database
  const after = await run(`select verification_status, evidence_ref, verification_reason from public.submissions where id=$1`, [R(6)]);
  const log = await run(`select action from public.audit_log where submission_id=$1 order by id`, [R(6)]);
  const acts = log.rows.map(x => x.action);
  const pass = ret.ok && !bad.ok && fix.ok && after.rows[0].verification_status === 'Pending'
    && after.rows[0].evidence_ref === 'GRADEDOC-2026-B06-v2'
    && acts.includes('Verification: Returned') && acts.includes('Resubmitted');
  rec('TC09', 'Return B06 with reason; scholar resubmits (blank evidence first, then corrected); re-read',
      'Blank evidence rejected; record is Pending with new evidence; history preserved',
      `status=${after.rows[0].verification_status}; evidence=${after.rows[0].evidence_ref}; history=[${acts.join(' > ')}]`, pass, 'run-tests.mjs TC09');
}
// ---------- TC10 ----------
{
  await as(S(1));
  const sch = await run(`select * from public.decide_renewal($1,'Approved','self')`, [R(1)]);
  const direct = await run(`update public.submissions set renewal_decision='Approved' where id=$1`, [R(1)]);
  await as(STAFF);
  const ok = await run(`select * from public.decide_renewal($1,'Approved','Meets all criteria')`, [R(1)]);
  const hold = await run(`select * from public.decide_renewal($1,'Held','GWA above limit; awaiting review')`, [R(2)]);
  const bad = await run(`select * from public.decide_renewal($1,'Approved','override')`, [R(2)]);
  const noNote = await run(`select * from public.decide_renewal($1,'Held','')`, [R(4)]);
  const pass = !sch.ok && !direct.ok && ok.ok && ok.rows[0].renewal_decision === 'Approved'
    && hold.ok && hold.rows[0].renewal_decision === 'Held' && !bad.ok && /With Deficiency/.test(bad.error) && !noNote.ok;
  rec('TC10', 'Scholar tries to approve own record; staff approve compliant B01, hold deficient B02, try to approve B02, hold B04 without note',
      'Scholar denied; B01 Approved; B02 Held; approving B02 refused; hold without note refused',
      `scholar -> ${sch.error}; direct update -> ${direct.error}; B01=${ok.rows?.[0]?.renewal_decision}; B02=${hold.rows?.[0]?.renewal_decision}; approve B02 -> ${bad.error}; hold w/o note -> ${noNote.error}`,
      pass, 'run-tests.mjs TC10');
}
// ---------- extra: separation of the three status dimensions ----------
{
  await admin();
  const r = await run(`select verification_status, compliance_result, renewal_decision, award_status
                       from public.submission_details where id=$1`, [R(2)]);
  const x = r.rows[0];
  rec('EXTRA-1', 'B02 after hold: three status dimensions + award status',
      'Verified / With Deficiency / Held / award still Active (flag does not disqualify)',
      `${x.verification_status} / ${x.compliance_result} / ${x.renewal_decision} / ${x.award_status}`,
      x.verification_status === 'Verified' && x.compliance_result === 'With Deficiency' && x.award_status === 'Active', 'run-tests.mjs EXTRA-1');
}
// ---------- extra: policy thresholds are read from the program row ----------
{
  await admin();
  await db.exec(`update public.programs set max_gwa = 2.10 where code='EXC'`);
  await as(STAFF);
  const r = await evaluate(2);       // B02, GWA 2.01, currently Held (re-evaluation allowed)
  await admin();
  await db.exec(`update public.programs set max_gwa = 2.00 where code='EXC'`);
  rec('EXTRA-2', 'Raise Excellence max_gwa to 2.10 in the programs row, re-evaluate B02 (GWA 2.01)',
      'Now Compliant: thresholds come from the program record, not code',
      r.ok ? r.rows[0].compliance_result : r.error, r.ok && r.rows[0].compliance_result === 'Compliant', 'run-tests.mjs EXTRA-2');
}
// ---------- extra: anonymous access ----------
{
  await admin(); await db.exec('set role anon');
  const a = await run('select * from public.submissions');
  const b = await run(`select * from public.dashboard_stats('2026-2027',1)`);
  rec('EXTRA-3', 'Unauthenticated (anon) reads submissions / calls dashboard_stats', 'Both denied',
      `select -> ${a.error}; rpc -> ${b.error}`, !a.ok && !b.ok, 'run-tests.mjs EXTRA-3');
}

// ---------- report ----------
await admin();
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const lines = [
  '# Test Results — TC01 to TC10',
  '',
  `Run: ${new Date().toISOString()} (generated by \`tests/run-tests.mjs\`)`,
  '',
  '**How these were run.** `schema.sql` and `seed.sql` were executed unchanged in a real PostgreSQL engine (PGlite) with Supabase-style `anon`/`authenticated` roles and `auth.uid()`. Each test impersonates the correct user (staff or a specific scholar) and calls the same RPC functions / tables the web app calls, so row-level security, privileges and business rules are genuinely exercised.',
  '',
  '**What this does not cover.** The browser UI and the hosted Supabase project were not part of this run. Screenshots of each screen (submission, verification, compliance, renewal, dashboard, role access) must be captured from the running app and attached — see README step 7.',
  '',
  '| Test ID | Input / action | Expected result | Actual result | Pass / Fail | Evidence |',
  '|---|---|---|---|---|---|',
  ...results.map(r => `| ${r.id} | ${esc(r.action)} | ${esc(r.expected)} | ${esc(r.actual)} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.evidence} |`),
  '',
  `**Summary:** ${results.filter(r => r.pass).length} / ${results.length} checks passed.`,
  '',
  '## Known defects / limitations',
  '- Scholar self-registers through the sign-up form; staff then "register" the scholar by assigning a program (two-step, because browser code cannot create auth users without a service-role key).',
  '- A scholar can only correct a submission that staff Returned; there is no appeal workflow (out of scope).',
  '- The deadline is stored on the program row, so one deadline applies to all semesters of a program (matches the exam policy; a per-term deadline table would be the next step).',
  '',
];
writeFileSync(join(root, 'TEST_RESULTS.md'), lines.join('\n'));
console.log(lines.slice(8, 8 + results.length + 2).join('\n'));
console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`);
process.exit(results.every(r => r.pass) ? 0 : 1);
