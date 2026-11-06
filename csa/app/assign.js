// Per-item assignees pasted from Excel (SPEC §6.1). Pure, so it can be unit-tested in Node.
// Each line: item number (#12 or 12) or AuditBoard ID, then the name(s). Tab-separated like an Excel copy;
// several names in one cell are separated by commas or slashes.
import { getItemSet } from './itemsets.js';
import { normText } from './util.js';

const SKIP = new Set(['', 'n/a', 'na', '-', '—']);

// stripPrefix: "AR_HaEun" -> "HaEun" (the team's Excel writes section_name).
export function parseAssigneePaste(text, doc, { stripPrefix = true } = {}) {
  const set = getItemSet(doc.itemSetId);
  const byNo = new Map(set.items.map((m) => [String(m.no), m.id]));
  const byAb = new Map(Object.entries((doc.ab && doc.ab.ids) || {}).map(([id, ab]) => [ab, id]));
  const map = {}, bad = [], dup = [];
  let skipped = 0;
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const cols = line.includes('\t') ? line.split('\t') : line.split(/\s{2,}|\s*;\s*/);
    const key = (cols[0] || '').trim().replace(/^#/, '');
    const id = byNo.get(key) || byAb.get(key);
    if (!id) { if (/^\d+$/.test(key)) bad.push({ line: i + 1, text: line }); else skipped += 1; return; }   // header rows are skipped
    const cell = cols.slice(1).map((c) => c.trim()).filter(Boolean).pop() || '';
    if (SKIP.has(cell.toLowerCase())) { skipped += 1; return; }
    const names = cell.split(/[,/]/).map((n) => normText(n)).filter((n) => !SKIP.has(n.toLowerCase()))
      .map((n) => (stripPrefix ? n.replace(/^[A-Za-z&]+_(?=\S)/, '') : n)).filter(Boolean);
    if (!names.length) { skipped += 1; return; }
    if (map[id]) dup.push({ line: i + 1, text: line });
    map[id] = [...new Set(names)];
  });
  return { map, bad, dup, skipped };
}

// Turns pasted per-item names into an assignment. Sections that have no assignee yet get the most
// common name list of their pasted items as the section default, so only exceptions stay per item.
// Existing section lists are kept; existing item overrides are kept unless the paste names the item.
export function planFromPaste(doc, map) {
  const set = getItemSet(doc.itemSetId);
  const sections = JSON.parse(JSON.stringify(doc.assignment.sections || {}));
  const key = (l) => [...l].sort().join('\u0001');
  const bySec = {};
  for (const [id, names] of Object.entries(map)) (bySec[set.byId[id].section] = bySec[set.byId[id].section] || []).push(names);
  const newDefaults = [];
  for (const [sec, lists] of Object.entries(bySec)) {
    if (sections[sec] && sections[sec].length) continue;
    const c = new Map();
    for (const l of lists) { const k = key(l); const e = c.get(k) || { n: 0, l }; e.n += 1; c.set(k, e); }
    const top = [...c.values()].sort((a, b) => b.n - a.n)[0];
    sections[sec] = top.l;
    newDefaults.push(sec);
  }
  const items = { ...(doc.assignment.items || {}), ...map };
  return { sections, items, newDefaults };
}
