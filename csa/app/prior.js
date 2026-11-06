// Prior-year results (SPEC §5.4, proposal ④). Pure, so it can be unit-tested in Node.
// Sources: an Excel sheet with a Work Step + Response (+ Testing Notes) block, e.g. the team's
// "2025 CSA | 2026 CSA" comparison sheets, or a prior year's FINAL file from this app.
// Rows are matched to this year's items by Work Step text; nothing is guessed.
import { getItemSet } from './itemsets.js';
import { normWs } from './abexport.js';
import { nowISO } from './util.js';

export const PRIOR_RESULTS = ['yes', 'no', 'na', 'hold'];
const NOTE_MAX = 2000;
const TOKENS = { yes: 'yes', o: 'yes', no: 'no', x: 'no', 'n/a': 'na', na: 'na', hold: 'hold' };
const cell = (v) => (v === null || v === undefined ? '' : String(v).trim());

export function resultToken(v) {
  return TOKENS[cell(v).toLowerCase()] || null;
}

const emptyNote = (s) => (/^(n\/a|na|0|-|—)?$/i.test(s) ? '' : s);

// One sheet (array of rows). Uses the FIRST Work Step block: Response/Status and Testing Notes
// columns between that Work Step column and the next one. Returns null if the sheet has no such block.
export function parsePriorSheet(name, aoa) {
  const hi = (aoa || []).slice(0, 10).findIndex((r) => (r || []).some((c) => /^work step$/i.test(cell(c))));
  if (hi < 0) return null;
  const head = aoa[hi].map((c) => cell(c).toLowerCase());
  const w = head.indexOf('work step');
  const next = head.findIndex((c, i) => i > w && c === 'work step');
  const end = next < 0 ? head.length : next;
  const inBlock = (pred) => head.findIndex((c, i) => i > w && i < end && pred(c));
  const rc = inBlock((c) => c === 'response' || c === 'result' || /^status( \(o\/x\))?$/.test(c));
  if (rc < 0) return null;
  const nc = inBlock((c) => c === 'testing notes' || c === 'test notes');
  // a "2025 CSA" label above the block names the year
  let year = null;
  for (let i = 0; i < hi; i++) for (let j = 0; j <= w && j < (aoa[i] || []).length; j++) {
    const m = /\b(20\d\d)\s*CSA\b/i.exec(cell(aoa[i][j]));
    if (m) year = parseInt(m[1], 10);
  }
  const rows = [];
  let other = 0;
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const ws = cell(r[w]);
    if (!ws) continue;
    const result = resultToken(r[rc]);
    if (!result) { other += 1; continue; }
    rows.push({ sheet: name, line: i + 1, ws, result, note: nc >= 0 ? emptyNote(cell(r[nc])).slice(0, NOTE_MAX) : '' });
  }
  return { name, year, rows, other };
}

// A verified FINAL file of an earlier year whose item set this app still knows.
export function rowsFromFinal(file) {
  const set = getItemSet(file.workspace.itemSetId);
  return set.items.filter((m) => file.payload.items[m.id] && PRIOR_RESULTS.includes(file.payload.items[m.id].result))
    .map((m) => ({ sheet: 'FINAL v' + file.payload.finalVersion, line: m.no, ws: m.ws, result: file.payload.items[m.id].result, note: String(file.payload.items[m.id].response || '').slice(0, NOTE_MAX) }));
}

export function matchPrior(rows, doc) {
  const set = getItemSet(doc.itemSetId);
  const byWs = new Map(set.items.map((m) => [normWs(m.ws), m]));
  const items = {}, unmatched = [], dup = [];
  const counts = { yes: 0, no: 0, na: 0, hold: 0 };
  for (const r of rows) {
    const m = byWs.get(normWs(r.ws));
    if (!m) { unmatched.push(r); continue; }
    if (items[m.id]) { if (items[m.id].result !== r.result || items[m.id].note !== r.note) dup.push({ ...r, itemId: m.id }); continue; }
    items[m.id] = { result: r.result, ...(r.note ? { note: r.note } : {}) };
    counts[r.result] += 1;
  }
  return { items, matched: Object.keys(items).length, unmatched, dup, counts };
}

export function priorRecord(match, { year, file, by }) {
  return { year, importedAt: nowISO(), importedBy: by || '', file: String(file || '').slice(0, 200), items: match.items };
}

export function validatePrior(prior, set, errs, { year } = {}) {
  if (prior === undefined || prior === null) return;
  if (typeof prior !== 'object' || !prior.items || typeof prior.items !== 'object' || Array.isArray(prior.items)) { errs.push('prior invalid'); return; }
  if (!Number.isInteger(prior.year) || (year && prior.year >= year)) errs.push('prior.year invalid');
  for (const [id, v] of Object.entries(prior.items)) {
    if (!set.byId[id]) errs.push(`prior: unknown item ${id}`);
    else if (!v || !PRIOR_RESULTS.includes(v.result) || (v.note !== undefined && (typeof v.note !== 'string' || v.note.length > NOTE_MAX))) errs.push(`prior: ${id} invalid`);
  }
}

export function priorOf(doc, id) {
  return (doc && doc.prior && doc.prior.items && doc.prior.items[id]) || null;
}

// What travels in files: the same record (notes included, so preparers see last year's testing note).
export function priorForFile(doc) {
  return doc.prior ? { year: doc.prior.year, items: doc.prior.items } : undefined;
}
