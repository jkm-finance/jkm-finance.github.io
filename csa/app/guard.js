// Data-loss guards and document migrations (DATA_MODEL §7.3, §10). Pure functions.
import { DOC_SCHEMA } from './version.js';
import { clone } from './util.js';
import { answeredCount, resultCount } from './model.js';

export const SHRINK_MIN_ITEMS = 10;   // more than this many items lost ...
export const SHRINK_MIN_RATIO = 0.2;  // ... and more than this share of them

function dropped(prev, next) {
  return prev - next > SHRINK_MIN_ITEMS && (prev - next) / prev > SHRINK_MIN_RATIO;
}

// Returns null when the save is safe, otherwise details for the confirmation dialog.
export function detectShrink(prevDoc, nextDoc) {
  if (!prevDoc) return null;
  const pa = answeredCount(prevDoc), na = answeredCount(nextDoc);
  const pr = resultCount(prevDoc), nr = resultCount(nextDoc);
  if (!dropped(pa, na) && !dropped(pr, nr)) return null;
  const lost = Object.keys(prevDoc.items).filter((id) => {
    const a = prevDoc.items[id], b = nextDoc.items[id];
    return (a.result && !b.result) || (a.response && !b.response) || (a.evidence && !b.evidence) || (a.sample && !b.sample);
  });
  return { answeredBefore: pa, answeredAfter: na, resultsBefore: pr, resultsAfter: nr, lost };
}

// Ordered migrations: MIGRATIONS[n] turns schema n into n + 1. Schema 0 is a test-only
// predecessor (items without baseRev/syncHash) used to prove the mechanism works.
export const MIGRATIONS = {
  0: (d) => {
    for (const it of Object.values(d.items || {})) {
      if (it.baseRev === undefined) it.baseRev = 0;
      if (it.syncHash === undefined) it.syncHash = null;
      if (it.rev === undefined) it.rev = 0;
    }
    d.schema = 1;
    return d;
  },
  // 1 -> 2: preparer's internal description (`process`) separated from the AuditBoard Response.
  // Existing Response text stays where it is; nothing is moved or guessed.
  1: (d) => {
    for (const it of Object.values(d.items || {})) if (it.process === undefined) it.process = '';
    d.schema = 2;
    return d;
  },
  // 2 -> 3: per-item assignees (`assignment.items`). Absent = section assignment only, so nothing to add;
  // the bump makes older apps refuse the document instead of dropping item assignments on save.
  2: (d) => {
    d.schema = 3;
    return d;
  },
};

export function needsMigration(doc) {
  return Number.isInteger(doc.schema) && doc.schema < DOC_SCHEMA;
}

export function isTooNew(doc) {
  return !Number.isInteger(doc.schema) || doc.schema > DOC_SCHEMA;
}

export function migrate(doc0) {
  if (isTooNew(doc0)) throw Object.assign(new Error('Document is newer than this app'), { code: 'newerSchema' });
  let d = clone(doc0);
  const applied = [];
  while (d.schema < DOC_SCHEMA) {
    const step = MIGRATIONS[d.schema];
    if (!step) throw Object.assign(new Error('No migration from schema ' + d.schema), { code: 'noMigration' });
    const from = d.schema;
    d = step(d);
    applied.push(`${from}->${d.schema}`);
  }
  return { doc: d, applied };
}

// ---- retention (DATA_MODEL §8) -------------------------------------------------

export const RETAIN_DAYS = 30;
export const RETAIN_RECENT = 50;
const DAY = 86400000;

// snaps: [{ id, at }] for ONE workspace. Returns ids to delete.
// Keep: within 30 days the newest 50 plus the newest of each day; always the newest one overall.
export function snapsToDelete(snaps, nowMs = Date.now()) {
  const sorted = [...snaps].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const keep = new Set();
  if (sorted[0]) keep.add(sorted[0].id);
  const seenDay = new Set();
  let recent = 0;
  for (const s of sorted) {
    const t = Date.parse(s.at);
    if (nowMs - t > RETAIN_DAYS * DAY) continue;
    if (recent < RETAIN_RECENT) { keep.add(s.id); recent += 1; }
    const day = s.at.slice(0, 10);
    if (!seenDay.has(day)) { keep.add(s.id); seenDay.add(day); }
  }
  return sorted.filter((s) => !keep.has(s.id)).map((s) => s.id);
}

// Auto-backup files in a folder that may also hold other hotels' and other people's files.
// Only names that exactly match this workspace's pattern are ever candidates for deletion.
export function backupPattern(year, shortId) {
  return new RegExp(String.raw`^CSA${year}_[^\\/]+_(Full|Focus)_${shortId}_(\d{4}-\d{2}-\d{2})\.json$`);
}

export function backupsToDelete(names, year, shortId, todayISO) {
  const re = backupPattern(year, shortId);
  const limit = Date.parse(todayISO + 'T00:00:00Z') - RETAIN_DAYS * DAY;
  return names.filter((n) => {
    const m = re.exec(n);
    return m && Date.parse(m[2] + 'T00:00:00Z') < limit;
  });
}
