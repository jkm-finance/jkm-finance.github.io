// Workspace screen: header, banners, progress, tabs, item list + detail, overview (SPEC §5).
import { h, clear, toast, modal, fmtTime, pct } from './dom.js';
import { t, getLang, setLang, itemText } from './i18n.js';
import { getItemSet } from './itemsets.js';
import { summarize, perAssignee } from './summary.js';
import { MAX_TEXT, MAX_SHORT, isAnswered, assignedTo } from './model.js';
import * as wf from './workflow.js';
import { apply, run, goStart, confirmShrink, takeOverEditing, exportEmergency, chooseBackupDir, reconnectBackup, withRestorePoint, flush } from './main.js';
import { renderAssign, renderFiles, renderBackupPane } from './ui-flow.js';
import { renderReportPane } from './ui-report.js';

const RESULT_DOT = { yes: ['dy', 'Y'], no: ['dn', 'N'], na: ['dna', '–'], hold: ['dhold', 'H'] };

export function renderWorkspace(ctl) {
  const s = ctl.state;
  const doc = s.doc;
  if (!doc) return;
  const set = getItemSet(doc.itemSetId);
  const root = clear(document.getElementById('root'));
  const app = h('div', { id: 'app' });
  root.appendChild(app);
  app.appendChild(header(ctl));
  app.appendChild(h('div', { id: 'banners' }));
  app.appendChild(h('div', { id: 'prg' }));
  app.appendChild(h('nav', { id: 'nav', 'aria-label': 'sections' }, h('div', { id: 'tabs' })));
  const body = h('div', { id: 'ct' });
  app.appendChild(body);

  if (s.shrink) { body.appendChild(shrinkPane(ctl)); refreshChrome(ctl); return; }
  const v = s.view;
  if (v === 'overview') body.appendChild(overviewPane(ctl, set));
  else if (v === 'assign') body.appendChild(renderAssign(ctl));
  else if (v === 'files') body.appendChild(renderFiles(ctl));
  else if (v === 'report') body.appendChild(renderReportPane(ctl));
  else if (v === 'backup') body.appendChild(renderBackupPane(ctl));
  else listAndDetail(ctl, set, body);
  refreshChrome(ctl);
}

function setView(ctl, view, section = null) {
  Object.assign(ctl.state, { view, section, itemId: null });
  renderWorkspace(ctl);
  const rp = document.getElementById('rp'); if (rp) rp.scrollTop = 0;
}

// ---- header -------------------------------------------------------------------

function header(ctl) {
  const s = ctl.state, doc = s.doc;
  const band = h('div', { class: 'wsband' }); band.style.background = doc.local.color || 'var(--g)';
  return h('header', { id: 'hdr' }, band,
    h('div', { class: 'hbrand' }, h('span', { class: 'csa-badge', text: 'CSA' }), h('span', { class: 'htitle', text: t('app.short') })),
    h('div', { class: 'hws' },
      h('span', { class: 'hhotel', text: doc.hotelName }),
      h('span', { class: 'hchip', text: doc.serviceType === 'full' ? 'Full' : 'Focus' }),
      h('span', { class: 'hchip', text: String(doc.year) }),
      h('span', { class: 'role-badge', text: t('role.' + doc.local.role) + (s.readonly ? ' · ' + t('hdr.readonly') : '') }),
      h('span', { class: 'hchip', text: doc.local.me || '—' }),
      doc.finalize.current ? h('span', { class: 'badge st st-approved', text: t('final.badgeV', { v: doc.finalize.current.version }) }) : null),
    h('div', { class: 'hacts' },
      h('span', { class: 'save-ind', id: 'saveInd' }),
      h('span', { class: 'save-ind', id: 'backupInd' }),
      ['ko', 'en', 'ja'].map((l) => h('button', { class: 'btn btn-o' + (getLang() === l ? ' act' : ''), text: l.toUpperCase(), onclick: () => { setLang(l); document.documentElement.lang = l; renderWorkspace(ctl); } })),
      h('button', { class: 'btn btn-o', text: '🏨 ' + t('hdr.switch'), onclick: () => goStart() })));
}

// ---- chrome refresh (no re-render of inputs) ------------------------------------

export function refreshChrome(ctl) {
  const s = ctl.state, doc = s.doc;
  if (!doc || !document.getElementById('app')) return;
  const set = getItemSet(doc.itemSetId);
  const sum = summarize(doc.items, doc.itemSetId);
  const st = sum.byStatus;

  const si = document.getElementById('saveInd');
  if (si) {
    si.className = 'save-ind' + (s.saving === 'error' || s.fatal ? ' bad' : '');
    si.textContent = s.readonly ? t('hdr.readonly') : s.saving === 'saving' ? t('save.saving') : s.saving === 'error' ? '⚠ ' + t('save.failed') : s.lastSavedAt || doc.savedAt ? t('save.saved', { time: fmtTime(s.lastSavedAt || doc.savedAt).slice(11) }) : '';
  }
  const bi = document.getElementById('backupInd');
  if (bi) {
    const b = s.backup;
    bi.className = 'save-ind' + (b.status !== 'ok' && !s.readonly ? ' bad' : '');
    bi.textContent = s.readonly ? '' : b.status === 'ok' ? t('backup.ok', { time: b.lastAt ? fmtTime(b.lastAt).slice(11) : '—' }) : '⚠ ' + t('backup.' + b.status);
  }

  const ban = document.getElementById('banners');
  if (ban) {
    clear(ban);
    if (s.fatal) ban.appendChild(h('div', { class: 'banner err' }, t('ban.fatal'), h('button', { class: 'btn btn-n', text: t('ban.exportNow'), onclick: () => exportEmergency() })));
    if (s.saving === 'error' && s.saveError !== 'shrink') ban.appendChild(h('div', { class: 'banner err' }, t('ban.saveFailed', { code: t('err.' + s.saveError) }), h('button', { class: 'btn btn-n', text: t('ban.retry'), onclick: () => flush() }), h('button', { class: 'btn btn-l', text: t('ban.exportNow'), onclick: () => exportEmergency() })));
    if (s.readonly) ban.appendChild(h('div', { class: 'banner warn' }, t('ban.readonly'), s.pendingLock ? h('button', { class: 'btn btn-p', text: t('ban.takeOver'), onclick: () => takeOverEditing() }) : null));
    if (!s.readonly && s.backup.status === 'none' && doc.local.role === 'reviewer') ban.appendChild(h('div', { class: 'banner warn' }, t('ban.noBackup'), h('button', { class: 'btn btn-p', text: t('backup.choose'), onclick: () => chooseBackupDir() })));
    if (!s.readonly && s.backup.status === 'needPermission') ban.appendChild(h('div', { class: 'banner warn' }, t('ban.backupPermission'), h('button', { class: 'btn btn-p', text: t('backup.reconnect'), onclick: () => reconnectBackup() })));
    if (!s.readonly && s.backup.status === 'unsupported' && doc.local.role === 'reviewer') ban.appendChild(h('div', { class: 'banner warn', text: t('ban.backupUnsupported') }));
    if (s.newVersion) ban.appendChild(h('div', { class: 'banner info', text: t('ban.newVersion', { v: s.newVersion }) }));
    if (doc.finalize.lastVersion && !doc.finalize.current && doc.local.role === 'reviewer') ban.appendChild(h('div', { class: 'banner info', text: t('ban.unfinalized', { v: doc.finalize.lastVersion }) }));
  }

  const prg = document.getElementById('prg');
  if (prg) {
    clear(prg);
    const fill = h('div', { class: 'prg-fill' }); fill.style.width = Math.round(sum.progress * 100) + '%';
    prg.appendChild(h('div', { class: 'prg-row' }, h('span', { class: 'prg-lbl', text: t('prg.progress', { a: sum.counts.yes + sum.counts.no + sum.counts.na, n: sum.total }) }), h('div', { class: 'prg-track' }, fill), h('span', { class: 'prg-lbl', text: t('prg.score') + ' ' + pct(sum.score) })));
    prg.appendChild(h('div', { class: 'prg-stats' },
      dotStat('var(--yc)', 'Yes', sum.counts.yes), dotStat('var(--nc)', 'No', sum.counts.no), dotStat('var(--ac)', 'N/A', sum.counts.na), dotStat('var(--hc)', 'Hold', sum.counts.hold),
      h('span', { class: 'prg-s', text: '|' }),
      ['draft', 'submitted', 'returned', 'approved', 'entered'].map((k) => dotStat(`var(--st-${k})`, t('status.' + k), st[k]))));
  }

  const tabs = document.getElementById('tabs');
  if (tabs) {
    clear(tabs);
    const role = doc.local.role;
    const mk = (view, label, count, extra = {}) => h('button', { class: 'tab' + (extra.sep ? ' sep' : '') + (s.view === view && (view !== 'section' || s.section === extra.section) ? ' active' : ''), onclick: () => setView(ctl, view, extra.section || null) },
      label, count !== undefined && count !== null ? h('span', { class: 'tn' + (extra.alert && count ? ' alert' : ''), text: String(count) }) : null);
    tabs.appendChild(mk('overview', t('tab.overview')));
    for (const sec of set.sections) {
      const items = set.items.filter((i) => i.section === sec);
      const done = items.filter((i) => doc.items[i.id].result).length;
      const mine = role === 'preparer' && assignedTo(doc, sec).includes(doc.local.me);
      tabs.appendChild(mk('section', (mine ? '● ' : '') + sec, `${done}/${items.length}`, { section: sec }));
    }
    if (role === 'reviewer') tabs.appendChild(mk('queue', t('tab.queue'), st.submitted, { sep: true, alert: true }));
    tabs.appendChild(mk('returned', t('tab.returned'), st.returned, { sep: role !== 'reviewer', alert: true }));
    tabs.appendChild(mk('findings', t('tab.findings'), sum.counts.no));
    tabs.appendChild(mk('hold', t('tab.hold'), sum.counts.hold));
    if (role === 'reviewer') tabs.appendChild(mk('assign', t('tab.assign'), null, { sep: true }));
    tabs.appendChild(mk('files', role === 'reviewer' ? t('tab.filesReviewer') : t('tab.filesPreparer'), null, { sep: role !== 'reviewer' }));
    tabs.appendChild(mk('report', t('tab.report')));
    tabs.appendChild(mk('backup', t('tab.backup')));
  }

  // list dots
  document.querySelectorAll('.li[data-id]').forEach((el) => {
    const it = doc.items[el.dataset.id];
    const dot = el.querySelector('.ldot');
    const [cls, txt] = RESULT_DOT[it.result] || ['dnone', ''];
    dot.className = 'ldot ' + cls; dot.textContent = txt;
    const sb = el.querySelector('.stb');
    if (sb) { sb.className = 'badge st stb st-' + it.status; sb.textContent = t('status.' + it.status); }
  });
}

function dotStat(color, label, n) {
  const d = h('span', { class: 'pdot' }); d.style.background = color;
  return h('span', { class: 'prg-s' }, d, `${label} ${n}`);
}

// ---- shrink confirmation (DP-05) ----------------------------------------------

function shrinkPane(ctl) {
  const d = ctl.state.shrink;
  const set = getItemSet(ctl.state.doc.itemSetId);
  return h('div', { class: 'pane' }, h('div', { class: 'card' }, h('div', { class: 'ctitle', text: '⚠ ' + t('shrink.title') }),
    h('div', { class: 'cbodyp' },
      h('p', { text: t('shrink.body', { a: d.answeredBefore, b: d.answeredAfter, r1: d.resultsBefore, r2: d.resultsAfter }) }),
      h('p', { class: 'wsmeta', text: t('shrink.list') }),
      h('ul', null, d.lost.slice(0, 40).map((id) => h('li', { text: `#${set.byId[id].no} ${set.byId[id].section} — ${set.byId[id].ws.slice(0, 90)}` }))),
      d.lost.length > 40 ? h('p', { text: `… +${d.lost.length - 40}` }) : null,
      h('div', { class: 'acts' },
        h('button', { class: 'btn btn-p', text: t('shrink.keep'), onclick: () => confirmShrink(true) }),
        h('button', { class: 'btn btn-n', text: t('shrink.save'), onclick: () => confirmShrink(false) })))));
}

// ---- overview ------------------------------------------------------------------

function overviewPane(ctl, set) {
  const doc = ctl.state.doc;
  const sum = summarize(doc.items, doc.itemSetId);
  const k = (val, lbl, sub) => h('div', { class: 'kcard' }, h('div', { class: 'kval', text: val }), h('div', { class: 'klbl', text: lbl }), sub ? h('div', { class: 'ksub', text: sub }) : null);
  const pane = h('div', { class: 'pane' });
  pane.appendChild(h('div', { class: 'krow' },
    k(pct(sum.score), t('ov.score'), `Yes ${sum.counts.yes} / No ${sum.counts.no}`),
    k(pct(sum.byRisk.Key.score), 'Key'), k(pct(sum.byRisk.HR.score), 'HR'), k(pct(sum.byRisk.MR.score), 'MR'),
    k(Math.round(sum.progress * 100) + '%', t('ov.progress'), `${sum.answered}/${sum.total}`),
    k(Math.round(sum.reviewProgress * 100) + '%', t('ov.review'), `${sum.byStatus.approved + sum.byStatus.entered}/${sum.total}`),
    k(Math.round(sum.enteredRate * 100) + '%', t('ov.entered'))));

  const rows = set.sections.map((sec) => {
    const c = sum.bySection[sec];
    const bar = h('div', { class: 'sbar' }, ['y', 'n', 'na', 'h'].map((cls, i) => { const n = [c.yes, c.no, c.na, c.hold][i]; const e = h('i', { class: cls }); e.style.width = (c.total ? (n / c.total) * 100 : 0) + '%'; return e; }));
    return h('tr', { onclick: () => setView(ctl, 'section', sec), style: { cursor: 'pointer' } },
      h('td', { text: sec }), h('td', { class: 'num', text: c.total }), h('td', null, bar),
      h('td', { class: 'num', text: c.yes }), h('td', { class: 'num', text: c.no }), h('td', { class: 'num', text: c.na }), h('td', { class: 'num', text: c.hold }),
      h('td', { class: 'num', text: pct(c.score) }), h('td', { text: assignedTo(doc, sec).join(', ') || '—' }));
  });
  pane.appendChild(h('div', { class: 'card' }, h('div', { class: 'ctitle', text: t('ov.bySection') }), h('div', { class: 'cbodyp' },
    h('table', { class: 'tbl' }, h('thead', null, h('tr', null, [t('col.section'), t('col.items'), t('col.progress'), 'Yes', 'No', 'N/A', 'Hold', t('col.score'), t('col.assignee')].map((x, i) => h('th', { class: i && i < 8 && i !== 2 ? 'num' : '', text: x })))), h('tbody', null, rows)))));

  const pa = perAssignee(doc);
  if (Object.keys(pa).length) {
    pane.appendChild(h('div', { class: 'card' }, h('div', { class: 'ctitle', text: t('ov.byAssignee') }), h('div', { class: 'cbodyp' },
      h('table', { class: 'tbl' }, h('thead', null, h('tr', null, [t('col.assignee'), t('col.items'), t('col.answered'), t('col.submitted'), t('col.returned')].map((x, i) => h('th', { class: i ? 'num' : '', text: x })))),
        h('tbody', null, Object.entries(pa).map(([n, v]) => h('tr', null, h('td', { text: n }), h('td', { class: 'num', text: v.total }), h('td', { class: 'num', text: v.done }), h('td', { class: 'num', text: v.submitted }), h('td', { class: 'num', text: v.returned }))))))));
  }
  const st = sum.byStatus;
  pane.appendChild(h('div', { class: 'card' }, h('div', { class: 'ctitle', text: t('ov.byStatus') }), h('div', { class: 'cbodyp' },
    h('div', { class: 'krow' }, Object.keys(st).map((k2) => k(String(st[k2]), t('status.' + k2)))))));
  return pane;
}

// ---- list + detail ----------------------------------------------------------------

function viewFilter(ctl, meta, it) {
  const v = ctl.state.view;
  if (v === 'section') return meta.section === ctl.state.section;
  if (v === 'queue') return it.status === 'submitted';
  if (v === 'returned') return it.status === 'returned' || it.masterStatus === 'returned';
  if (v === 'findings') return it.result === 'no';
  if (v === 'hold') return it.result === 'hold';
  return true;
}

function userFilter(ctl, meta, it) {
  const f = ctl.state.filters, doc = ctl.state.doc;
  if (f.risk && meta.risk !== f.risk) return false;
  if (f.status && it.status !== f.status) return false;
  if (f.tower && meta.tower !== f.tower) return false;
  if (f.cpa && meta.cpaLink !== f.cpa) return false;
  if (f.unanswered && it.result) return false;
  if (f.assignee && !assignedTo(doc, meta.section).includes(f.assignee)) return false;
  return true;
}

function filterBar(ctl, set, rerender) {
  const f = ctl.state.filters, doc = ctl.state.doc;
  const sel = (key, label, opts) => h('select', { 'aria-label': label, onchange: (e) => { f[key] = e.target.value || undefined; rerender(); } },
    h('option', { value: '', text: label }), opts.map(([v, l]) => h('option', { value: v, text: l, selected: f[key] === v })));
  const bar = h('div', { class: 'flt' },
    sel('risk', t('flt.risk'), [['Key', 'Key'], ['HR', 'HR'], ['MR', 'MR']]),
    sel('status', t('flt.status'), ['empty', 'draft', 'submitted', 'returned', 'approved', 'entered'].map((x) => [x, t('status.' + x)])),
    doc.assignment.members.length ? sel('assignee', t('flt.assignee'), doc.assignment.members.map((m) => [m, m])) : null,
    doc.serviceType === 'focus' ? sel('tower', 'HTL/FSSC', ['HTL', 'FSSC-RTR', 'FSSC-OTC', 'FSSC-RA', 'FSSC-PTP'].map((x) => [x, x])) : null,
    doc.serviceType === 'focus' ? sel('cpa', t('flt.cpa'), ['CSA', 'CSA,CPA', 'CSA,CPA,Validation'].map((x) => [x, x])) : null,
    h('label', { class: 'wsmeta' }, h('input', { type: 'checkbox', checked: !!f.unanswered, onchange: (e) => { f.unanswered = e.target.checked || undefined; rerender(); } }), ' ' + t('flt.unanswered')));
  return bar;
}

function listAndDetail(ctl, set, body) {
  const s = ctl.state, doc = s.doc;
  const lp = h('aside', { id: 'lp' });
  const rp = h('main', { id: 'rp' });
  body.appendChild(lp); body.appendChild(rp);
  const draw = () => {
    clear(lp);
    lp.appendChild(filterBar(ctl, set, draw));
    const metas = set.items.filter((m) => viewFilter(ctl, m, doc.items[m.id]) && userFilter(ctl, m, doc.items[m.id]));
    if (s.view === 'queue' && metas.length) {
      lp.appendChild(h('div', { class: 'flt' }, h('button', { class: 'btn btn-y', text: t('queue.approveAll', { n: metas.filter((m) => doc.items[m.id].result).length }), onclick: () => bulkApprove(ctl, metas.map((m) => m.id)) })));
    }
    if (!metas.length) lp.appendChild(h('div', { class: 'empty', text: t('list.empty') }));
    for (const m of metas) lp.appendChild(listRow(ctl, set, m, () => { s.itemId = m.id; draw(); drawDetail(); }));
    if (!s.itemId || !metas.find((m) => m.id === s.itemId)) { s.itemId = metas[0] ? metas[0].id : null; }
    lp.querySelectorAll('.li').forEach((el) => el.classList.toggle('act', el.dataset.id === s.itemId));
  };
  const drawDetail = () => { clear(rp); rp.appendChild(s.itemId ? detail(ctl, set, s.itemId, () => { draw(); drawDetail(); }) : h('div', { class: 'empty', text: t('list.pick') })); };
  draw(); drawDetail();
}

function listRow(ctl, set, m, onclick) {
  const doc = ctl.state.doc, it = doc.items[m.id];
  const [cls, txt] = RESULT_DOT[it.result] || ['dnone', ''];
  const muted = doc.local.role === 'preparer' && !assignedTo(doc, m.section).includes(doc.local.me);
  return h('div', { class: 'li' + (muted ? ' muted' : ''), 'data-id': m.id, tabindex: '0', onclick, onkeydown: (e) => { if (e.key === 'Enter') onclick(); } },
    h('div', { class: 'ldot ' + cls, text: txt, 'aria-hidden': 'true' }),
    h('div', { class: 'lmain' },
      h('div', { class: 'lno', text: `#${m.no} · ${m.section}` }),
      h('div', { class: 'ltx', text: itemText(m, getLang()).ws }),
      h('div', { class: 'lbadges' },
        h('span', { class: 'badge rk-' + m.risk, text: m.risk }),
        h('span', { class: 'badge st stb st-' + it.status, text: t('status.' + it.status) }),
        m.tower ? h('span', { class: 'badge tw' + (m.tower === 'HTL' ? ' tw-HTL' : ''), text: m.tower }) : null,
        (doc.comments[m.id] || []).length ? h('span', { class: 'badge tw', text: '💬 ' + doc.comments[m.id].length }) : null)));
}

async function bulkApprove(ctl, ids) {
  const doc = ctl.state.doc;
  const ok = ids.filter((id) => wf.can('approve', wf.itemCtx(doc, id)).ok);
  if (!ok.length) return toast(t('queue.none'));
  const yes = await modal({ title: t('queue.approveTitle'), body: h('p', { text: t('queue.approveConfirm', { n: ok.length }) }), buttons: [{ label: t('btn.cancel'), value: false }, { label: t('btn.approve'), cls: 'btn-y', value: true }] });
  if (yes) await run((d) => wf.approve(d, ok), { render: true });
}

function detail(ctl, set, id, redraw) {
  const s = ctl.state, doc = s.doc, it = doc.items[id], meta = set.byId[id];
  const lang = getLang();
  const tr = itemText(meta, lang);
  const editCheck = wf.can('edit', wf.itemCtx(doc, id));
  const editable = !s.readonly && !s.fatal && editCheck.ok;
  const why = editable ? null : t('err.' + (s.readonly || s.fatal ? 'readonly' : editCheck.reason));
  // Edits never throw out of an event handler (that would trip the fatal-error trap).
  const ed = (patch) => { try { apply(wf.editItem(ctl.state.doc, id, patch)); } catch (e) { toast(t('err.' + (e.code || 'generic'))); } };
  const card = h('article', { class: 'card' });
  card.appendChild(h('div', { class: 'chdr' },
    h('span', { class: 'cnum', text: '#' + meta.no }), h('span', { class: 'csec', text: meta.section }),
    h('span', { class: 'badge rk-' + meta.risk, text: meta.risk }),
    meta.tower ? h('span', { class: 'badge tw' + (meta.tower === 'HTL' ? ' tw-HTL' : ''), text: meta.tower }) : null,
    meta.cpaLink ? h('span', { class: 'badge cpa', text: meta.cpaLink.replace(/,/g, ' · ') }) : null,
    h('span', { class: 'badge st st-' + it.status, text: t('status.' + it.status) }),
    h('span', { class: 'hchip', text: t('col.assignee') + ': ' + (assignedTo(doc, meta.section).join(', ') || '—') })));
  const b = h('div', { class: 'cbody' });
  card.appendChild(b);

  if (it.status === 'entered') b.appendChild(h('div', { class: 'lockbar', text: '🔒 ' + t('detail.locked', { by: it.enteredBy || '', at: fmtTime(it.enteredAt) }) }));
  if (it.differsFromMaster) b.appendChild(h('div', { class: 'diffbar', text: t('detail.differs', { st: t('status.' + (it.masterStatus || 'draft')) }) }));
  else if (it.masterStatus === 'returned' && it.status !== 'returned') b.appendChild(h('div', { class: 'diffbar', text: t('detail.wasReturned') }));

  b.appendChild(h('div', { class: 'fl', text: t('detail.workStep') }));
  b.appendChild(h('div', { class: 'tbox', text: tr.ws }));
  if (tr.translated) b.appendChild(h('details', null, h('summary', { text: t('detail.original') }), h('div', { class: 'tbox en', text: meta.ws })));
  if (meta.ts) {
    b.appendChild(h('div', { class: 'fl', text: 'Test Steps' }));
    b.appendChild(h('div', { class: 'tbox', text: tr.ts || meta.ts }));
    if (tr.translated && tr.ts) b.appendChild(h('details', null, h('summary', { text: t('detail.original') }), h('div', { class: 'tbox en', text: meta.ts })));
  }
  b.appendChild(h('div', { class: 'fl', text: t('detail.policy') }));
  b.appendChild(h('span', { class: 'poltag', text: meta.policy || '—' }));

  // result
  b.appendChild(h('div', { class: 'fl', text: t('detail.result') }));
  const rrow = h('div', { class: 'rsrow' });
  for (const [val, cls, label] of [['yes', 'rby', 'Yes'], ['no', 'rbn', 'No'], ['na', 'rbna', 'N/A'], ['hold', 'rbh', 'Hold']]) {
    rrow.appendChild(h('button', { class: 'rsb ' + cls + (it.result === val ? ' act' : ''), disabled: !editable, why, text: label,
      onclick: () => { ed({ result: ctl.state.doc.items[id].result === val ? null : val }); redraw(); } }));
  }
  b.appendChild(rrow);

  const field = (key, label, max, rows = 4) => {
    const cnt = h('span', { class: 'cnt' });
    const ta = h('textarea', { rows: String(rows), maxlength: String(max), disabled: !editable, why, value: it[key] || '', 'aria-label': label });
    const upd = () => { cnt.textContent = `${ta.value.length}/${max}`; cnt.classList.toggle('over', ta.value.length >= max); };
    ta.addEventListener('input', () => { upd(); ed({ [key]: ta.value }); });
    upd();
    return h('div', { class: 'ig full' }, h('label', null, h('span', { text: label }), cnt), ta);
  };
  b.appendChild(h('div', { class: 'igrid', style: { marginTop: '12px' } },
    field('response', t('detail.response'), MAX_TEXT, 5),
    field('evidence', t('detail.evidence'), MAX_TEXT, 3),
    field('sample', t('detail.sample'), MAX_TEXT, 3)));

  // remediation
  const r = it.remediation || {};
  const need = it.result === 'no';
  const rin = (key, label, type, max) => {
    const el = h('input', { type, disabled: !editable, why, value: r[key] || '', maxlength: max ? String(max) : null, 'aria-label': label });
    el.addEventListener(type === 'date' ? 'change' : 'input', () => ed({ remediation: { [key]: el.value || (type === 'date' ? null : '') } }));
    return h('div', { class: 'ig' }, h('label', { text: label }), el);
  };
  const actTa = h('textarea', { rows: '3', disabled: !editable, why, maxlength: String(MAX_TEXT), value: r.action || '', 'aria-label': t('detail.remAction') });
  actTa.addEventListener('input', () => ed({ remediation: { action: actTa.value } }));
  const remed = h('div', { class: 'remed' + (need && !(r.action || '').trim() ? ' need' : '') },
    h('h4', { text: t('detail.remediation') + (need ? ' — ' + t('detail.remNeeded') : '') }),
    h('div', { class: 'igrid' }, h('div', { class: 'ig full' }, h('label', { text: t('detail.remAction') }), actTa), rin('owner', t('detail.remOwner'), 'text', MAX_SHORT), rin('due', t('detail.remDue'), 'date')));
  b.appendChild(need || r.action || r.owner || r.due ? remed : h('details', null, h('summary', { text: t('detail.remediation') }), remed));

  // AuditBoard copy
  b.appendChild(h('div', { class: 'acts' },
    h('button', { class: 'btn btn-l', text: '📋 ' + t('detail.copy'), onclick: () => copyForAuditBoard(ctl, set, id) }),
    ...actionButtons(ctl, id, redraw)));

  // comments
  b.appendChild(h('div', { class: 'fl', text: t('detail.comments') }));
  const thread = h('div', { class: 'thread' }, (doc.comments[id] || []).map((c) => h('div', { class: 'cmt k-' + c.kind },
    h('div', { class: 'cmeta', text: `${c.by} · ${t('role.' + c.role)} · ${fmtTime(c.at)}${c.kind !== 'comment' ? ' · ' + t('ckind.' + c.kind) : ''}` }), h('div', { class: 'pre', text: c.text }))));
  b.appendChild(thread);
  if (!s.readonly && wf.can('comment', wf.itemCtx(doc, id)).ok) {
    const cin = h('input', { type: 'text', maxlength: '2000', placeholder: t('detail.addComment') });
    const send = async () => { const v = cin.value; if (!v.trim()) return; const res = await run((d) => wf.addComment(d, id, v)); if (res) { cin.value = ''; redraw(); } };
    cin.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    b.appendChild(h('div', { class: 'cadd' }, cin, h('button', { class: 'btn btn-p', text: t('btn.add'), onclick: send })));
  }

  // history
  const hist = h('div', { class: 'hist', text: t('detail.loading') });
  const det = h('details', null, h('summary', { text: t('detail.history') }), hist);
  det.addEventListener('toggle', async () => {
    if (!det.open) return;
    const list = await ctl.store.history(doc.wsId, id);
    clear(hist);
    if (!list.length) hist.appendChild(h('div', { text: '—' }));
    for (const e of list.reverse()) hist.appendChild(h('div', { text: `${fmtTime(e.at)} · ${e.by} · ${t('hist.' + e.action)}${e.detail && e.detail.fields ? ' (' + e.detail.fields.join(', ') + ')' : ''}${e.detail && e.detail.to ? ' → ' + t('status.' + e.detail.to) : ''}${e.detail && e.detail.reason ? ' — ' + e.detail.reason : ''}` }));
  });
  b.appendChild(det);
  return card;
}

function actionButtons(ctl, id, redraw) {
  const s = ctl.state, doc = s.doc, it = doc.items[id];
  if (s.readonly || doc.local.role !== 'reviewer') return [];
  const out = [];
  const ctx = wf.itemCtx(doc, id);
  if (wf.can('approve', ctx).ok) out.push(h('button', { class: 'btn btn-y', text: '✓ ' + t('btn.approve'), onclick: async () => { await run((d) => wf.approve(d, [id])); redraw(); } }));
  if (['draft', 'submitted', 'approved'].includes(it.status)) out.push(h('button', { class: 'btn btn-n', text: '↩ ' + t('btn.return'), onclick: async () => {
    const reason = await askReason(t('btn.return'), t('detail.returnReason'));
    if (reason) { await run((d) => wf.returnItem(d, id, reason)); redraw(); }
  } }));
  if (wf.can('enter', ctx).ok) out.push(h('button', { class: 'btn btn-p', text: '🔒 ' + t('btn.enter'), onclick: async () => {
    const yes = await modal({ title: t('btn.enter'), body: h('p', { text: t('detail.enterConfirm') }), buttons: [{ label: t('btn.cancel'), value: false }, { label: t('btn.enter'), cls: 'btn-p', value: true }] });
    if (yes) { await run((d) => wf.markEntered(d, [id])); redraw(); }
  } }));
  if (it.status === 'entered') out.push(h('button', { class: 'btn btn-w', text: '🔓 ' + t('btn.unlock'), onclick: async () => {
    const reason = await askReason(t('btn.unlock'), t('detail.unlockReason'));
    if (reason) { await withRestorePoint('before-unlock', (d) => wf.unlock(d, id, reason)); }
  } }));
  return out;
}

export async function askReason(title, label) {
  const ta = h('textarea', { rows: '3', maxlength: '2000' });
  return modal({ title, body: h('div', null, h('p', { text: label }), ta), onMount: () => ta.focus(),
    buttons: [{ label: t('btn.cancel'), value: null }, { label: t('btn.ok'), cls: 'btn-p', value: () => ta.value.trim(), validate: () => !!ta.value.trim() }] });
}

// AuditBoard copy: provisional format until the real input screen is confirmed (TASKS T72).
async function copyForAuditBoard(ctl, set, id) {
  const it = ctl.state.doc.items[id], m = set.byId[id];
  const res = { yes: 'Yes', no: 'No', na: 'N/A', hold: 'Hold' }[it.result] || '';
  const parts = [res, it.response || ''];
  if (it.evidence) parts.push('Evidence: ' + it.evidence);
  if (it.sample) parts.push('Sample: ' + it.sample);
  if (it.result === 'no' && it.remediation && it.remediation.action) parts.push(`Remediation: ${it.remediation.action}${it.remediation.owner ? ' / ' + it.remediation.owner : ''}${it.remediation.due ? ' / ' + it.remediation.due : ''}`);
  try { await navigator.clipboard.writeText(parts.filter(Boolean).join('\n')); toast(t('detail.copied', { no: m.no })); } catch { toast(t('err.clipboard')); }
}

export { setView, isAnswered };
