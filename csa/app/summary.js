// Scores and progress (SPEC §5.3). Same formulas as the CPA dashboard.
import { getItemSet } from './itemsets.js';
import { itemAssignees } from './model.js';

function blank() {
  return { total: 0, yes: 0, no: 0, na: 0, hold: 0, unanswered: 0 };
}

function add(acc, result) {
  acc.total += 1;
  if (result && acc[result] !== undefined) acc[result] += 1;
  else acc.unanswered += 1;
}

export function score(c) {
  const d = c.yes + c.no;
  return d === 0 ? null : Math.round((c.yes / d) * 1000) / 10;
}

export function progress(c) {
  return c.total === 0 ? 0 : (c.yes + c.no + c.na) / c.total;
}

// items: { id: { result, status, ... } }
export function summarize(items, itemSetId) {
  const set = getItemSet(itemSetId);
  if (!set) throw new Error('Unknown item set: ' + itemSetId);
  const all = blank();
  const byRisk = { Key: blank(), HR: blank(), MR: blank() };
  const bySection = Object.fromEntries(set.sections.map((s) => [s, blank()]));
  const byStatus = { empty: 0, draft: 0, submitted: 0, returned: 0, approved: 0, entered: 0 };
  for (const meta of set.items) {
    const it = items[meta.id] || {};
    const r = it.result || null;
    add(all, r);
    add(byRisk[meta.risk], r);
    add(bySection[meta.section], r);
    if (byStatus[it.status] !== undefined) byStatus[it.status] += 1;
  }
  const withScore = (c) => ({ ...c, score: score(c), progress: progress(c) });
  return {
    total: all.total,
    answered: all.total - all.unanswered,
    counts: { yes: all.yes, no: all.no, na: all.na, hold: all.hold },
    score: score(all),
    progress: progress(all),
    byRisk: Object.fromEntries(Object.entries(byRisk).map(([k, v]) => [k, withScore(v)])),
    bySection: Object.fromEntries(Object.entries(bySection).map(([k, v]) => [k, withScore(v)])),
    byStatus,
    reviewProgress: all.total ? (byStatus.approved + byStatus.entered) / all.total : 0,
    enteredRate: all.total ? byStatus.entered / all.total : 0,
  };
}

// Compact summary stored in final files (DATA_MODEL §9.5); compared on open.
export function finalSummary(items, itemSetId) {
  const s = summarize(items, itemSetId);
  return {
    total: s.total, answered: s.answered, counts: s.counts, score: s.score,
    byRisk: Object.fromEntries(Object.entries(s.byRisk).map(([k, v]) => [k, v.score])),
    bySection: Object.fromEntries(Object.entries(s.bySection).map(([k, v]) => [k, { yes: v.yes, no: v.no, na: v.na, hold: v.hold, score: v.score }])),
    enteredRate: Math.round(s.enteredRate * 1000) / 1000,
  };
}

export function perAssignee(doc) {
  const set = getItemSet(doc.itemSetId);
  const out = {};
  for (const meta of set.items) {
    const it = doc.items[meta.id];
    for (const n of itemAssignees(doc, meta.id, meta.section)) {
      out[n] = out[n] || { total: 0, done: 0, submitted: 0, returned: 0 };
      out[n].total += 1;
      if (it.result) out[n].done += 1;
      if (['submitted', 'approved', 'entered'].includes(it.status)) out[n].submitted += 1;
      if (it.status === 'returned') out[n].returned += 1;
    }
  }
  return out;
}
