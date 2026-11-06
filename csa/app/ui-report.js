// DOF report (screen + A4 print) and the read-only Hotel DOF viewer (SPEC §8.2, §8.3).
import { h, clear, toast, fmtTime, pct, modal } from './dom.js';
import { t, getLang, setLang, itemText } from './i18n.js';
import { getItemSet } from './itemsets.js';
import { summarize } from './summary.js';
import { FinalStore } from './store.js';
import { goStart, langRow, guideLink } from './main.js';

const RES = { yes: 'Yes', no: 'No', na: 'N/A', hold: 'Hold' };

// data: { hotelName, serviceType, year, itemSetId, items, final: { version, at, by } | null }
export function reportView(data, { showOriginal = false } = {}) {
  const set = getItemSet(data.itemSetId);
  const sum = summarize(data.items, data.itemSetId);
  const lang = getLang();
  const txt = (m) => { const tr = itemText(m, lang); return showOriginal && tr.translated ? `${tr.ws}\n— ${m.ws}` : tr.ws; };
  const r = h('section', { class: 'report' });
  if (!data.final) r.appendChild(h('div', { class: 'draftmark', text: t('report.draft') }));
  r.appendChild(h('h1', { text: `${t('report.title')} — ${data.hotelName}` }));
  r.appendChild(h('div', { class: 'meta', text: `${data.serviceType === 'full' ? 'Full Service' : 'Focus Service'} · ${data.year} · ` +
    (data.final ? t('report.finalInfo', { v: data.final.version, at: fmtTime(data.final.at), by: data.final.by }) : t('report.notFinal')) }));

  r.appendChild(h('h2', { text: t('report.summary') }));
  r.appendChild(h('table', { class: 'tbl' }, h('tbody', null,
    h('tr', null, h('th', { text: t('ov.score') }), h('td', { text: pct(sum.score) }), h('th', { text: 'Key' }), h('td', { text: pct(sum.byRisk.Key.score) }), h('th', { text: 'HR' }), h('td', { text: pct(sum.byRisk.HR.score) }), h('th', { text: 'MR' }), h('td', { text: pct(sum.byRisk.MR.score) })),
    h('tr', null, h('th', { text: 'Yes / No' }), h('td', { text: `${sum.counts.yes} / ${sum.counts.no}` }), h('th', { text: 'N/A / Hold' }), h('td', { text: `${sum.counts.na} / ${sum.counts.hold}` }), h('th', { text: t('ov.progress') }), h('td', { text: `${sum.answered}/${sum.total}` }), h('th', { text: t('ov.entered') }), h('td', { text: Math.round(sum.enteredRate * 100) + '%' })))));

  r.appendChild(h('h2', { text: t('report.bySection') }));
  r.appendChild(h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, [t('col.section'), t('col.items'), 'Yes', 'No', 'N/A', 'Hold', t('col.score')].map((x, i) => h('th', { class: i ? 'num' : '', text: x })))),
    h('tbody', null, set.sections.map((s) => { const c = sum.bySection[s]; return h('tr', null, h('td', { text: s }), h('td', { class: 'num', text: c.total }), h('td', { class: 'num', text: c.yes }), h('td', { class: 'num', text: c.no }), h('td', { class: 'num', text: c.na }), h('td', { class: 'num', text: c.hold }), h('td', { class: 'num', text: pct(c.score) })); }))));

  const findings = set.items.filter((m) => data.items[m.id].result === 'no');
  const repeat = (m) => data.prior && data.prior.items[m.id] && data.prior.items[m.id].result === 'no';
  const nRepeat = findings.filter(repeat).length;
  r.appendChild(h('h2', { text: `${t('report.findings')} (${findings.length})` + (data.prior ? ' · ' + t('prior.repeatN', { y: data.prior.year, n: nRepeat }) : '') }));
  if (!findings.length) r.appendChild(h('p', { text: t('report.none') }));
  else r.appendChild(h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, ['#', t('col.section'), 'Risk', t('detail.workStep'), t('detail.response'), t('detail.remediation'), t('detail.remOwner'), t('detail.remDue')].map((x) => h('th', { text: x })))),
    h('tbody', null, findings.map((m) => { const it = data.items[m.id]; const rem = it.remediation || {}; return h('tr', null,
      h('td', null, String(m.no), repeat(m) ? h('div', { class: 'badge prior p-no', text: t('prior.repeat') }) : null), h('td', { text: m.section }), h('td', null, h('span', { class: 'badge rk-' + m.risk, text: m.risk })), h('td', { class: 'pre', text: txt(m) }),
      h('td', { class: 'pre', text: it.response || '—' }), h('td', { class: 'pre', text: rem.action || '—' }), h('td', { text: rem.owner || '—' }), h('td', { text: rem.due || '—' })); }))));

  const holds = set.items.filter((m) => data.items[m.id].result === 'hold');
  r.appendChild(h('h2', { text: `${t('report.hold')} (${holds.length})` }));
  if (!holds.length) r.appendChild(h('p', { text: t('report.none') }));
  else r.appendChild(h('table', { class: 'tbl' }, h('tbody', null, holds.map((m) => h('tr', null, h('td', { text: m.no }), h('td', { text: m.section }), h('td', { class: 'pre', text: txt(m) }), h('td', { class: 'pre', text: data.items[m.id].response || '—' }))))));
  r.appendChild(h('p', { class: 'meta', text: t('report.generated', { at: fmtTime(new Date().toISOString()) }) }));
  return r;
}

export function workspaceReportData(doc) {
  return { hotelName: doc.hotelName, serviceType: doc.serviceType, year: doc.year, itemSetId: doc.itemSetId, items: doc.items, final: doc.finalize.current, prior: doc.prior };
}

export function finalReportData(file) {
  const w = file.workspace, p = file.payload;
  return { hotelName: w.hotelName, serviceType: w.serviceType, year: w.year, itemSetId: w.itemSetId, items: p.items, final: { version: p.finalVersion, at: p.finalizedAt, by: p.finalizedBy }, prior: p.prior };
}

function reportToolbar(rerender, state) {
  return h('div', { class: 'acts noprint', style: { maxWidth: '900px', margin: '0 auto', border: 'none' } },
    h('button', { class: 'btn btn-p', text: '🖨 ' + t('report.print'), onclick: () => window.print() }),
    h('label', { class: 'wsmeta' }, h('input', { type: 'checkbox', checked: state.showOriginal, onchange: (e) => { state.showOriginal = e.target.checked; rerender(); } }), ' ' + t('report.showOriginal')),
    h('span', { class: 'wsmeta', text: t('report.printHelp') }));
}

export function renderReportPane(ctl) {
  const state = { showOriginal: false };
  const box = h('div', { class: 'pane' });
  const draw = () => { clear(box); box.appendChild(reportToolbar(draw, state)); box.appendChild(reportView(workspaceReportData(ctl.state.doc), state)); };
  draw();
  return box;
}

// ---- Hotel DOF viewer (read-only) ------------------------------------------------------

export async function renderDofViewer(ctl, file) {
  const fs = await new FinalStore('view').open();
  if (file) await fs.put(file);
  const all = await fs.latest();
  const root = clear(document.getElementById('root'));
  const app = h('div', { id: 'app' });
  root.appendChild(app);
  let current = file ? all.find((g) => g.latest.wsId === file.workspace.wsId) : all[0];
  let version = current ? (file ? file.payload.finalVersion : current.latest.finalVersion) : null;
  const state = { showOriginal: false, tab: 'report' };
  const body = h('div', { id: 'ct' });
  const hdr = h('header', { id: 'hdr' });
  app.appendChild(hdr); app.appendChild(body);

  const recOf = () => { if (!current) return null; const list = [current.latest, ...current.older]; return list.find((r) => r.finalVersion === version) || current.latest; };
  const draw = () => {
    clear(hdr); clear(body);
    hdr.appendChild(h('div', { class: 'hbrand' }, h('span', { class: 'csa-badge', text: 'CSA' }), h('span', { class: 'htitle', text: t('dof.title') })));
    const sel = h('select', { class: 'btn btn-o', onchange: (e) => { const [ws, v] = e.target.value.split('|'); current = all.find((g) => g.latest.wsId === ws); version = Number(v); draw(); } },
      all.flatMap((g) => [g.latest, ...g.older].map((r) => h('option', { value: `${r.wsId}|${r.finalVersion}`, selected: current && r.wsId === current.latest.wsId && r.finalVersion === version, text: `${r.file.workspace.hotelName} · v${r.finalVersion}${r === g.latest ? '' : ' (' + t('dof.older') + ')'}` }))));
    hdr.appendChild(h('div', { class: 'hws' }, all.length ? sel : null, h('span', { class: 'role-badge', text: t('role.dof') })));
    hdr.appendChild(h('div', { class: 'hacts' },
      ['report', 'items'].map((k) => h('button', { class: 'btn btn-o' + (state.tab === k ? ' act' : ''), text: t('dof.tab.' + k), onclick: () => { state.tab = k; draw(); } })),
      ['ko', 'en', 'ja'].map((l) => h('button', { class: 'btn btn-o' + (getLang() === l ? ' act' : ''), text: l.toUpperCase(), onclick: () => { setLang(l); draw(); } })),
      guideLink(),
      h('button', { class: 'btn btn-o', text: '↩ ' + t('dof.back'), onclick: () => goStart() })));
    const rec = recOf();
    if (!rec) { body.appendChild(h('div', { class: 'pane' }, h('p', { class: 'empty', text: t('dof.none') }))); return; }
    const pane = h('div', { class: 'pane' });
    if (rec.conflictWith) pane.appendChild(h('div', { class: 'banner warn', text: t('dof.sameVersionDiff') }));
    if (state.tab === 'report') { pane.appendChild(reportToolbar(draw, state)); pane.appendChild(reportView(finalReportData(rec.file), state)); }
    else pane.appendChild(readonlyItems(rec.file));
    body.appendChild(pane);
  };
  draw();
}

function readonlyItems(file) {
  const set = getItemSet(file.workspace.itemSetId), items = file.payload.items, lang = getLang();
  const wrap = h('div');
  for (const sec of set.sections) {
    const metas = set.items.filter((m) => m.section === sec);
    wrap.appendChild(h('div', { class: 'card' }, h('div', { class: 'ctitle', text: sec }), h('div', { class: 'cbodyp' },
      h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['#', 'Risk', t('detail.workStep'), t('detail.result'), t('detail.response'), t('detail.evidence')].map((x) => h('th', { text: x })))),
        h('tbody', null, metas.map((m) => { const it = items[m.id]; return h('tr', null, h('td', { text: m.no }), h('td', null, h('span', { class: 'badge rk-' + m.risk, text: m.risk })), h('td', { class: 'pre', text: itemText(m, lang).ws }), h('td', { text: RES[it.result] || '—' }), h('td', { class: 'pre', text: it.response || '' }), h('td', { class: 'pre', text: it.evidence || '' })); }))))));
  }
  return wrap;
}

export { langRow, toast, modal };
