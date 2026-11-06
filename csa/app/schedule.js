// Stage schedule, daily progress rows (SPEC §5.6, proposal ⑥). Pure, so it can be unit-tested in Node.
import { isISODate } from './util.js';
import { getItemSet } from './itemsets.js';

// The team's 2026 plan: distribute -> draft -> evidence -> first review -> Manager interview -> DOF/ADOF review -> final.
export const STAGE_KEYS = ['distribute', 'draft', 'evidence', 'review1', 'interview', 'dofReview', 'final'];
const LABEL_MAX = 80;
export const PROGRESS_KEEP = 366;

export function emptySchedule() {
  return { stages: STAGE_KEYS.map((key) => ({ key, label: '', due: null, done: null })) };
}

export function validateSchedule(s, errs) {
  if (s === undefined || s === null) return;
  if (typeof s !== 'object' || !Array.isArray(s.stages) || s.stages.length > 15) { errs.push('schedule invalid'); return; }
  s.stages.forEach((st, i) => {
    if (!st || typeof st.key !== 'string' || !st.key || st.key.length > 30) errs.push(`schedule.stages[${i}] key`);
    else if (typeof (st.label ?? '') !== 'string' || (st.label || '').length > LABEL_MAX) errs.push(`schedule.stages[${i}] label`);
    else if ((st.due !== null && st.due !== undefined && !isISODate(st.due)) || (st.done !== null && st.done !== undefined && !isISODate(st.done))) errs.push(`schedule.stages[${i}] date`);
  });
}

const dayMs = (iso) => Date.parse(iso + 'T00:00:00Z');
export const daysBetween = (from, to) => Math.round((dayMs(to) - dayMs(from)) / 86400000);

// Stages with a due date that are not done, in due order, with days left (negative = overdue).
export function openStages(schedule, today) {
  if (!schedule) return [];
  return schedule.stages.filter((s) => s.due && !s.done).map((s) => ({ ...s, days: daysBetween(today, s.due) }))
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}

// ---- daily progress (reviewer's workspace only) ----------------------------------------------

export function progressRow(doc, date) {
  const set = getItemSet(doc.itemSetId);
  const r = { d: date, yes: 0, no: 0, na: 0, hold: 0, answered: 0, approved: 0, entered: 0 };
  for (const id of set.ids) {
    const it = doc.items[id];
    if (it.result) { r[it.result] += 1; r.answered += 1; }
    if (it.status === 'approved') r.approved += 1;
    if (it.status === 'entered') { r.entered += 1; r.approved += 1; }
  }
  return r;
}

const sameRow = (a, b) => a && b && ['d', 'yes', 'no', 'na', 'hold', 'answered', 'approved', 'entered'].every((k) => a[k] === b[k]);

// Returns the same doc when nothing changed; otherwise a shallow copy whose `progress` ends with
// today's row (one row per day, replaced during the day). Only the newest PROGRESS_KEEP days are kept.
export function withProgress(doc, date) {
  if (!doc || !doc.local || doc.local.role !== 'reviewer') return doc;
  const row = progressRow(doc, date);
  const list = Array.isArray(doc.progress) ? doc.progress : [];
  const last = list[list.length - 1];
  if (sameRow(last, row)) return doc;
  const next = last && last.d === date ? [...list.slice(0, -1), row] : [...list, row];
  return { ...doc, progress: next.slice(-PROGRESS_KEEP) };
}

export function validateProgress(list, errs) {
  if (list === undefined) return;
  if (!Array.isArray(list) || list.length > PROGRESS_KEEP) { errs.push('progress invalid'); return; }
  for (const r of list) {
    if (!r || !isISODate(r.d) || ['yes', 'no', 'na', 'hold', 'answered', 'approved', 'entered'].some((k) => !Number.isInteger(r[k]) || r[k] < 0)) { errs.push('progress row invalid'); return; }
  }
}

// Rows with the change from the previous row, newest first.
export function progressDiffs(list, n = 14) {
  const out = [];
  for (let i = (list || []).length - 1; i >= 0 && out.length < n; i--) {
    const r = list[i], p = list[i - 1];
    const diff = {};
    if (p) for (const k of ['yes', 'no', 'na', 'hold', 'answered', 'approved']) if (r[k] !== p[k]) diff[k] = r[k] - p[k];
    out.push({ ...r, diff });
  }
  return out;
}
