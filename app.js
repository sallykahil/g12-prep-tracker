/* G12++ Cohort Monitor
 * Combines the Prep App export and Questionmark scores, cleans them,
 * and shows per NGO: (a) the learner funnel, (b) learning gain (mock - baseline).
 * Everything runs in the browser. No data is sent anywhere.
 */

// ---------- Settings (easy to change live) ----------
const CONFIG = {
  appFile: 'data/prep_app_export.csv',
  scoresFile: 'data/questionmark_scores.csv',
  minScore: 0,
  maxScore: 100,
  smallGroup: 5,          // groups with fewer pairs than this get a "small sample" warning
  stalledDays: 14,        // started studying, no mock, inactive this many days before the snapshot
  testEmails: ['test.user@mail.example'],  // plus any email starting with "test.", "test_" or "test-"
};

// Expected file templates. If a source system renames or adds a column, update it here
// (and in clean() below if the tool should use the new column).
const TEMPLATES = {
  app: {
    label: 'Prep App export',
    filename: 'prep_app_export_template.csv',
    columns: ['learner_email', 'full_name', 'phone', 'date_of_birth', 'ngo', 'device', 'registered_date',
              'password_set', 'orientation_done', 'topics_completed', 'subjects_started', 'subjects_completed', 'last_active_date'],
    required: ['learner_email', 'ngo', 'device', 'registered_date', 'password_set', 'orientation_done',
               'topics_completed', 'subjects_started', 'subjects_completed', 'last_active_date'],
    example: ['learner.name@mail.example', 'Learner Name', '+961 70 000 000', '2008-01-31', 'NGO-A', 'phone', '2026-11-15',
              '1', '1', '12', '2', '1', '2027-02-10'],
  },
  scores: {
    label: 'Questionmark scores',
    filename: 'questionmark_scores_template.csv',
    columns: ['email', 'assessment', 'subject', 'score_pct', 'date_taken'],
    required: ['email', 'assessment', 'subject', 'score_pct', 'date_taken'],
    example: ['learner.name@mail.example', 'Baseline', 'Mathematics', '48', '2026-11-20'],
  },
};

// Funnel stages, in order. Each test returns true if the learner reached that stage.
const STAGES = [
  { key: 'registered',  label: 'Registered',              test: l => true },
  { key: 'password',    label: 'Set password',            test: l => l.password_set === 1 },
  { key: 'orientation', label: 'Finished orientation',    test: l => l.orientation_done === 1 },
  { key: 'baseline',    label: 'Took baseline',           test: l => l.baselineSubjects > 0 },
  { key: 'topics',      label: 'Started topics',          test: l => l.topics_completed > 0 },
  { key: 'subject',     label: 'Completed 1+ subject',    test: l => l.subjects_completed > 0 },
  { key: 'mock',        label: 'Took mock exam',          test: l => l.mockSubjects > 0 },
];

// ---------- CSV parsing ----------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  if (!rows.length) return { header: [], rows: [] };
  // Normalise headers so "Learner Email" and "learner_email" both match
  const header = rows.shift().map(h => h.replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, '_'));
  return { header, rows: rows.map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

// Returns a list of problems with a parsed file, or an empty list if it matches the template
function checkFile(parsed, key) {
  const t = TEMPLATES[key];
  if (!parsed.header.length) return [`${t.label}: the file is empty.`];
  const missing = t.required.filter(c => !parsed.header.includes(c));
  if (missing.length) return [`${t.label} is missing ${missing.length === 1 ? 'a column' : 'columns'}: ${missing.join(', ')}.`];
  if (!parsed.rows.length) return [`${t.label}: the file has column names but no rows.`];
  return [];
}

// Builds a CSV with the expected columns and one example row, and downloads it
function downloadTemplate(key) {
  const t = TEMPLATES[key];
  const csv = t.columns.join(',') + '\n' + t.example.join(',') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = t.filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const isTest = e => CONFIG.testEmails.includes(e) || /^test[._-]/.test(e);
const normEmail = e => (e || '').trim().toLowerCase();
// Hide personal data on screen: "dana.saleh@mail.example" -> "d•••@mail.example"
const maskEmail = e => { const [u, d] = e.split('@'); return `${u[0]}•••@${d || ''}`; };
const toInt = v => (v === '' || v == null ? 0 : parseInt(v, 10));

// ---------- Cleaning ----------
function clean(appRows, scoreRows) {
  const log = [];
  const note = (title, count, action, items = []) => { if (count) log.push({ title, count, action, items }); };

  // 1. Normalise emails in both files (spaces, capital letters)
  let emailFixes = 0;
  scoreRows.forEach(r => { const n = normEmail(r.email); if (n !== r.email) emailFixes++; r.email = n; });
  appRows.forEach(r => { const n = normEmail(r.learner_email); if (n !== r.learner_email) emailFixes++; r.learner_email = n; });
  note('Emails with extra spaces or capital letters', emailFixes,
       'Trimmed and lower-cased so they match across the two files.');

  // 2. Duplicate learners in the app export: keep the record with the most progress
  const byEmail = new Map();
  const dupes = [];
  appRows.forEach(r => {
    const l = {
      email: r.learner_email, ngo: r.ngo, device: r.device,
      registered: r.registered_date, lastActive: r.last_active_date,
      password_set: toInt(r.password_set), orientation_done: toInt(r.orientation_done),
      topics_completed: toInt(r.topics_completed), subjects_started: toInt(r.subjects_started),
      subjects_completed: toInt(r.subjects_completed),
    };
    const prev = byEmail.get(l.email);
    if (!prev) { byEmail.set(l.email, l); return; }
    dupes.push(l.email);
    const keep = l.topics_completed > prev.topics_completed ? l : prev;
    keep.registered = [prev.registered, l.registered].sort()[0];   // earliest registration
    byEmail.set(l.email, keep);
  });
  note('Learners registered twice', dupes.length,
       'Merged into one record, keeping the one with the most progress and the earliest registration date.', dupes.map(maskEmail));

  // 3. Score rows that don't belong to a real learner
  const testRows = scoreRows.filter(r => isTest(r.email));
  const orphanRows = scoreRows.filter(r => !isTest(r.email) && !byEmail.has(r.email));
  note('Test account in Questionmark', testRows.length, 'Removed.', [...new Set(testRows.map(r => maskEmail(r.email)))]);
  note('Scores with no matching learner in the app', orphanRows.length, 'Removed (cannot be assigned to an NGO).',
       [...new Set(orphanRows.map(r => maskEmail(r.email)))]);
  let scores = scoreRows.filter(r => byEmail.has(r.email) && !isTest(r.email))
    .map(r => ({ email: r.email, assessment: r.assessment, subject: r.subject,
                 score: Number(r.score_pct), date: r.date_taken, valid: true, reason: '' }));

  // 4. Duplicate score rows (same learner, test, subject): keep the latest
  const seen = new Map(); let dupScores = 0;
  scores.forEach(s => {
    const k = `${s.email}|${s.assessment}|${s.subject}`;
    const prev = seen.get(k);
    if (prev) { dupScores++; if (s.date > prev.date) seen.set(k, s); } else seen.set(k, s);
  });
  scores = [...seen.values()];
  note('Duplicate test results', dupScores, 'Kept the most recent attempt.');

  // 5. Impossible scores
  const outOfRange = scores.filter(s => isNaN(s.score) || s.score < CONFIG.minScore || s.score > CONFIG.maxScore);
  outOfRange.forEach(s => { s.valid = false; s.reason = 'score out of range'; });
  note(`Scores outside ${CONFIG.minScore}-${CONFIG.maxScore}%`, outOfRange.length,
       'Kept as "took the test" in the funnel, excluded from learning gain.',
       outOfRange.map(s => `${s.assessment} ${s.subject}: ${s.score}%`));

  // 6. Mock taken before the baseline or before registration
  const baseDate = new Map(scores.filter(s => s.assessment === 'Baseline').map(s => [`${s.email}|${s.subject}`, s.date]));
  const badDates = scores.filter(s => s.assessment === 'Mock' && (
    (baseDate.has(`${s.email}|${s.subject}`) && s.date < baseDate.get(`${s.email}|${s.subject}`)) ||
    s.date < byEmail.get(s.email).registered));
  badDates.forEach(s => { s.valid = false; s.reason = 'mock dated before baseline/registration'; });
  note('Mock dated before the baseline or registration', badDates.length,
       'Likely a date or label error. Kept in the funnel, excluded from learning gain.',
       badDates.map(s => `${s.subject} mock on ${s.date}`));

  // Attach test coverage to learners
  const learners = [...byEmail.values()];
  learners.forEach(l => {
    const mine = scores.filter(s => s.email === l.email);
    l.baselineSubjects = new Set(mine.filter(s => s.assessment === 'Baseline').map(s => s.subject)).size;
    l.mockSubjects = new Set(mine.filter(s => s.assessment === 'Mock').map(s => s.subject)).size;
  });

  // 7. Inconsistent journeys (flag only)
  const skipped = learners.filter(l => l.mockSubjects > 0 && (l.baselineSubjects === 0 || l.topics_completed === 0));
  note('Took a mock without a baseline or any study', skipped.length,
       'Counted at the mock stage, excluded from learning gain. Possibly a wrong email in Questionmark.');
  const partialMock = learners.filter(l => l.mockSubjects === 1);
  note('Mock taken in one subject only', partialMock.length, 'Gain calculated only for the subject taken.');

  return { learners, scores, log };
}

// ---------- Metrics ----------
function funnel(learners) {
  const total = learners.length;
  let prev = total;
  return STAGES.map(st => {
    const n = learners.filter(st.test).length;
    const row = { ...st, n, pctOfReg: total ? n / total : 0, stepConv: prev ? n / prev : 0 };
    prev = n; return row;
  });
}

function gains(learners, scores) {
  const emails = new Set(learners.map(l => l.email));
  const pairs = [];
  const index = new Map();
  scores.filter(s => s.valid && emails.has(s.email)).forEach(s => index.set(`${s.email}|${s.subject}|${s.assessment}`, s.score));
  const subjects = [...new Set(scores.map(s => s.subject))].sort();
  learners.forEach(l => subjects.forEach(subj => {
    const b = index.get(`${l.email}|${subj}|Baseline`), m = index.get(`${l.email}|${subj}|Mock`);
    if (b != null && m != null) pairs.push({ ngo: l.ngo, subject: subj, baseline: b, mock: m, gain: m - b });
  }));
  return pairs;
}

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- Rendering ----------
const $ = sel => document.querySelector(sel);
const pct = x => `${Math.round(x * 100)}%`;
const fmt = x => x == null ? '–' : (x > 0 ? '+' : '') + x.toFixed(1);
let STATE = { data: null, ngo: 'All' };

function render() {
  const { learners, scores, log } = STATE.data;
  const ngos = [...new Set(learners.map(l => l.ngo))].sort();
  const view = STATE.ngo === 'All' ? learners : learners.filter(l => l.ngo === STATE.ngo);
  const snapshot = learners.map(l => l.lastActive).sort().at(-1);

  // Tabs
  $('#tabs').innerHTML = ['All', ...ngos].map(n =>
    `<button class="tab" role="tab" aria-selected="${n === STATE.ngo}" data-ngo="${n}">${n === 'All' ? 'All NGOs' : n}</button>`).join('');
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => { STATE.ngo = b.dataset.ngo; render(); });

  // Summary
  const f = funnel(view);
  const p = gains(view, scores);
  const stalled = view.filter(l => l.topics_completed > 0 && l.mockSubjects === 0 &&
    (new Date(snapshot) - new Date(l.lastActive)) / 86400000 >= CONFIG.stalledDays).length;
  $('#snapshot').textContent = new Date(snapshot).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  $('#ngo-count').textContent = `${ngos.length} NGOs`;
  $('#learner-count').textContent = `${learners.length} learners`;
  $('#summary').innerHTML = [
    ['Learners', view.length, 'after removing duplicates'],
    ['Took the mock', pct(f.at(-1).pctOfReg), `${f.at(-1).n} of ${view.length} registered learners`],
    ['Average gain', p.length ? `${fmt(mean(p.map(x => x.gain)))} pts` : '–', `${p.length} subject results with a valid baseline and mock`],
    ['Stopped studying', stalled, `started topics, no mock, inactive ${CONFIG.stalledDays}+ days`],
  ].map(([k, v, s]) => `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v">${v}</div><div class="stat-s">${s}</div></div>`).join('');

  // Funnel bars
  // Biggest drop = the step where the most learners were lost (counts, not %, so tiny groups don't mislead)
  const lost = i => f[i - 1].n - f[i].n;
  const dropIdx = f.slice(1).reduce((best, _, k) => (lost(k + 1) > lost(best) ? k + 1 : best), 1);
  const biggestDrop = f[dropIdx];
  $('#funnel').innerHTML = f.map((r, i) => `
    <div class="frow">
      <div class="flabel">${r.label}</div>
      <div class="ftrack"><div class="fbar" style="width:${(r.pctOfReg * 100).toFixed(1)}%"></div></div>
      <div class="fnum">${r.n}</div>
      <div class="fpct">${pct(r.pctOfReg)}</div>
      <div class="fstep">${i === 0 ? '' : (f[i - 1].n - r.n === 0 ? '0' : `−${f[i - 1].n - r.n}`)}</div>
    </div>`).join('');
  $('#funnel-note').textContent = biggestDrop && biggestDrop.stepConv < 1
    ? `Biggest drop: ${f[dropIdx - 1].label.toLowerCase()} → ${biggestDrop.label.toLowerCase()} (${lost(dropIdx)} learners, ${pct(1 - biggestDrop.stepConv)} of those at the previous stage).`
    : '';

  // NGO comparison matrix (always shows all NGOs)
  const cols = ngos.map(n => ({ n, f: funnel(learners.filter(l => l.ngo === n)) }));
  $('#matrix').innerHTML = `<table><thead><tr><th>Stage</th>${cols.map(c => `<th>${c.n}<span class="sub">n=${c.f[0].n}</span></th>`).join('')}</tr></thead><tbody>
    ${STAGES.map((st, i) => `<tr><td>${st.label}</td>${cols.map(c => {
      const v = c.f[i].pctOfReg;
      return `<td class="heat" style="--v:${v}">${pct(v)} <span class="sub">${c.f[i].n}</span></td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;

  // Devices: which device learners use, and how many of them reached the mock (always all NGOs)
  const devices = [...new Set(learners.map(l => l.device))].sort((a, b) => a === 'phone' ? -1 : b === 'phone' ? 1 : a.localeCompare(b));
  const devRow = (name, group) => `<tr><td>${name}</td>${devices.map(d => {
    const on = group.filter(l => l.device === d), mock = on.filter(l => l.mockSubjects > 0).length;
    return `<td class="r">${on.length}</td><td class="r">${on.length ? mock : '–'}</td>`;
  }).join('')}</tr>`;
  $('#devices').innerHTML = `<table><thead><tr><th>NGO</th>${devices.map(d => `<th class="r">On ${d}</th><th class="r">Took the mock</th>`).join('')}</tr></thead><tbody>
    ${ngos.map(n => devRow(n, learners.filter(l => l.ngo === n))).join('')}
    <tr class="total">${devRow('All NGOs', learners).slice(4)}</tbody></table>`;

  // Learning gain table + dot strip
  const groups = [];
  const subjects = [...new Set(scores.map(s => s.subject))].sort();
  (STATE.ngo === 'All' ? ngos : [STATE.ngo]).forEach(n => subjects.forEach(s => {
    const g = p.filter(x => x.ngo === n && x.subject === s).map(x => x.gain);
    groups.push({ ngo: n, subject: s, g });
  }));
  const lo = -10, hi = 40, x = v => ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * 100;
  $('#gain').innerHTML = `<table><thead><tr><th>NGO</th><th>Subject</th><th class="r">Learners</th><th class="r">Average</th><th class="r">Median</th><th class="strip-h">Improvement per learner (points)<span class="axis">${[-10, 0, 10, 20, 30, 40].map(t => `<span style="left:${x(t)}%">${t > 0 ? '+' + t : t === 0 ? '0' : '−' + -t}</span>`).join('')}</span></th></tr></thead><tbody>
    ${groups.map(gr => `<tr>
      <td>${gr.ngo}</td><td>${gr.subject}</td>
      <td class="r">${gr.g.length}${!gr.g.length ? ' <span class="chip">no data</span>' : ''}</td>
      <td class="r strong">${fmt(mean(gr.g))}${gr.g.length && gr.g.length < CONFIG.smallGroup ? '<span class="star">*</span>' : ''}</td><td class="r">${fmt(median(gr.g))}</td>
      <td class="strip"><span class="zero" style="left:${x(0)}%"></span>${gr.g.map(v => `<span class="dot" style="left:${x(v)}%" title="${fmt(v)}"></span>`).join('')}
        ${gr.g.length ? `<span class="mean" style="left:${x(mean(gr.g))}%"></span>` : ''}</td>
    </tr>`).join('')}</tbody></table>
    <p class="legend"><span class="key-dot"></span> one learner <span class="key-mean"></span> group average <span class="muted">· further right = bigger improvement; left of 0 = score went down; darker dots = learners with the same result</span></p>
    ${groups.some(gr => gr.g.length && gr.g.length < CONFIG.smallGroup) ? `<p class="legend muted">* Fewer than ${CONFIG.smallGroup} learners, so this average can change a lot with one learner.</p>` : ''}`;

  // Data quality log
  $('#log').innerHTML = log.map(i => `<li><div class="lhead"><span class="lcount">${i.count}</span><span class="ltitle">${i.title}</span></div>
    <div class="laction">${i.action}</div>${i.items.length ? `<div class="litems">${i.items.map(t => `<code>${t}</code>`).join(' ')}</div>` : ''}</li>`).join('');
}

// ---------- Loading ----------
async function loadDefault() {
  const [a, s] = await Promise.all([fetch(CONFIG.appFile).then(r => r.text()), fetch(CONFIG.scoresFile).then(r => r.text())]);
  return [a, s];
}

function start(appText, scoresText, label, names = ['sample file', 'sample file']) {
  try {
    const app = parseCSV(appText), scores = parseCSV(scoresText);
    const appProblems = checkFile(app, 'app'), scoreProblems = checkFile(scores, 'scores');
    if (appProblems.length || scoreProblems.length) {
      // Keep the dashboard as it was and explain what is wrong
      setStatus('#status-app', appProblems.length ? `${names[0]} · columns don't match the template` : `${names[0]} · columns OK`, appProblems.length ? 'error' : false);
      setStatus('#status-scores', scoreProblems.length ? `${names[1]} · columns don't match the template` : `${names[1]} · columns OK`, scoreProblems.length ? 'error' : false);
      $('#error').hidden = false;
      $('#error').innerHTML = [...appProblems, ...scoreProblems].map(p => `<div>${p}</div>`).join('') +
        '<div>The dashboard still shows the previous data. Download a template to compare the column names.</div>';
      return;
    }
    STATE.data = clean(app.rows, scores.rows);
    $('#source').textContent = label;
    setStatus('#status-app', `${names[0]} · ${app.rows.length} rows`);
    setStatus('#status-scores', `${names[1]} · ${scores.rows.length} rows`);
    $('#error').hidden = true;
    render();
  } catch (e) {
    $('#error').hidden = false;
    $('#error').textContent = `Could not read the files: ${e.message}. Check they are the app export and the Questionmark scores CSVs.`;
  }
}

// state: true = loaded (green dot), false = waiting, 'error' = red dot
function setStatus(sel, text, state = true) {
  const el = $(sel); el.textContent = text;
  el.classList.toggle('is-loaded', state === true);
  el.classList.toggle('is-error', state === 'error');
}

document.addEventListener('DOMContentLoaded', async () => {
  // Uploaded files wait here until both are chosen
  const files = { app: null, scores: null, appName: '', scoresName: '' };
  document.querySelectorAll('[data-template]').forEach(b => b.onclick = () => downloadTemplate(b.dataset.template));
  const tryUpload = () => {
    if (files.app && files.scores) start(files.app, files.scores, 'your uploaded files', [files.appName, files.scoresName]);
  };
  $('#up-app').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    files.app = await f.text(); files.appName = f.name;
    if (!files.scores) setStatus('#status-app', `${f.name} · now replace the scores file`, false);
    tryUpload();
  };
  $('#up-scores').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    files.scores = await f.text(); files.scoresName = f.name;
    if (!files.app) setStatus('#status-scores', `${f.name} · now replace the app file`, false);
    tryUpload();
  };
  try {
    const [a, s] = await loadDefault();
    start(a, s, 'sample cohort files (synthetic)', ['prep_app_export.csv (sample)', 'questionmark_scores.csv (sample)']);
  } catch (e) {
    $('#error').hidden = false;
    $('#error').textContent = 'Sample files could not be loaded. Upload both CSV files above.';
  }
});
