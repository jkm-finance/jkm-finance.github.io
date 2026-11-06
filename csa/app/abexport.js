// AuditBoard export (Excel) -> workspace link (SPEC §3.6). Pure, so it can be unit-tested in Node.
// The export lists one row per work step with its AuditBoard ID. Rows are matched to the built-in
// items by the Work Step text (unique within each set); nothing in the export changes the items.
import { getItemSet, allItemSets } from './itemsets.js';
import { nowISO } from './util.js';

export const AB_MAX_ROWS = 2000;
const ID_RE = /^[A-Za-z0-9-]{1,32}$/;
const NAME_MAX = 80;

// Excel escapes control characters as _x000D_ in shared strings; whitespace differences are not changes.
export function normWs(s) {
  return String(s ?? '').replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

const cell = (v) => (v === null || v === undefined ? '' : String(v).trim());
const mostCommon = (list) => {
  const c = new Map();
  for (const v of list) if (v) c.set(v, (c.get(v) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
};

// aoa: array of rows (arrays of cell values), e.g. SheetJS sheet_to_json(ws, { header: 1 }).
export function parseExport(aoa) {
  const hi = (aoa || []).slice(0, 10).findIndex((r) => (r || []).some((c) => /^work step$/i.test(cell(c))));
  if (hi < 0) throw Object.assign(new Error('no Work Step column'), { code: 'abNoHeader' });
  const head = aoa[hi].map((c) => cell(c).toLowerCase());
  const col = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const C = { ws: col('work step'), id: col('id'), sec: col('subsection'), title: col('audit title'), period: col('period'),
    prep: col('preparer'), rev: col('reviewer') };
  if (C.id < 0) throw Object.assign(new Error('no ID column'), { code: 'abNoHeader' });
  const rows = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const ws = cell(r[C.ws]);
    if (!ws) continue;
    rows.push({ line: i + 1, ws, abId: cell(r[C.id]), section: C.sec >= 0 ? cell(r[C.sec]) : '',
      title: C.title >= 0 ? cell(r[C.title]) : '', period: C.period >= 0 ? cell(r[C.period]) : '',
      preparer: C.prep >= 0 ? cell(r[C.prep]).slice(0, NAME_MAX) : '', reviewer: C.rev >= 0 ? cell(r[C.rev]).slice(0, NAME_MAX) : '' });
  }
  if (!rows.length) throw Object.assign(new Error('no rows'), { code: 'abEmpty' });
  if (rows.length > AB_MAX_ROWS) throw Object.assign(new Error('too many rows'), { code: 'abTooMany' });
  const y = parseInt(mostCommon(rows.map((r) => r.period)), 10);
  return { rows, hotel: mostCommon(rows.map((r) => r.title)), year: Number.isInteger(y) ? y : null };
}

// Match the rows to one item set. setId given = that set only (linking an existing workspace);
// otherwise the set of the export's year that matches the most rows.
export function matchExport(parsed, { setId = null, year = null } = {}) {
  const cands = setId ? [getItemSet(setId)] : allItemSets().filter((s) => s.year === (parsed.year || year));
  let best = null;
  for (const set of cands.filter(Boolean)) {
    const byWs = new Map(set.items.map((m) => [normWs(m.ws), m]));
    const ids = {}, preparer = {}, reviewer = {}, unmatched = [], duplicate = [], badId = [];
    for (const r of parsed.rows) {
      const m = byWs.get(normWs(r.ws));
      if (!m) { unmatched.push(r); continue; }
      if (!ID_RE.test(r.abId)) { badId.push({ ...r, itemId: m.id }); continue; }
      if (ids[m.id]) { duplicate.push({ ...r, itemId: m.id }); continue; }
      ids[m.id] = r.abId;
      if (r.preparer) preparer[m.id] = r.preparer;
      if (r.reviewer) reviewer[m.id] = r.reviewer;
    }
    const matched = Object.keys(ids).length;
    const missing = set.items.filter((m) => !ids[m.id]).map((m) => m.id);
    const res = { set, ids, preparer, reviewer, matched, unmatched, duplicate, badId, missing };
    if (!best || matched > best.matched || (matched === best.matched && missing.length < best.missing.length)) best = res;
  }
  if (!best || !best.matched) throw Object.assign(new Error('no rows match'), { code: 'abNoMatch' });
  return best;
}

// What is stored on the workspace (doc.ab). Optional; older documents simply have none.
export function abRecord(match, { file, hotel, by }) {
  return {
    importedAt: nowISO(), importedBy: by || '', file: String(file || '').slice(0, 200), hotel: String(hotel || '').slice(0, 200),
    ids: match.ids, preparer: match.preparer, reviewer: match.reviewer,
  };
}

export function validateAb(ab, set, errs) {
  if (ab === undefined || ab === null) return;
  if (typeof ab !== 'object' || !ab.ids || typeof ab.ids !== 'object') { errs.push('ab invalid'); return; }
  for (const [k, map] of [['ids', ab.ids], ['preparer', ab.preparer || {}], ['reviewer', ab.reviewer || {}]]) {
    if (typeof map !== 'object' || Array.isArray(map)) { errs.push(`ab.${k} invalid`); continue; }
    for (const [id, v] of Object.entries(map)) {
      if (!set.byId[id]) errs.push(`ab.${k}: unknown item ${id}`);
      else if (typeof v !== 'string' || (k === 'ids' ? !ID_RE.test(v) : v.length > NAME_MAX)) errs.push(`ab.${k}: ${id} invalid`);
    }
  }
}

export function abIdOf(doc, itemId) {
  return (doc.ab && doc.ab.ids && doc.ab.ids[itemId]) || '';
}
