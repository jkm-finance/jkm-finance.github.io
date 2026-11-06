// Prior-year results: read an Excel or a final file locally, choose sheets/year, preview, apply (SPEC §5.4).
import { h, clear, modal, dropZone, toast } from './dom.js';
import { t } from './i18n.js';
import { loadXLSX } from './excel.js';
import { readAndVerify } from './files.js';
import { parsePriorSheet, rowsFromFinal, matchPrior, priorRecord } from './prior.js';

const MAX_BYTES = 10 * 1024 * 1024;
const err = (code) => Object.assign(new Error(), { code });

async function readSource(f, doc) {
  if (f.size > MAX_BYTES) throw err('abTooBig');
  if (/\.json$/i.test(f.name)) {
    const file = await readAndVerify(await f.file.text(), { mode: 'start' });
    if (file.kind !== 'final') throw err('wrongKindHere');
    if (file.workspace.year >= doc.year) throw err('priorSameYear');
    const rows = rowsFromFinal(file);
    return { kind: 'final', year: file.workspace.year, sheets: [{ name: 'FINAL v' + file.payload.finalVersion, year: file.workspace.year, rows, other: 0, on: true }] };
  }
  let wb;
  try {
    const XLSX = await loadXLSX();
    wb = XLSX.read(await f.file.arrayBuffer(), { type: 'array', cellFormula: false, cellHTML: false });
    const sheets = wb.SheetNames.map((n) => parsePriorSheet(n, XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: null, blankrows: false })))
      .filter((s) => s && s.rows.length);
    if (!sheets.length) throw err('priorNoSheet');
    const labelled = sheets.filter((s) => s.year && s.year < doc.year);
    const year = labelled.length ? labelled[0].year : doc.year - 1;
    // Sheets labelled with the chosen year are used; unlabelled sheets start unticked when any are labelled.
    for (const s of sheets) s.on = labelled.length ? s.year === year : !s.year || s.year < doc.year;
    return { kind: 'excel', year, sheets };
  } catch (e) {
    if (e && e.code) throw e;
    throw err('abUnreadable');
  }
}

export async function importPrior(ctl, { withRestorePoint, setPrior }) {
  const doc = ctl.state.doc;
  const got = await new Promise((resolve) => {
    const status = h('div', { class: 'mbody-status' });
    let close, done = false;
    const onFiles = async ([f]) => {
      if (!f) return;
      clear(status);
      try { const src = await readSource(f, doc); done = true; close(null); resolve({ f, src }); } catch (e) { status.appendChild(h('p', { class: 'ferr', text: `${f.name}: ${t('ferr.' + (e.code || 'abUnreadable'))}` })); }
    };
    modal({ title: t('prior.import'), body: h('div', null, h('p', { text: t('prior.help') }), dropZone(t('prior.drop'), onFiles, { multiple: false, binary: true, accept: '.xlsx,.json,application/json' }), status),
      buttons: [{ label: t('btn.close'), value: null }], onMount: (m) => { close = m.close; } }).then(() => { if (!done) resolve(null); });
  });
  if (!got) return;
  const { f, src } = got;
  const yearIn = h('input', { type: 'number', min: '2000', max: String(doc.year - 1), value: String(src.year), disabled: src.kind === 'final', style: { width: '90px' } });
  const result = h('div');
  const boxes = src.sheets.map((s) => {
    const cb = h('input', { type: 'checkbox', checked: s.on, disabled: src.kind === 'final' });
    cb.addEventListener('change', () => { s.on = cb.checked; draw(); });
    return h('label', null, cb, ' ' + t('prior.sheetRow', { name: s.name, n: s.rows.length, y: s.year ? t('prior.sheetYear', { y: s.year }) : '' }));
  });
  let match = null;
  const draw = () => {
    clear(result);
    match = matchPrior(src.sheets.filter((s) => s.on).flatMap((s) => s.rows), doc);
    result.appendChild(h('p', { class: match.matched ? '' : 'ferr', text: match.matched ? t('prior.summary', { n: match.matched, ...match.counts }) : t('ferr.priorNoMatch') }));
    for (const [k, list] of [['prior.unmatched', match.unmatched], ['prior.dup', match.dup]]) {
      if (list.length) result.appendChild(h('details', { class: 'abiss' }, h('summary', { text: t(k, { n: list.length }) }),
        h('div', { class: 'wsmeta pre', text: list.slice(0, 50).map((r) => `${r.sheet} ${t('ab.row')} ${r.line} · ${r.ws.slice(0, 90)}`).join('\n') })));
    }
  };
  draw();
  const ok = await modal({
    title: t('prior.import'),
    body: h('div', null,
      h('div', { class: 'fl', text: t('prior.sheets') }), h('div', { class: 'priorsheets' }, boxes),
      src.kind === 'excel' && src.sheets.some((s) => !s.year) && src.sheets.some((s) => s.year) ? h('p', { class: 'wsmeta', text: t('prior.sheetNote') }) : null,
      h('div', { class: 'fl', text: t('prior.year') }), yearIn, result,
      doc.prior ? h('p', { class: 'wsmeta', text: t('ab.replaceNote', { file: doc.prior.file }) }) : null),
    buttons: [{ label: t('btn.cancel'), value: false }, { label: t('prior.apply'), cls: 'btn-p', value: true, validate: () => {
      const y = parseInt(yearIn.value, 10);
      if (!Number.isInteger(y) || y >= doc.year || y < 2000) { yearIn.focus(); return false; }
      return !!(match && match.matched);
    } }],
  });
  if (!ok) return;
  const year = parseInt(yearIn.value, 10);
  const r = await withRestorePoint('before-prior', (d) => setPrior(d, priorRecord(match, { year, file: f.name, by: d.local.me })));
  if (r) toast(t('prior.applied', { y: year, n: match.matched }));
}
