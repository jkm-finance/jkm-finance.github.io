// Assignment, submission, merge wizard, conflicts, review files, finalize, backup pane (SPEC §6–§8, §11).
import { h, clear, toast, modal, download, dropZone, fmtTime } from './dom.js';
import { t, getLang, itemText } from './i18n.js';
import { getItemSet } from './itemsets.js';
import { isAnswered, assignedTo, contentOf } from './model.js';
import * as wf from './workflow.js';
import * as F from './files.js';
import { previewSubmissions, applySubmissions, applyReview, applyAssignment } from './merge.js';
import { run, withRestorePoint, flush, chooseBackupDir, reconnectBackup, fullBackupFile, restoreSnapshot, goStart, ctl as CTL } from './main.js';
import { renderWorkspace } from './ui-work.js';
import { exportWorkspaceExcel } from './excel.js';

const pane = (...kids) => h('div', { class: 'pane' }, ...kids);
const card = (title, ...kids) => h('div', { class: 'card' }, h('div', { class: 'ctitle', text: title }), h('div', { class: 'cbodyp' }, ...kids));

// ---- assignment (reviewer) ---------------------------------------------------------

export function renderAssign(ctl) {
  const doc = ctl.state.doc, set = getItemSet(doc.itemSetId);
  const inputs = {};
  const rows = set.sections.map((sec) => {
    const n = set.items.filter((i) => i.section === sec).length;
    const inp = h('input', { type: 'text', value: assignedTo(doc, sec).join(', '), placeholder: t('assign.ph'), disabled: ctl.state.readonly, why: t('err.readonly'), maxlength: '300' });
    inputs[sec] = inp;
    return h('tr', null, h('td', { text: sec }), h('td', { class: 'num', text: n }), h('td', null, inp));
  });
  const save = async () => {
    const sections = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.split(',').map((x) => x.trim()).filter(Boolean)]));
    await run((d) => wf.setAssignment(d, sections), { render: true });
    toast(t('assign.saved'));
  };
  const exportFile = async (who) => {
    await flush();
    const d = ctl.state.doc;
    const f = await F.buildFile('assignment', d, F.assignmentPayload(d));
    download(JSON.stringify(f), F.fileName('assignment', d, who));
  };
  return pane(
    card(t('assign.title'),
      h('p', { class: 'wsmeta', text: t('assign.help') }),
      h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', { text: t('col.section') }), h('th', { class: 'num', text: t('col.items') }), h('th', { text: t('col.assignee') }))), h('tbody', null, rows)),
      h('div', { class: 'acts' }, h('button', { class: 'btn btn-p', disabled: ctl.state.readonly, why: t('err.readonly'), text: t('assign.save'), onclick: save }))),
    card(t('assign.fileTitle'),
      h('p', { class: 'wsmeta', text: t('assign.fileHelp', { v: doc.assignment.version }) }),
      h('div', { class: 'acts' },
        h('button', { class: 'btn btn-g', disabled: !doc.assignment.version, why: t('why.noAssignment'), text: t('assign.exportAll'), onclick: () => exportFile('') }),
        doc.assignment.members.map((m) => h('button', { class: 'btn btn-l', text: t('assign.exportFor', { name: m }), onclick: () => exportFile(m) })))));
}

// ---- files tab ------------------------------------------------------------------------

export function renderFiles(ctl) {
  return ctl.state.doc.local.role === 'reviewer' ? reviewerFiles(ctl) : preparerFiles(ctl);
}

function fileStatusList(results) {
  return h('div', null, results.map((r) => h('p', { class: r.ok ? 'fok' : 'ferr', text: `${r.ok ? '✓' : '✕'} ${r.name}${r.ok ? '' : ' — ' + t('ferr.' + r.code) + (r.detail ? ` (${r.detail})` : '')}` })));
}

async function verifyAll(texts, mode, doc) {
  const ok = [], results = [];
  for (const f of texts) {
    try {
      const v = await F.readAndVerify(f.text, { mode, doc });
      ok.push(v); results.push({ name: f.name, ok: true, file: v });
    } catch (e) { results.push({ name: f.name, ok: false, code: e.code || 'corrupt', detail: typeof e.detail === 'string' ? e.detail : null }); }
  }
  return { ok, results };
}

function reviewerFiles(ctl) {
  const doc = ctl.state.doc;
  const status = h('div');
  const onFiles = async (texts) => {
    clear(status);
    const { ok, results } = await verifyAll(texts, 'reviewer', ctl.state.doc);
    status.appendChild(fileStatusList(results));
    const subs = ok.filter((f) => f.kind === 'submission');
    const backups = ok.filter((f) => f.kind === 'backup');
    if (subs.length) await mergeWizard(ctl, subs);
    for (const b of backups) await importBackupSameWs(ctl, b);
  };
  const exportReview = async () => {
    await flush();
    const d = ctl.state.doc;
    download(JSON.stringify(await F.buildFile('review', d, F.reviewPayload(d))), F.fileName('review', d));
  };
  const blockers = wf.finalizeBlockers(doc);
  return pane(
    card(t('files.mergeTitle'), h('p', { class: 'wsmeta', text: t('files.mergeHelp') }), ctl.state.readonly ? h('p', { text: t('hdr.readonly') }) : dropZone(t('files.drop'), onFiles), status),
    card(t('files.reviewTitle'), h('p', { class: 'wsmeta', text: t('files.reviewHelp') }), h('div', { class: 'acts' }, h('button', { class: 'btn btn-g', text: t('files.exportReview'), onclick: exportReview }))),
    card(t('final.title'),
      doc.finalize.current ? h('p', { class: 'fok', text: t('final.current', { v: doc.finalize.current.version, at: fmtTime(doc.finalize.current.at), by: doc.finalize.current.by }) }) : h('p', { text: t('final.notYet') }),
      blockers.length ? h('details', null, h('summary', { text: t('final.blockers', { n: blockers.length }) }), h('ul', null, blockers.slice(0, 60).map((b) => { const m = getItemSet(doc.itemSetId).byId[b.id]; return h('li', { text: `#${m.no} ${m.section} — ${b.reason === 'noResult' ? t('final.noResult') : t('status.' + b.reason)}` }); }))) : null,
      h('div', { class: 'acts' },
        h('button', { class: 'btn btn-p', disabled: !!blockers.length || ctl.state.readonly, why: ctl.state.readonly ? t('err.readonly') : t('why.finalizeBlocked'), text: t('final.finalize'), onclick: () => finalizeFlow(ctl) }),
        doc.finalize.current ? h('button', { class: 'btn btn-g', text: t('final.download'), onclick: () => downloadFinal(ctl) }) : null)),
    card(t('files.excelTitle'), h('div', { class: 'acts' }, h('button', { class: 'btn btn-l', text: t('files.excel'), onclick: () => exportWorkspaceExcel(ctl.state.doc) }))));
}

async function finalizeFlow(ctl) {
  const yes = await modal({ title: t('final.finalize'), body: h('p', { text: t('final.confirm') }), buttons: [{ label: t('btn.cancel'), value: false }, { label: t('final.finalize'), cls: 'btn-p', value: true }] });
  if (!yes) return;
  const r = await withRestorePoint('before-finalize', (d) => wf.finalize(d));
  if (r) await downloadFinal(ctl);
}

async function downloadFinal(ctl) {
  await flush();
  const d = ctl.state.doc;
  const f = await F.buildFile('final', d, await F.finalPayload(d));
  download(JSON.stringify(f), F.fileName('final', d, d.finalize.current.version));
}

// ---- merge wizard + conflict resolution --------------------------------------------------

async function mergeWizard(ctl, files) {
  await flush();
  const doc = ctl.state.doc, set = getItemSet(doc.itemSetId);
  const plan = previewSubmissions(doc, files);
  const choices = { resolutions: {}, includeOutside: {} };
  const outsideIds = Object.values(plan.decisions).filter((d) => d.outside.length && d.type !== 'rejected').map((d) => d.id);

  const preview = h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, [t('merge.submitter'), t('col.section'), t('merge.created'), t('merge.new'), t('merge.changed'), t('merge.same'), t('merge.conflict'), t('merge.rejected'), t('merge.outside')].map((x) => h('th', { text: x })))),
    h('tbody', null, plan.fileStats.map((s) => h('tr', null,
      h('td', { text: s.submitter + (s.staleAssignment ? ' ⚠' : '') }), h('td', { text: s.sections.join(', ') }), h('td', { text: fmtTime(s.createdAt) }),
      h('td', { class: 'num', text: s.new }), h('td', { class: 'num', text: s.changed }), h('td', { class: 'num', text: s.same }),
      h('td', { class: 'num', text: s.conflict }), h('td', { class: 'num', text: s.rejected }), h('td', { class: 'num', text: s.outside })))));
  const stale = plan.fileStats.some((s) => s.staleAssignment);

  const outsideBox = outsideIds.length ? h('div', null, h('div', { class: 'fl', text: t('merge.outsideTitle') }), h('p', { class: 'wsmeta', text: t('merge.outsideHelp') }),
    outsideIds.map((id) => h('label', { style: { display: 'block' } }, h('input', { type: 'checkbox', onchange: (e) => { choices.includeOutside[id] = e.target.checked; } }), ` #${set.byId[id].no} ${set.byId[id].section} — ${plan.decisions[id].candidates.filter((c) => c.source !== 'master').map((c) => c.submitter).join(', ')}`))) : null;

  const ok = await modal({ title: t('merge.title'), wide: true,
    body: h('div', null, preview, stale ? h('p', { class: 'ferr', text: t('merge.stale') }) : null, outsideBox,
      plan.conflicts.length ? h('p', { class: 'ferr', text: t('merge.hasConflicts', { n: plan.conflicts.length }) }) : h('p', { class: 'fok', text: t('merge.noConflicts') })),
    buttons: [{ label: t('btn.cancel'), value: false }, { label: plan.conflicts.length ? t('merge.next') : t('merge.apply'), cls: 'btn-p', value: true }] });
  if (!ok) return;
  if (plan.conflicts.length) {
    const resolved = await conflictDialog(ctl, set, plan, choices);
    if (!resolved) return;
  }
  const r = await withRestorePoint('before-merge', (d) => applySubmissions(d, files, plan, choices));
  if (r) toast(t('merge.done', r.summary), 5000);
}

function diffClass(a, b, key) { return JSON.stringify(a[key]) !== JSON.stringify(b[key]) ? 'diff' : ''; }

function contentView(c, base) {
  const line = (key, label, val) => h('div', { class: diffClass(c, base, key) }, h('b', { text: label + ': ' }), h('span', { class: 'pre', text: val || '—' }));
  const r = c.remediation || {};
  return h('div', null,
    line('result', t('detail.result'), { yes: 'Yes', no: 'No', na: 'N/A', hold: 'Hold' }[c.result] || ''),
    line('process', t('detail.process'), c.process), line('response', t('detail.response'), c.response), line('evidence', t('detail.evidence'), c.evidence), line('sample', t('detail.sample'), c.sample),
    line('remediation', t('detail.remediation'), [r.action, r.owner, r.due].filter(Boolean).join(' / ')));
}

async function conflictDialog(ctl, set, plan, choices) {
  const body = h('div');
  const counter = h('p', { class: 'wsmeta' });
  let applyBtn;
  const update = () => {
    const left = plan.conflicts.filter((id) => choices.resolutions[id] === undefined).length;
    counter.textContent = t('merge.left', { n: left });
    if (applyBtn) applyBtn.disabled = left > 0;
  };
  body.appendChild(h('div', { class: 'acts noprint' }, h('button', { class: 'btn btn-l', text: t('merge.keepAllMaster'), onclick: () => { for (const id of plan.conflicts) choices.resolutions[id] = 'master'; body.querySelectorAll('.cmpcol').forEach((el) => el.classList.toggle('sel', el.dataset.src === 'master')); update(); } }), counter));
  for (const id of plan.conflicts) {
    const d = plan.decisions[id], m = set.byId[id];
    const master = d.candidates[0];
    const grid = h('div', { class: 'cmp' }); grid.style.gridTemplateColumns = `repeat(${d.candidates.length}, 1fr)`;
    for (const c of d.candidates) {
      const src = String(c.source);
      const col = h('div', { class: 'cmpcol', 'data-src': src, tabindex: '0', role: 'button', onclick: () => {
        choices.resolutions[id] = c.source;
        grid.querySelectorAll('.cmpcol').forEach((el) => el.classList.toggle('sel', el === col));
        update();
      } }, h('div', { class: 'fl', text: c.source === 'master' ? t('merge.master') + ` (${t('status.' + c.status)})` : `${c.submitter} · ${fmtTime(c.submittedAt)}` }), contentView(c.content, master.content));
      grid.appendChild(col);
    }
    body.appendChild(h('div', { class: 'card' }, h('div', { class: 'ctitle', text: `#${m.no} ${m.section} — ${itemText(m, getLang()).ws.slice(0, 120)}` }), h('div', { class: 'cbodyp' }, grid)));
  }
  update();
  return modal({ title: t('merge.conflictTitle'), wide: true, body,
    buttons: [{ label: t('btn.cancel'), value: false }, { label: t('merge.apply'), cls: 'btn-p', value: true, disabled: true }],
    onMount: (mm) => { applyBtn = mm.buttons[1]; update(); } });
}

async function importBackupSameWs(ctl, file) {
  const yes = await modal({ title: t('backup.importTitle'), body: h('p', { text: t('start.replaceConfirm', { hotel: ctl.state.doc.hotelName, at: fmtTime(ctl.state.doc.savedAt), file: fmtTime(file.createdAt) }) }), buttons: [{ label: t('btn.cancel'), value: false }, { label: t('btn.replace'), cls: 'btn-n', value: true }] });
  if (!yes) return;
  await flush();
  const s = ctl.state;
  const doc = { ...file.payload.doc, local: s.doc.local };
  try {
    s.doc = await ctl.store.replaceFromBackup(doc, file.payload.history || [], s.doc);
    toast(t('backup.restored'));
  } catch (e) { toast(t('err.' + (e.code || 'generic'))); }
  renderWorkspace(ctl);
}

// ---- preparer: submit and receive -------------------------------------------------------

function preparerFiles(ctl) {
  const doc = ctl.state.doc, set = getItemSet(doc.itemSetId);
  const mine = set.sections.filter((s) => assignedTo(doc, s).includes(doc.local.me));
  const checks = {};
  const secRows = set.sections.map((sec) => {
    const items = set.items.filter((i) => i.section === sec);
    const ready = items.filter((i) => isAnswered(doc.items[i.id]) && ['draft', 'submitted', 'returned'].includes(doc.items[i.id].status)).length;
    const cb = h('input', { type: 'checkbox', checked: mine.includes(sec) && ready > 0, disabled: !ready, why: t('why.nothingReady') });
    checks[sec] = cb;
    return h('tr', null, h('td', null, cb), h('td', { text: sec + (mine.includes(sec) ? ' ●' : '') }), h('td', { class: 'num', text: items.length }), h('td', { class: 'num', text: ready }));
  });
  const status = h('div');
  const onFiles = async (texts) => {
    clear(status);
    const { ok, results } = await verifyAll(texts, 'preparer', ctl.state.doc);
    status.appendChild(fileStatusList(results));
    for (const f of ok) {
      if (f.kind === 'review') {
        const r = await withRestorePoint('before-review-import', (d) => applyReview(d, f));
        if (r) toast(t('files.reviewApplied', { r: r.counts.returned.length, k: r.counts.keptLocal }), 6000);
      } else if (f.kind === 'assignment') {
        const r = await withRestorePoint('before-import', (d) => applyAssignment(d, f));
        if (r) toast(t('start.assignmentUpdated'));
      } else if (f.kind === 'backup') await importBackupSameWs(ctl, f);
    }
  };
  return pane(
    card(t('submit.title'), h('p', { class: 'wsmeta', text: t('submit.help') }),
      h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', { text: '' }), h('th', { text: t('col.section') }), h('th', { class: 'num', text: t('col.items') }), h('th', { class: 'num', text: t('submit.ready') }))), h('tbody', null, secRows)),
      h('div', { class: 'acts' }, h('button', { class: 'btn btn-g', disabled: ctl.state.readonly, why: t('err.readonly'), text: t('submit.export'), onclick: () => submitFlow(ctl, Object.entries(checks).filter(([, c]) => c.checked).map(([k]) => k)) }))),
    card(t('files.receiveTitle'), h('p', { class: 'wsmeta', text: t('files.receiveHelp') }), ctl.state.readonly ? null : dropZone(t('files.drop'), onFiles), status),
    card(t('files.excelTitle'), h('div', { class: 'acts' }, h('button', { class: 'btn btn-l', text: t('files.excelMine'), onclick: () => exportWorkspaceExcel(ctl.state.doc, { onlyMine: true }) }))));
}

async function submitFlow(ctl, sections) {
  if (!sections.length) return toast(t('submit.none'));
  await flush();
  const doc = ctl.state.doc;
  const warnings = [];
  const { unanswered, noPlan, outside } = F.submissionCheck(doc, sections);
  if (unanswered.length) warnings.push(t('submit.wUnanswered', { n: unanswered.length }));
  if (noPlan.length) warnings.push(t('submit.wNoPlan', { list: noPlan.map((i) => '#' + i.no).join(', ') }));
  if (outside.length) warnings.push(t('submit.wOutside', { list: outside.join(', ') }));
  const payload = F.submissionPayload(doc, sections);
  const n = Object.keys(payload.items).length;
  if (!n) return toast(t('submit.nothing'));
  const ok = await modal({ title: t('submit.title'), body: h('div', null, h('p', { text: t('submit.confirm', { n, secs: sections.join(', ') }) }), warnings.length ? h('ul', null, warnings.map((w) => h('li', { class: 'ferr', text: w }))) : null),
    buttons: [{ label: t('btn.cancel'), value: false }, { label: t('submit.export'), cls: 'btn-g', value: true }] });
  if (!ok) return;
  const file = await F.buildFile('submission', doc, payload);
  download(JSON.stringify(file), F.fileName('submission', doc, `${sections.join('-')}_${doc.local.me}`));
  await run((d) => wf.markSubmitted(d, Object.keys(payload.items)), { render: true });
  toast(t('submit.done'), 5000);
}

// ---- backup pane ---------------------------------------------------------------------------

export function renderBackupPane(ctl) {
  const s = ctl.state, doc = s.doc, b = s.backup;
  const snapsBox = h('div', { text: t('detail.loading') });
  ctl.store.listSnaps(doc.wsId).then((list) => {
    clear(snapsBox);
    list.sort((a, c) => (a.at < c.at ? 1 : -1));
    if (!list.length) snapsBox.appendChild(h('p', { text: '—' }));
    snapsBox.appendChild(h('table', { class: 'tbl' }, h('thead', null, h('tr', null, [t('backup.when'), t('backup.reason'), 'Seq', ''].map((x) => h('th', { text: x })))),
      h('tbody', null, list.slice(0, 120).map((sn) => h('tr', null, h('td', { text: fmtTime(sn.at) }), h('td', { text: t('reason.' + sn.reason) }), h('td', { text: sn.saveSeq }),
        h('td', null, h('button', { class: 'btn btn-l', disabled: s.readonly, why: t('err.readonly'), text: t('backup.restore'), onclick: async () => {
          const yes = await modal({ title: t('backup.restore'), body: h('p', { text: t('backup.restoreConfirm', { at: fmtTime(sn.at) }) }), buttons: [{ label: t('btn.cancel'), value: false }, { label: t('backup.restore'), cls: 'btn-n', value: true }] });
          if (yes) restoreSnapshot(sn.id);
        } })))))));
  });
  const exportFull = async () => { await flush(); const f = await fullBackupFile(); download(JSON.stringify(f), F.fileName('backup', ctl.state.doc)); s.lastFullExport = Date.now(); };
  return pane(
    card(t('backup.folderTitle'),
      h('p', { text: b.status === 'ok' ? t('backup.folderOk', { name: b.dir ? b.dir.name : '', at: b.lastAt ? fmtTime(b.lastAt) : '—' }) : t('backup.' + b.status) }),
      h('p', { class: 'wsmeta', text: t('backup.folderHelp') }),
      h('div', { class: 'acts' },
        h('button', { class: 'btn btn-p', disabled: s.readonly || b.status === 'unsupported', why: s.readonly ? t('err.readonly') : t('why.fsUnsupported'), text: t('backup.choose'), onclick: () => chooseBackupDir() }),
        b.status === 'needPermission' ? h('button', { class: 'btn btn-g', text: t('backup.reconnect'), onclick: () => reconnectBackup() }) : null)),
    card(t('backup.fullTitle'), h('p', { class: 'wsmeta', text: t('backup.fullHelp') }), h('div', { class: 'acts' }, h('button', { class: 'btn btn-g', text: t('backup.exportFull'), onclick: exportFull }))),
    card(t('backup.snapsTitle'), h('p', { class: 'wsmeta', text: t('backup.snapsHelp') }), snapsBox),
    card(t('backup.manageTitle'),
      h('div', { class: 'acts' },
        h('button', { class: 'btn btn-l', disabled: s.readonly, why: t('err.readonly'), text: doc.local.hidden ? t('backup.unhide') : t('backup.hide'), onclick: async () => {
          s.doc = await ctl.store.touch(s.doc, { hidden: !doc.local.hidden }); toast(t('backup.hiddenChanged')); renderWorkspace(ctl);
        } }),
        h('button', { class: 'btn btn-n', disabled: s.readonly, why: t('err.readonly'), text: t('backup.delete'), onclick: () => deleteFlow(ctl) }))));
}

async function deleteFlow(ctl) {
  const s = ctl.state, doc = s.doc;
  let downloaded = false;
  const nameIn = h('input', { type: 'text', placeholder: doc.hotelName });
  const dl = h('button', { class: 'btn btn-g', text: t('backup.exportFull'), onclick: async () => { await flush(); const f = await fullBackupFile(); download(JSON.stringify(f), F.fileName('backup', doc)); downloaded = true; dl.textContent = '✓ ' + t('backup.exportFull'); } });
  const ok = await modal({ title: t('backup.delete'),
    body: h('div', null, h('p', { class: 'ferr', text: t('backup.deleteWarn') }), h('p', { text: t('backup.deleteStep1') }), dl, h('p', { text: t('backup.deleteStep2', { hotel: doc.hotelName }) }), nameIn),
    buttons: [{ label: t('btn.cancel'), value: false }, { label: t('backup.delete'), cls: 'btn-n', value: true, validate: () => {
      if (!downloaded) { toast(t('backup.needDownload')); return false; }
      if (nameIn.value.trim() !== doc.hotelName) { toast(t('backup.nameMismatch')); return false; }
      return true;
    } }] });
  if (!ok) return;
  await flush();
  // The downloaded full backup is the safety net: restore points are deleted with the workspace.
  const wsId = doc.wsId;
  if (s.lock) s.lock.release();
  s.lock = null; s.readonly = true; s.doc = null;
  sessionStorage.removeItem('jkmcsa.current');
  await ctl.store.deleteWorkspace(wsId);
  toast(t('backup.deleted'));
  goStart();
}

export { CTL };
