// AuditBoard export Excel: read in the browser, preview the match, then create or link a workspace (SPEC §3.6).
// The file is read locally with the bundled SheetJS; nothing is uploaded.
import { h, clear, modal, dropZone, toast } from './dom.js';
import { t } from './i18n.js';
import { loadXLSX } from './excel.js';
import { parseExport, matchExport, abRecord } from './abexport.js';
import { createWorkspace } from './model.js';
import { YEAR } from './version.js';

const MAX_BYTES = 10 * 1024 * 1024;

export async function readExportFile(f) {
  if (f.size > MAX_BYTES) throw Object.assign(new Error(), { code: 'abTooBig' });
  let wb;
  try {
    const XLSX = await loadXLSX();
    wb = XLSX.read(await f.file.arrayBuffer(), { type: 'array', cellFormula: false, cellHTML: false });
    const name = wb.SheetNames.find((n) => /raw\s*data/i.test(n));
    const order = name ? [name, ...wb.SheetNames.filter((n) => n !== name)] : wb.SheetNames;
    let lastErr = null;
    for (const n of order) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: null, blankrows: false });
      try { return { sheet: n, ...parseExport(aoa) }; } catch (e) { lastErr = e; }
    }
    throw lastErr || Object.assign(new Error(), { code: 'abNoHeader' });
  } catch (e) {
    if (e && e.code) throw e;
    throw Object.assign(new Error(), { code: 'abUnreadable' });
  }
}

const rowLine = (r) => `${t('ab.row')} ${r.line} · ${r.section || '—'} · ID ${r.abId || '—'} · ${r.ws.slice(0, 90)}${r.ws.length > 90 ? '…' : ''}`;

function summaryBox(parsed, m) {
  const svc = m.set.serviceType === 'full' ? 'Full Service' : 'Focus Service';
  const box = h('div', { class: 'abprev' },
    h('table', { class: 'tbl' }, h('tbody', null,
      h('tr', null, h('th', { text: t('ab.sheet') }), h('td', { text: parsed.sheet })),
      h('tr', null, h('th', { text: t('ab.hotelInFile') }), h('td', { text: parsed.hotel || '—' })),
      h('tr', null, h('th', { text: t('start.service') }), h('td', { text: `${svc} · ${m.set.year}` })),
      h('tr', null, h('th', { text: t('ab.matched') }), h('td', { text: t('ab.matchedN', { n: m.matched, total: m.set.items.length, rows: parsed.rows.length }) })))));
  const issues = [
    ['ab.unmatched', m.unmatched], ['ab.duplicate', m.duplicate], ['ab.badId', m.badId],
  ].filter(([, l]) => l.length);
  for (const [k, list] of issues) {
    box.appendChild(h('details', { class: 'abiss' }, h('summary', { text: t(k, { n: list.length }) }),
      h('div', { class: 'wsmeta pre', text: list.slice(0, 50).map(rowLine).join('\n') + (list.length > 50 ? '\n…' : '') })));
  }
  if (m.missing.length) {
    const nos = m.missing.map((id) => '#' + m.set.byId[id].no);
    box.appendChild(h('p', { class: 'ferr', text: t('ab.missing', { n: m.missing.length, list: nos.slice(0, 30).join(', ') + (nos.length > 30 ? ' …' : '') }) }));
  }
  return box;
}

// Drop zone step shared by both entry points. Resolves with { f, parsed } or null.
function pickFile(title, help) {
  return new Promise((resolve) => {
    const status = h('div', { class: 'mbody-status' });
    let close, done = false;
    const onFiles = async ([f]) => {
      if (!f) return;
      clear(status);
      status.appendChild(h('p', { class: 'wsmeta', text: t('ab.reading') }));
      try {
        const parsed = await readExportFile(f);
        done = true; close(null); resolve({ f, parsed });
      } catch (e) {
        clear(status);
        status.appendChild(h('p', { class: 'ferr', text: `${f.name}: ${t('ferr.' + (e.code || 'abUnreadable'))}` }));
      }
    };
    modal({
      title, body: h('div', null, h('p', { text: help }), dropZone(t('ab.drop'), onFiles, { multiple: false, binary: true, accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), status),
      buttons: [{ label: t('btn.close'), value: null }], onMount: (mm) => { close = mm.close; },
    }).then(() => { if (!done) resolve(null); });
  });
}

// Start screen: new workspace from the export (reviewer).
export async function newFromExport(ctl, me, { openWorkspace }) {
  const got = await pickFile(t('ab.startTitle'), t('ab.startHelp'));
  if (!got) return;
  const { f, parsed } = got;
  let m;
  try { m = matchExport(parsed, { year: YEAR }); } catch (e) { toast(t('ferr.' + (e.code || 'abNoMatch')), 6000); return; }
  const nameIn = h('input', { type: 'text', maxlength: '120', value: parsed.hotel || '' });
  const list = await ctl.store.listWorkspaces();
  const same = list.filter((w) => w.year === m.set.year && w.serviceType === m.set.serviceType && w.hotelName.trim().toLowerCase() === (parsed.hotel || '').trim().toLowerCase());
  const ok = await modal({
    title: t('ab.startTitle'),
    body: h('div', null, summaryBox(parsed, m),
      same.length ? h('p', { class: 'banner warn', text: t('ab.sameHotel', { hotel: parsed.hotel }) }) : null,
      h('div', { class: 'fl', text: t('start.hotel') }), nameIn,
      h('p', { class: 'wsmeta', text: t('ab.startNote') })),
    buttons: [{ label: t('btn.cancel'), value: false }, { label: t('btn.create'), cls: 'btn-p', value: true, validate: () => { if (!nameIn.value.trim()) { nameIn.focus(); return false; } return true; } }],
  });
  if (!ok) return;
  const doc = createWorkspace({ hotelName: nameIn.value.trim(), serviceType: m.set.serviceType, year: m.set.year, itemSetId: m.set.id, by: me });
  doc.ab = abRecord(m, { file: f.name, hotel: parsed.hotel, by: me });
  try {
    await ctl.store.create(doc);
    await ctl.store.appendHistory([{ wsId: doc.wsId, itemId: null, at: doc.createdAt, by: me, role: 'reviewer', action: 'create', detail: { hotelName: doc.hotelName, serviceType: doc.serviceType, source: 'auditboard', file: f.name, matched: m.matched } }]);
    openWorkspace(doc.wsId);
  } catch (e) { toast(t('err.' + (e.code || 'storage'))); }
}

// Workspace (reviewer): link or refresh the AuditBoard IDs of the open workspace.
export async function linkExport(ctl, { withRestorePoint, linkAuditBoard }) {
  const doc = ctl.state.doc;
  const got = await pickFile(t('ab.linkTitle'), t('ab.linkHelp'));
  if (!got) return;
  const { f, parsed } = got;
  let m;
  try { m = matchExport(parsed, { setId: doc.itemSetId }); } catch (e) { toast(t('ferr.' + (e.code || 'abNoMatch')), 6000); return; }
  const otherHotel = parsed.hotel && parsed.hotel.trim().toLowerCase() !== doc.hotelName.trim().toLowerCase();
  const otherYear = parsed.year && parsed.year !== doc.year;
  const ok = await modal({
    title: t('ab.linkTitle'),
    body: h('div', null, summaryBox(parsed, m),
      otherHotel || otherYear ? h('p', { class: 'banner warn', text: t('ab.otherHotel', { file: `${parsed.hotel || '—'} ${parsed.year || ''}`, ws: `${doc.hotelName} ${doc.year}` }) }) : null,
      doc.ab ? h('p', { class: 'wsmeta', text: t('ab.replaceNote', { file: doc.ab.file }) }) : null),
    buttons: [{ label: t('btn.cancel'), value: false }, { label: t('ab.linkBtn'), cls: otherHotel || otherYear ? 'btn-n' : 'btn-p', value: true }],
  });
  if (!ok) return;
  const r = await withRestorePoint('before-ab-link', (d) => linkAuditBoard(d, abRecord(m, { file: f.name, hotel: parsed.hotel, by: d.local.me })));
  if (r) toast(t('ab.linked', { n: m.matched }));
}
