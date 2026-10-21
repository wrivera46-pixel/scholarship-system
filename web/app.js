import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');
const YEARS = ['2025-2026', '2026-2027', '2027-2028'];
const SEMS = [[1, '1st Semester'], [2, '2nd Semester'], [3, 'Summer']];
const SEED_B01_SUBMISSION = 'c0000000-0000-0000-0000-000000000001';
const fmt = (ts) => ts ? new Date(ts).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) + ' PHT' : '—';
const semLabel = (n) => (SEMS.find((s) => s[0] === Number(n)) || [0, 'Sem ' + n])[1];

let toastTimer;
function toast(text, kind = 'ok') {
  const t = $('#toast');
  t.textContent = text; t.className = 'show ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 4500);
}
const badge = (text, cls) => `<span class="badge ${cls}">${esc(text)}</span>`;
const verBadge = (s) => badge(s, { Pending: 'b-info', Verified: 'b-ok', Returned: 'b-warn' }[s] || 'b-none');
const compBadge = (s) => badge(s, { Compliant: 'b-ok', 'With Deficiency': 'b-bad' }[s] || 'b-none');
const renBadge = (s) => badge(s === 'None' ? 'No decision' : s, { Approved: 'b-ok', Held: 'b-warn' }[s] || 'b-none');

if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-ANON')) {
  main.innerHTML = `<div class="card auth"><h1>Setup needed</h1>
    <p>Open <code>web/config.js</code> and paste your Supabase project URL and <strong>anon</strong> key
    (Project Settings → API). Then reload this page. See README for the full steps.</p></div>`;
  throw new Error('Supabase not configured');
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me = null;
let programs = [];
let bootedUid;

async function call(name, args, okMsg) {
  const { data, error } = await sb.rpc(name, args);
  if (error) { toast(error.message, 'err'); return null; }
  if (okMsg) toast(okMsg, 'ok');
  return { data };
}

$('#btn-signout').addEventListener('click', () => sb.auth.signOut());
sb.auth.onAuthStateChange((ev) => {
  if (['SIGNED_IN', 'SIGNED_OUT', 'INITIAL_SESSION'].includes(ev)) setTimeout(boot, 0);
});

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id ?? null;
  if (uid === bootedUid) return;
  bootedUid = uid;
  if (!uid) { me = null; $('#topbar').hidden = true; return showAuth(); }
  const { data: prof } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
  if (!prof) {
    main.innerHTML = `<div class="card auth"><div class="msg err">Your profile could not be loaded. Sign out and try again.</div></div>`;
    $('#topbar').hidden = false; return;
  }
  me = prof;
  programs = (await sb.from('programs').select('*').order('code')).data || [];
  $('#topbar').hidden = false;
  $('#whoami').textContent = `${me.full_name} · ${me.role === 'staff' ? 'Scholarship Staff' : 'Scholar'}`;
  me.role === 'staff' ? staffApp() : scholarApp();
}

function showAuth(mode = 'in') {
  const up = mode === 'up';
  main.innerHTML = `<div class="card auth">
    <h1>${up ? 'Create scholar account' : 'Sign in'}</h1>
    <p class="muted small">Scholarship Monitor — submit semester grades and track verification and renewal.</p>
    <form id="auth-form">
      ${up ? `<label for="a-name">Full name</label><input id="a-name" required maxlength="80" autocomplete="name">
      <label for="a-sid" style="margin-top:10px">Student ID</label><input id="a-sid" required maxlength="30" placeholder="2026-0000">` : ''}
      <label for="a-email" style="margin-top:10px">Email</label><input id="a-email" type="email" required autocomplete="email">
      <label for="a-pw" style="margin-top:10px">Password</label><input id="a-pw" type="password" required minlength="6" autocomplete="${up ? 'new-password' : 'current-password'}">
      <div id="auth-msg"></div>
      <div class="row" style="margin-top:14px"><button type="submit">${up ? 'Create account' : 'Sign in'}</button>
      <button type="button" class="ghost" id="auth-toggle">${up ? 'I already have an account' : 'Create a scholar account'}</button></div>
    </form></div>`;
  $('#auth-toggle').onclick = () => showAuth(up ? 'in' : 'up');
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const msg = $('#auth-msg'); msg.innerHTML = '';
    const email = $('#a-email').value.trim(), password = $('#a-pw').value;
    if (up) {
      const { data, error } = await sb.auth.signUp({ email, password,
        options: { data: { full_name: $('#a-name').value.trim(), student_id: $('#a-sid').value.trim() } } });
      if (error) { msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
      if (!data.session) msg.innerHTML = `<div class="msg info">Account created. Check your email to confirm, then sign in.</div>`;
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`;
    }
  };
}

function summaryFields(v = {}, p = '') {
  const num = (id, label, val, extra = '') =>
    `<div><label for="${p}${id}">${label}</label><input id="${p}${id}" type="number" inputmode="decimal" ${extra} value="${esc(val ?? '')}" required></div>`;
  return `<div class="row">
      ${num('gwa', 'GWA (1.00 best – 5.00 fail)', v.gwa, 'step="0.01" min="1" max="5"')}
      ${num('units', 'Enrolled units', v.enrolled_units, 'step="1" min="0"')}
      ${num('failed', 'Failed subjects', v.failed_count, 'step="1" min="0"')}
      ${num('inc', 'Incomplete grades', v.incomplete_count, 'step="1" min="0"')}
      ${num('drop', 'Dropped subjects', v.dropped_count, 'step="1" min="0"')}
    </div>
    <div style="margin-top:10px"><label for="${p}evidence">Grade-document reference (file name, link or ID)</label>
    <input id="${p}evidence" maxlength="300" required value="${esc(v.evidence_ref ?? '')}" placeholder="e.g. GRADEDOC-2026-0001"></div>`;
}
function readSummary(root, p = '') {
  const n = (id) => { const s = $(`#${p}${id}`, root).value.trim(); return s === '' ? NaN : Number(s); };
  return { gwa: n('gwa'), units: n('units'), failed: n('failed'), inc: n('inc'), drop: n('drop'), evidence: $(`#${p}evidence`, root).value };
}
function checkSummary(v) {
  if (!(v.gwa >= 1 && v.gwa <= 5)) return 'GWA must be between 1.00 and 5.00.';
  if (Math.round(v.gwa * 100) / 100 !== v.gwa) return 'GWA may have at most 2 decimal places.';
  for (const [k, label] of [['units', 'Enrolled units'], ['failed', 'Failed subjects'], ['inc', 'Incomplete grades'], ['drop', 'Dropped subjects']])
    if (!Number.isInteger(v[k]) || v[k] < 0) return `${label} must be a non-negative whole number.`;
  if (!v.evidence.trim()) return 'A grade-document reference is required.';
  return null;
}

async function openDetail(id, host, staff, onChange) {
  host.innerHTML = '<div class="card muted">Loading…</div>';
  const [{ data: s }, { data: log }] = await Promise.all([
    sb.from('submission_details').select('*').eq('id', id).maybeSingle(),
    sb.from('audit_log').select('*').eq('submission_id', id).order('created_at').order('id'),
  ]);
  if (!s) { host.innerHTML = '<div class="card"><div class="msg err">Submission not found or access denied.</div></div>'; return; }
  const refresh = async () => { await openDetail(id, host, staff, onChange); onChange && onChange(); };

  const checks = s.evaluation_checks ? `<h3>Policy checks</h3><div class="table-wrap"><table>
    <tr><th>Check</th><th>Rule</th><th>Actual</th><th>Result</th></tr>
    ${s.evaluation_checks.map((c) => `<tr><td>${esc(c.check)}</td><td>${esc(c.rule)}</td><td>${esc(c.actual)}</td>
      <td class="${c.pass ? 'pass' : 'fail'}">${c.pass ? '✔ Pass' : '✘ Fail'}</td></tr>`).join('')}</table></div>` : '';
  const reasons = s.deficiency_reasons?.length
    ? `<div class="msg err"><strong>Deficiency reasons</strong><ul style="margin:6px 0 0 18px;padding:0">${s.deficiency_reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`
    : (s.compliance_result === 'Compliant' ? '<div class="msg ok">All policy checks passed.</div>' : '');
  const returned = s.verification_status === 'Returned'
    ? `<div class="msg warn"><strong>Returned for correction.</strong> Reason: ${esc(s.verification_reason)}</div>` : '';

  host.innerHTML = `<div class="card" id="detail-card">
    <div class="row" style="align-items:center"><h2 style="margin:0">${esc(s.full_name)} · ${esc(s.student_id)} — AY ${esc(s.academic_year)}, ${esc(semLabel(s.semester))}</h2>
      <div class="fixed"><button class="ghost small" id="d-close">Close</button></div></div>
    <p>${verBadge(s.verification_status)} ${compBadge(s.compliance_result)} ${renBadge(s.renewal_decision)}
       <span class="muted small"> Award status: ${esc(s.award_status || '—')}</span></p>
    ${returned}
    <div class="grid2"><dl>
      <dt>Program</dt><dd>${esc(s.program_name || 'Not assigned')}</dd>
      <dt>GWA</dt><dd>${Number(s.gwa).toFixed(2)}</dd>
      <dt>Enrolled units</dt><dd>${s.enrolled_units}</dd>
      <dt>Failed / INC / Dropped</dt><dd>${s.failed_count} / ${s.incomplete_count} / ${s.dropped_count}</dd></dl>
      <dl><dt>Evidence reference</dt><dd>${esc(s.evidence_ref)}</dd>
      <dt>Submitted</dt><dd>${fmt(s.submitted_at)}</dd>
      ${s.last_resubmitted_at ? `<dt>Last corrected</dt><dd>${fmt(s.last_resubmitted_at)}</dd>` : ''}
      <dt>Decision note</dt><dd>${esc(s.decision_note || '—')}</dd></dl></div>
    ${reasons}${checks}
    <div id="d-actions"></div>
    <h3>History</h3>
    <ul class="timeline">${(log || []).map((l) => `<li><strong>${esc(l.action)}</strong>${l.details ? ' — ' + esc(l.details) : ''}
      <div class="t">${esc(l.actor_name)} (${esc(l.actor_role)}) · ${fmt(l.created_at)}</div></li>`).join('') || '<li class="muted">No history yet.</li>'}</ul>
  </div>`;
  $('#d-close', host).onclick = () => (host.innerHTML = '');
  const actions = $('#d-actions', host);

  if (staff) {
    actions.innerHTML = `<h3>Staff actions</h3>
      <div class="card" style="background:var(--bg)"><strong>1. Verify evidence</strong>
      ${s.verification_status === 'Pending' ? `
        <label for="v-reason" style="margin-top:8px">Reason (required when returning)</label>
        <textarea id="v-reason" rows="2" maxlength="500"></textarea>
        <div class="row" style="margin-top:8px"><button class="good fixed" id="v-ok">Mark Verified</button><button class="danger fixed" id="v-ret">Return for correction</button></div>`
        : `<p class="muted small">Status is ${esc(s.verification_status)}${s.verification_status === 'Returned' ? ' — waiting for the scholar to correct and resubmit.' : '.'}</p>`}
      </div>
      <div class="card" style="background:var(--bg)"><strong>2. Evaluate compliance</strong>
        <p class="muted small">Only Verified submissions can be evaluated. Thresholds come from the scholar's program record.</p>
        <button class="fixed" id="ev-run">${s.compliance_result === 'Not Evaluated' ? 'Evaluate now' : 'Re-evaluate'}</button></div>
      <div class="card" style="background:var(--bg)"><strong>3. Renewal decision</strong>
        <p class="muted small">Approval requires a Compliant evaluation. Holding requires a note. Compliance flags never disqualify automatically.</p>
        <div class="row"><div><label for="rn-dec">Decision</label><select id="rn-dec"><option>Approved</option><option>Held</option></select></div>
        <div style="flex:3 1 260px"><label for="rn-note">Decision note</label><input id="rn-note" maxlength="500" value="${esc(s.decision_note || '')}"></div>
        <div class="fixed"><button id="rn-save">Record decision</button></div></div></div>`;
    const v = (status) => async () => {
      const r = await call('verify_submission', { p_id: id, p_status: status, p_reason: $('#v-reason', host).value || null },
        status === 'Verified' ? 'Marked Verified' : 'Returned to scholar');
      if (r) refresh();
    };
    if ($('#v-ok', host)) { $('#v-ok', host).onclick = v('Verified'); $('#v-ret', host).onclick = v('Returned'); }
    $('#ev-run', host).onclick = async () => { const r = await call('evaluate_submission', { p_id: id }, 'Evaluation recorded'); if (r) refresh(); };
    $('#rn-save', host).onclick = async () => {
      const r = await call('decide_renewal', { p_id: id, p_decision: $('#rn-dec', host).value, p_note: $('#rn-note', host).value || null }, 'Renewal decision recorded');
      if (r) refresh();
    };
  } else if (s.verification_status === 'Returned') {
    actions.innerHTML = `<h3>Correct and resubmit</h3><form id="fix-form">${summaryFields(s, 'fx-')}
      <div id="fix-err"></div><div style="margin-top:12px"><button type="submit">Resubmit for verification</button></div></form>`;
    $('#fix-form', host).onsubmit = async (e) => {
      e.preventDefault();
      const val = readSummary(host, 'fx-'); const bad = checkSummary(val);
      if (bad) { $('#fix-err', host).innerHTML = `<div class="msg err">${esc(bad)}</div>`; return; }
      const r = await call('resubmit_grades', { p_id: id, p_gwa: val.gwa, p_units: val.units, p_failed: val.failed, p_inc: val.inc, p_drop: val.drop, p_evidence: val.evidence }, 'Resubmitted — now Pending verification');
      if (r) refresh();
    };
  }
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- scholar app ----------
async function scholarApp() {
  const { data: a } = await sb.from('scholar_assignments').select('*').eq('scholar_id', me.id).maybeSingle();
  const prog = a ? programs.find((p) => p.id === a.program_id) : null;
  main.innerHTML = `
    <h1>My scholarship</h1>
    <p class="muted">Student ID ${esc(me.student_id || '—')} · ${prog ? esc(prog.name) : 'No program assigned yet'}</p>
    ${prog ? `<div class="msg info small">Your program requires: GWA ≤ ${Number(prog.max_gwa).toFixed(2)}, at least ${prog.min_units} units,
      failed ≤ ${prog.max_failed}, incomplete ≤ ${prog.max_incomplete}, dropped ≤ ${prog.max_dropped}. Deadline ${fmt(prog.deadline)}.</div>`
      : `<div class="msg warn">The Scholarship Office has not assigned you to a program yet. You can submit once you are assigned.</div>`}
    ${prog ? `<div class="card"><h2>Submit semester grades</h2><form id="sub-form">
      <div class="row"><div><label for="s-year">Academic year</label><select id="s-year">${YEARS.map((y) => `<option ${y === '2026-2027' ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
      <div><label for="s-sem">Semester</label><select id="s-sem">${SEMS.map(([n, l]) => `<option value="${n}">${l}</option>`).join('')}</select></div></div>
      <div style="margin-top:10px">${summaryFields()}</div>
      <div id="sub-err"></div><div style="margin-top:12px"><button type="submit">Submit grades</button></div></form></div>` : ''}
    <div class="card"><h2>My submissions</h2><div id="my-list"><p class="muted">Loading…</p></div></div>
    <div id="detail"></div>
    <div class="card"><h2>Access self-check <span class="muted small">(exam test aid for TC08)</span></h2>
      <p class="muted small">Tries to read every submission, read another scholar's record, and perform a staff-only action. The database should deny all of it.</p>
      <button class="ghost" id="self-check">Run access self-check</button><div id="self-out"></div></div>`;

  async function loadMine() {
    const { data, error } = await sb.from('submission_details').select('*').order('submitted_at', { ascending: false });
    const box = $('#my-list');
    if (error) { box.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
    if (!data.length) { box.innerHTML = '<p class="muted">No submissions yet.</p>'; return; }
    box.innerHTML = `<div class="table-wrap"><table><tr><th>Term</th><th>GWA</th><th>Units</th><th>Submitted</th><th>Verification</th><th>Compliance</th><th>Renewal</th></tr>
      ${data.map((s) => `<tr class="click" data-id="${s.id}"><td>${esc(s.academic_year)} · ${esc(semLabel(s.semester))}</td><td>${Number(s.gwa).toFixed(2)}</td><td>${s.enrolled_units}</td>
      <td>${fmt(s.submitted_at)}</td><td>${verBadge(s.verification_status)}</td><td>${compBadge(s.compliance_result)}</td><td>${renBadge(s.renewal_decision)}</td></tr>`).join('')}</table></div>
      <p class="muted small">Select a row for details, reasons and history.</p>`;
    box.querySelectorAll('tr.click').forEach((tr) => (tr.onclick = () => openDetail(tr.dataset.id, $('#detail'), false, loadMine)));
  }
  await loadMine();

  const form = $('#sub-form');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#sub-err'); err.innerHTML = '';
    const v = readSummary(form); const bad = checkSummary(v);
    if (bad) { err.innerHTML = `<div class="msg err">${esc(bad)}</div>`; return; }
    const r = await call('submit_grades', { p_year: $('#s-year').value, p_sem: Number($('#s-sem').value), p_gwa: v.gwa, p_units: v.units,
      p_failed: v.failed, p_inc: v.inc, p_drop: v.drop, p_evidence: v.evidence }, 'Submission received');
    if (!r) { /* server message already shown in the toast; repeat inline */ return; }
    form.reset(); await loadMine(); openDetail(r.data.id, $('#detail'), false, loadMine);
  };

  $('#self-check').onclick = async () => {
    const out = $('#self-out');
    const all = await sb.from('submissions').select('id');
    const other = await sb.from('submissions').select('id').eq('id', SEED_B01_SUBMISSION);
    const ver = await sb.rpc('verify_submission', { p_id: SEED_B01_SUBMISSION, p_status: 'Verified' });
    const upd = await sb.from('submissions').update({ renewal_decision: 'Approved' }).eq('id', SEED_B01_SUBMISSION);
    out.innerHTML = `<div class="msg info"><ul style="margin:0 0 0 18px;padding:0">
      <li>Submissions I can read: <strong>${all.data?.length ?? 0}</strong> (only my own)</li>
      <li>Another scholar's record by ID: <strong>${other.data?.length ?? 0}</strong> row(s)</li>
      <li>Call verify_submission: <strong>${ver.error ? 'DENIED — ' + esc(ver.error.message) : 'ALLOWED (defect!)'}</strong></li>
      <li>Direct UPDATE on submissions: <strong>${upd.error ? 'DENIED — ' + esc(upd.error.message) : (upd.status === 204 ? 'no rows affected / denied' : 'ALLOWED (defect!)')}</strong></li></ul></div>`;
  };
}

// ---------- staff app ----------
let tab = 'dashboard';
function staffApp() {
  main.innerHTML = `<div class="tabs" role="tablist">
    <button data-tab="dashboard">Dashboard</button><button data-tab="scholars">Scholars</button><button data-tab="policies">Programs &amp; policies</button></div>
    <div id="tab-body"></div>`;
  main.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; renderTab(); }));
  renderTab();
}
function renderTab() {
  main.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ({ dashboard: dashboardTab, scholars: scholarsTab, policies: policiesTab })[tab]($('#tab-body'));
}

async function dashboardTab(body) {
  body.innerHTML = `<div class="card"><div class="row">
      <div><label for="f-year">Academic year</label><select id="f-year">${YEARS.map((y) => `<option ${y === '2026-2027' ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
      <div><label for="f-sem">Semester</label><select id="f-sem">${SEMS.map(([n, l]) => `<option value="${n}">${l}</option>`).join('')}</select></div>
      <div style="flex:2 1 200px"><label for="f-q">Search student ID or name</label><input id="f-q" placeholder="e.g. 2026-0004 or Santos"></div>
      <div><label for="f-prog">Program</label><select id="f-prog"><option value="">All programs</option>${programs.map((p) => `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join('')}</select></div>
      <div><label for="f-comp">Compliance</label><select id="f-comp"><option value="">All</option><option>Not Evaluated</option><option>Compliant</option><option>With Deficiency</option></select></div>
    </div></div>
    <div class="stats" id="stats"></div>
    <div class="card"><h2>Submissions</h2><div id="list"><p class="muted">Loading…</p></div></div>
    <div id="detail"></div>`;

  async function load() {
    const year = $('#f-year').value, sem = Number($('#f-sem').value);
    const stats = await sb.rpc('dashboard_stats', { p_year: year, p_sem: sem });
    const st = stats.data || {};
    $('#stats').innerHTML = [['total_assigned', 'Assigned scholars'], ['pending', 'Pending verification'], ['compliant', 'Compliant'], ['deficiency', 'With deficiency']]
      .map(([k, l]) => `<div class="stat"><div class="n">${st[k] ?? '—'}</div><div class="l">${l}</div></div>`).join('');
    let q = sb.from('submission_details').select('*').eq('academic_year', year).eq('semester', sem).order('student_id');
    if ($('#f-prog').value) q = q.eq('program_code', $('#f-prog').value);
    if ($('#f-comp').value) q = q.eq('compliance_result', $('#f-comp').value);
    const term = $('#f-q').value.replace(/[%,()*\\"'_]/g, ' ').trim();
    if (term) q = q.or(`full_name.ilike.%${term}%,student_id.ilike.%${term}%`);
    const { data, error } = await q;
    const box = $('#list');
    if (error) { box.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
    if (!data.length) { box.innerHTML = '<p class="muted">No submissions match.</p>'; return; }
    box.innerHTML = `<div class="table-wrap"><table><tr><th>Student ID</th><th>Name</th><th>Program</th><th>GWA</th><th>Units</th><th>Submitted</th><th>Verification</th><th>Compliance</th><th>Renewal</th></tr>
      ${data.map((s) => `<tr class="click" data-id="${s.id}"><td>${esc(s.student_id)}</td><td>${esc(s.full_name)}</td><td>${esc(s.program_name || '—')}</td>
      <td>${Number(s.gwa).toFixed(2)}</td><td>${s.enrolled_units}</td><td>${fmt(s.submitted_at)}</td>
      <td>${verBadge(s.verification_status)}</td><td>${compBadge(s.compliance_result)}</td><td>${renBadge(s.renewal_decision)}</td></tr>`).join('')}</table></div>
      <p class="muted small">${data.length} record(s). Select a row to verify, evaluate or decide renewal.</p>`;
    box.querySelectorAll('tr.click').forEach((tr) => (tr.onclick = () => openDetail(tr.dataset.id, $('#detail'), true, load)));
  }
  let timer;
  ['#f-year', '#f-sem', '#f-prog', '#f-comp'].forEach((s) => ($(s).onchange = load));
  $('#f-q').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 300); };
  load();
}

async function scholarsTab(body) {
  body.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>';
  const [{ data: profs }, { data: asg }] = await Promise.all([
    sb.from('profiles').select('id,full_name,student_id,email').eq('role', 'scholar').order('student_id'),
    sb.from('scholar_assignments').select('scholar_id,program_id,award_status'),
  ]);
  const byScholar = Object.fromEntries((asg || []).map((a) => [a.scholar_id, a]));
  body.innerHTML = `<div class="card"><h2>Register scholars and assign a program</h2>
    <p class="muted small">Scholars create their own account (name and student ID). Staff register them here by assigning exactly one program; evaluation uses that program's thresholds.</p>
    <div class="table-wrap"><table><tr><th>Student ID</th><th>Name</th><th>Email</th><th>Status</th><th>Program</th><th></th></tr>
    ${(profs || []).map((p) => { const a = byScholar[p.id]; return `<tr><td>${esc(p.student_id || '—')}</td><td>${esc(p.full_name)}</td><td>${esc(p.email)}</td>
      <td>${a ? badge('Registered · ' + a.award_status, 'b-ok') : badge('Unassigned', 'b-warn')}</td>
      <td><select data-sel="${p.id}" aria-label="Program for ${esc(p.full_name)}">${a ? '' : '<option value="">Choose…</option>'}${programs.map((g) => `<option value="${g.id}" ${a?.program_id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></td>
      <td><button class="small" data-assign="${p.id}">${a ? 'Change' : 'Register'}</button></td></tr>`; }).join('')}</table></div></div>`;
  body.querySelectorAll('[data-assign]').forEach((btn) => (btn.onclick = async () => {
    const pid = $(`[data-sel="${btn.dataset.assign}"]`, body).value;
    if (!pid) { toast('Choose a program first', 'err'); return; }
    const r = await call('assign_scholar', { p_scholar_id: btn.dataset.assign, p_program_id: pid }, 'Scholar registered');
    if (r) scholarsTab(body);
  }));
}

function policiesTab(body) {
  body.innerHTML = `<div class="card"><h2>Programs and policy thresholds</h2>
    <p class="muted small">These persisted records are the only source of thresholds used by the evaluation function. Dates are Asia/Manila.</p>
    <div class="table-wrap"><table><tr><th>Program</th><th>Max GWA</th><th>Min units</th><th>Max failed</th><th>Max INC</th><th>Max dropped</th><th>Deadline</th></tr>
    ${programs.map((p) => `<tr><td>${esc(p.name)}</td><td>${Number(p.max_gwa).toFixed(2)}</td><td>${p.min_units}</td><td>${p.max_failed}</td><td>${p.max_incomplete}</td><td>${p.max_dropped}</td><td>${fmt(p.deadline)}</td></tr>`).join('')}</table></div></div>`;
}

boot();
