// Item guidance notes (SPEC §5.5, proposal ⑤): a short reviewer note per item for this workspace
// only (e.g. the team's one-line summary of what to check). Never part of the public item set.
// Pure, so it can be unit-tested in Node.
import { getItemSet } from './itemsets.js';
import { normText } from './util.js';

export const HINT_MAX = 1000;

// Tab-separated text as Excel copies it: cells with line breaks or quotes are wrapped in "…" with "" escapes.
export function parseTsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text || '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Lines: item number (#12 / 12) or AuditBoard ID, then the note (last non-empty cell).
export function parseHintPaste(text, doc) {
  const set = getItemSet(doc.itemSetId);
  const byNo = new Map(set.items.map((m) => [String(m.no), m.id]));
  const byAb = new Map(Object.entries((doc.ab && doc.ab.ids) || {}).map(([id, ab]) => [ab, id]));
  const map = {}, bad = [], dup = [], long = [];
  let skipped = 0;
  parseTsv(text).forEach((cols, i) => {
    const key = String(cols[0] || '').trim().replace(/^#/, '');
    if (!key && cols.every((c) => !String(c).trim())) return;
    const id = byNo.get(key) || byAb.get(key);
    if (!id) { if (/^\d+$/.test(key)) bad.push({ line: i + 1, text: cols.join(' ').slice(0, 80) }); else skipped += 1; return; }
    let note = normText(cols.slice(1).map((c) => String(c).trim()).filter(Boolean).pop() || '');
    if (!note || /^(0|n\/a|-)$/i.test(note)) { skipped += 1; return; }
    if (note.length > HINT_MAX) { long.push(id); note = note.slice(0, HINT_MAX); }
    if (map[id]) dup.push({ line: i + 1, text: note.slice(0, 80) });
    map[id] = note;
  });
  return { map, bad, dup, long, skipped };
}

export function validateHints(hints, set, errs) {
  if (hints === undefined || hints === null) return;
  if (typeof hints !== 'object' || Array.isArray(hints)) { errs.push('hints invalid'); return; }
  for (const [id, v] of Object.entries(hints)) {
    if (!set.byId[id]) errs.push(`hints: unknown item ${id}`);
    else if (typeof v !== 'string' || !v.trim() || v.length > HINT_MAX) errs.push(`hints: ${id} invalid`);
  }
}

export function hintOf(doc, id) {
  return (doc && doc.hints && doc.hints[id]) || '';
}
