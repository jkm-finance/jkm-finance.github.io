// Area / Regional DOF consolidation mode (SPEC §9). Read-only; separate database.
import { h, clear, toast, modal, dropZone, fmtTime, pct } from './dom.js';
import { t, getLang, setLang } from './i18n.js';
import { getItemSet, allItemSets } from './itemsets.js';
import { summarize } from './summary.js';
import { readAndVerify } from './files.js';
import { FinalStore } from './store.js';
import { reportView, finalReportData } from './ui-report.js';
import { exportSheets } from './excel.js';
import { todayLocal } from './util.js';
import { guideLink } from './main.js';
import { policyEl } from './policy.js';

const SECTIONS = [...new Set(allItemSets().flatMap((s) => s.sections))];

function heatColor(score) {
  if (score === null || score === undefined) return '#c9d1d0';
  if (score >= 95) return '#3C6E58';
  if (score >= 85) return '#6f8f4e';
  if (score >= 75) return '#B8862E';
  return '#9C4B3E';
}

export async function renderRegional(ctl) {
  const fs = await new FinalStore('region').open();
  const state = { tab: 'hotels', open: null };
  const root = clear(document.getElementById('root'));
  const app = h('div', { id: 'app' });
  root.appendChild(app);
  const hdr = h('header', { id: 'hdr' });
  const body = h('div', { id: 'ct' });
  app.appendChild(hdr); app.appendChild(body);

  const draw = async () => {
    const groups = await fs.latest();
    const rows = groups.map((g) => {
      const f = g.latest.file;
      return { g, f, sum: summarize(f.payload.items, f.workspace.itemSetId), set: getItemSet(f.workspace.itemSetId) };
    }).sort((a, b) => a.f.workspace.hotelName.localeCompare(b.f.workspace.hotelName));
    clear(hdr); clear(body);
    hdr.appendChild(h('div', { class: 'hbrand' }, h('span', { class: 'csa-badge', text: 'CSA' }), h('span', { class: 'htitle', text: t('reg.title') })));
    hdr.appendChild(h('div', { class: 'hws' }, h('span', { class: 'role-badge', text: t('role.regional') }), h('span', { class: 'hchip', text: t('reg.hotels', { n: rows.length }) })));
    hdr.appendChild(h('div', { class: 'hacts' },
      ['hotels', 'heat', 'findings'].map((k) => h('button', { class: 'btn btn-o' + (state.tab === k ? ' act' : ''), text: t('reg.tab.' + k), onclick: () => { state.tab = k; state.open = null; draw(); } })),
      ['ko', 'en', 'ja'].map((l) => h('button', { class: 'btn btn-o' + (getLang() === l ? ' act' : ''), text: l.toUpperCase(), onclick: () => { setLang(l); draw(); } })),
      guideLink(),
      h('button', { class: 'btn btn-o', text: t('reg.logout'), onclick: () => { sessionStorage.removeItem('jkmcsa.auth'); location.reload(); } })));

    const pane = h('div', { class: 'pane' });
    body.appendChild(pane);
    if (state.open) {
      const g = groups.find((x) => x.latest.wsId === state.open);
      pane.appendChild(h('div', { class: 'acts noprint', style: { border: 'none' } }, h('button', { class: 'btn btn-l', text: '← ' + t('reg.backToList'), onclick: () => { state.open = null; draw(); } }), h('button', { class: 'btn btn-p', text: '🖨 ' + t('report.print'), onclick: () => window.print() })));
      if (g) pane.appendChild(reportView(finalReportData(g.latest.file)));
      return;
    }
    const status = h('div');
    pane.appendChild(h('div', { class: 'card noprint' }, h('div', { class: 'ctitle', text: t('reg.load') }), h('div', { class: 'cbodyp' }, h('p', { class: 'wsmeta', text: t('reg.loadHelp') }),
      dropZone(t('files.drop'), async (texts) => {
        clear(status);
        for (const f of texts) {
          try {
            const v = await readAndVerify(f.text, { mode: 'regional' });
            const r = await fs.put(v);
            status.appendChild(h('p', { class: r.replaced && !r.sameContent ? 'ferr' : 'fok', text: `${r.replaced && !r.sameContent ? '⚠' : '✓'} ${f.name} — ${v.workspace.hotelName} v${v.payload.finalVersion}${r.replaced ? (r.sameContent ? ' ' + t('reg.dup') : ' ' + t('reg.sameVersionDiff')) : ''}` }));
          } catch (e) { status.appendChild(h('p', { class: 'ferr', text: `✕ ${f.name} — ${t('ferr.' + (e.code || 'corrupt'))}` })); }
        }
        setTimeout(draw, 600);
      }), status)));

    if (!rows.length) { pane.appendChild(h('p', { class: 'empty', text: t('reg.empty') })); return; }
    pane.appendChild(h('div', { class: 'acts noprint', style: { border: 'none' } }, h('button', { class: 'btn btn-g', text: t('reg.excel'), onclick: () => exportRegional(rows) })));

    if (state.tab === 'hotels') {
      pane.appendChild(h('div', { class: 'card' }, h('div', { class: 'ctitle', text: t('reg.tab.hotels') }), h('div', { class: 'cbodyp' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, [t('reg.hotel'), t('reg.type'), t('reg.version'), t('ov.score'), 'Key', 'HR', 'MR', 'No', 'Hold', t('ov.entered'), ''].map((x) => h('th', { text: x })))),
        h('tbody', null, rows.map(({ g, f, sum }) => h('tr', null,
          h('td', null, h('a', { href: '#', text: f.workspace.hotelName, onclick: (e) => { e.preventDefault(); state.open = g.latest.wsId; draw(); } }), g.latest.conflictWith ? h('span', { class: 'ferr', text: ' ⚠' }) : null, h('div', { class: 'wsmeta', text: 'ID ' + g.latest.wsId.slice(0, 6) })),
          h('td', { text: f.workspace.serviceType === 'full' ? 'Full' : 'Focus' }),
          h('td', { text: `v${f.payload.finalVersion} · ${fmtTime(f.payload.finalizedAt)}` + (g.older.length ? ` (+${g.older.length})` : '') }),
          h('td', { class: 'num', text: pct(sum.score) }), h('td', { class: 'num', text: pct(sum.byRisk.Key.score) }), h('td', { class: 'num', text: pct(sum.byRisk.HR.score) }), h('td', { class: 'num', text: pct(sum.byRisk.MR.score) }),
          h('td', { class: 'num', text: sum.counts.no }), h('td', { class: 'num', text: sum.counts.hold }), h('td', { class: 'num', text: Math.round(sum.enteredRate * 100) + '%' }),
          h('td', null, h('button', { class: 'btn btn-l noprint', text: t('reg.remove'), onclick: async () => {
            const yes = await modal({ title: t('reg.remove'), body: h('p', { text: t('reg.removeConfirm', { hotel: f.workspace.hotelName }) }), buttons: [{ label: t('btn.cancel'), value: false }, { label: t('reg.remove'), cls: 'btn-n', value: true }] });
            if (yes) { await fs.removeWorkspace(g.latest.wsId); draw(); }
          } })))))))));
    } else if (state.tab === 'heat') {
      pane.appendChild(h('div', { class: 'card' }, h('div', { class: 'ctitle', text: t('reg.tab.heat') }), h('div', { class: 'cbodyp', style: { overflowX: 'auto' } }, h('table', { class: 'tbl heat' },
        h('thead', null, h('tr', null, h('th', { text: t('reg.hotel') }), SECTIONS.map((s) => h('th', { text: s })))),
        h('tbody', null, rows.map(({ f, sum, set }) => h('tr', null, h('td', { text: f.workspace.hotelName + (f.workspace.serviceType === 'focus' ? ' (Focus)' : '') }),
          SECTIONS.map((s) => {
            if (!set.sections.includes(s)) return h('td', { class: 'hc', style: { background: '#f3f5f5', color: '#aab' }, text: '' });
            const sc = sum.bySection[s].score;
            return h('td', { class: 'hc', style: { background: heatColor(sc) }, text: sc === null ? '—' : String(sc) });
          }))))))));
    } else {
      const today = todayLocal();
      const list = rows.flatMap(({ f, set }) => set.items.filter((m) => f.payload.items[m.id].result === 'no').map((m) => ({ f, m, it: f.payload.items[m.id] })));
      pane.appendChild(h('div', { class: 'card' }, h('div', { class: 'ctitle', text: `${t('reg.tab.findings')} (${list.length})` }), h('div', { class: 'cbodyp' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, [t('reg.hotel'), '#', t('col.section'), 'Risk', t('detail.policy'), t('detail.remediation'), t('detail.remOwner'), t('detail.remDue')].map((x) => h('th', { text: x })))),
        h('tbody', null, list.map(({ f, m, it }) => { const due = it.remediation.due; const over = due && due < today; return h('tr', null,
          h('td', { text: f.workspace.hotelName }), h('td', { text: m.no }), h('td', { text: m.section }), h('td', null, h('span', { class: 'badge rk-' + m.risk, text: m.risk })),
          h('td', null, policyEl(m.policy, 'polcell')), h('td', { class: 'pre', text: it.remediation.action || '—' }), h('td', { text: it.remediation.owner || '—' }),
          h('td', { class: over ? 'overdue' : '', text: (due || '—') + (over ? ' ⚠' : '') })); }))))));
    }
  };
  draw();
}

function exportRegional(rows) {
  const summary = [['Hotel', 'Type', 'Final version', 'Finalized at', 'Score', 'Key', 'HR', 'MR', 'Yes', 'No', 'N/A', 'Hold', 'AuditBoard entered']].concat(rows.map(({ f, sum }) => [
    f.workspace.hotelName, f.workspace.serviceType, f.payload.finalVersion, f.payload.finalizedAt, sum.score, sum.byRisk.Key.score, sum.byRisk.HR.score, sum.byRisk.MR.score,
    sum.counts.yes, sum.counts.no, sum.counts.na, sum.counts.hold, Math.round(sum.enteredRate * 1000) / 10]));
  const heat = [['Hotel'].concat(SECTIONS)].concat(rows.map(({ f, sum, set }) => [f.workspace.hotelName].concat(SECTIONS.map((s) => (set.sections.includes(s) ? sum.bySection[s].score : '')))));
  const findings = [['Hotel', 'No', 'Section', 'Risk', 'Policy', 'Work Step', 'Response', 'Remediation', 'Owner', 'Due']].concat(rows.flatMap(({ f, set }) => set.items.filter((m) => f.payload.items[m.id].result === 'no').map((m) => {
    const it = f.payload.items[m.id];
    return [f.workspace.hotelName, m.no, m.section, m.risk, m.policy, m.ws, it.response, it.remediation.action, it.remediation.owner, it.remediation.due || ''];
  })));
  exportSheets(`CSA2026_Consolidated_${todayLocal().replace(/-/g, '')}.xlsx`, [{ name: 'Hotels', rows: summary }, { name: 'Heatmap', rows: heat }, { name: 'Findings', rows: findings }]);
}

export { toast };
