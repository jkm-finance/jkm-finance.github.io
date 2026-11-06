// Exchanged files: building and verifying (DATA_MODEL §9). Pure functions, no DOM.
import { APP_VERSION, FILE_FORMAT, FILE_SCHEMA } from './version.js';
import { nowISO, hashOf, clone, fileSafe, canonicalJSON } from './util.js';
import { getItemSet } from './itemsets.js';
import { validatePrior, priorForFile } from './prior.js';
import { validateHints } from './hints.js';
import { contentOf, emptyItem, checkItemValue, validateComments, isAnswered, validateDoc, isItemAssigned, hasItemsIn, validateAssignment } from './model.js';
import { finalSummary } from './summary.js';
import { needsMigration, isTooNew, migrate } from './guard.js';

export const KINDS = ['assignment', 'submission', 'review', 'final', 'backup'];
const SUBMITTABLE = ['draft', 'submitted', 'returned'];
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DEPTH = 12;

// Which kinds each screen may open (DATA_MODEL §9.7, step 5).
export const ALLOWED = {
  start: ['assignment', 'backup', 'final'],
  reviewer: ['submission', 'backup'],
  preparer: ['assignment', 'review', 'backup'],
  regional: ['final'],
  dof: ['final'],
};

export class FileError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail || null; }
}

function workspaceRef(doc) {
  return { wsId: doc.wsId, hotelName: doc.hotelName, serviceType: doc.serviceType, year: doc.year, itemSetId: doc.itemSetId };
}

export async function buildFile(kind, doc, payload, by) {
  if (!KINDS.includes(kind)) throw new Error('unknown kind');
  const p = clone(payload);
  return {
    format: FILE_FORMAT, kind, schema: FILE_SCHEMA, appVersion: APP_VERSION,
    createdAt: nowISO(), createdBy: by || doc.local?.me || '',
    workspace: workspaceRef(doc), payload: p,
    checksum: await hashOf(p),
  };
}

export function fileName(kind, doc, extra) {
  const svc = doc.serviceType === 'full' ? 'Full' : 'Focus';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const base = `CSA${doc.year}_${fileSafe(doc.hotelName)}_${svc}`;
  switch (kind) {
    case 'assignment': return `${base}_ASSIGN_v${doc.assignment.version}${extra ? '_' + fileSafe(extra, 30) : ''}_${stamp}.json`;
    case 'submission': return `${base}_SUBMIT_${fileSafe(extra || '', 60)}_${stamp}.json`;
    case 'review': return `${base}_REVIEW_${stamp}.json`;
    case 'final': return `${base}_FINAL_v${extra}_${stamp.slice(0, 8)}.json`;
    case 'backup': return `${base}_${doc.wsId.slice(0, 6)}_BACKUP_${stamp}.json`;
    default: return `${base}_${stamp}.json`;
  }
}

// ---- payload builders --------------------------------------------------------

function masterItem(it) {
  return { ...contentOf(it), status: it.status, rev: it.rev || 0, reviewedAt: it.reviewedAt, reviewedBy: it.reviewedBy, enteredAt: it.enteredAt, enteredBy: it.enteredBy, submittedBy: it.submittedBy, updatedBy: it.updatedBy, updatedAt: it.updatedAt };
}

export function assignmentPayload(doc) {
  return {
    reviewerName: doc.reviewerName, assignment: doc.assignment, prior: priorForFile(doc), hints: doc.hints,
    master: { items: Object.fromEntries(Object.entries(doc.items).map(([id, it]) => [id, masterItem(it)])), comments: doc.comments },
  };
}

export function reviewPayload(doc) {
  return {
    reviewerName: doc.reviewerName, assignment: doc.assignment, prior: priorForFile(doc), hints: doc.hints,
    items: Object.fromEntries(Object.entries(doc.items).map(([id, it]) => [id, masterItem(it)])),
    comments: doc.comments,
  };
}

// The preparer's own items: assigned to them, or last edited by them (work done before a reassignment).
// Items of the same section that belong to someone else are never sent (schema 3, per-item assignees).
export function isMine(doc, meta) {
  const it = doc.items[meta.id];
  return isItemAssigned(doc, meta.id, doc.local.me, meta.section) || it.updatedBy === doc.local.me;
}

// Preparer: answered, not yet approved items of the chosen sections. Caller marks them submitted afterwards.
export function submissionPayload(doc, sections) {
  const set = getItemSet(doc.itemSetId);
  const items = {};
  const comments = {};
  for (const meta of set.items) {
    if (!sections.includes(meta.section) || !isMine(doc, meta)) continue;
    const it = doc.items[meta.id];
    if (!isAnswered(it) || !SUBMITTABLE.includes(it.status)) continue;
    items[meta.id] = { ...contentOf(it), baseRev: it.baseRev || 0, submittedAt: nowISO() };
    const mine = (doc.comments[meta.id] || []).filter((c) => c.by === doc.local.me);
    if (mine.length) comments[meta.id] = mine;
  }
  return { submitter: doc.local.me, assignmentVersion: doc.assignment.version, sections: [...sections], items, comments };
}

// Pre-submit checks shown to the preparer (SPEC §6.3). Pure: returns item metas / section names.
export function submissionCheck(doc, sections) {
  const set = getItemSet(doc.itemSetId);
  const inSecs = set.items.filter((i) => sections.includes(i.section) && isMine(doc, i));
  return {
    unanswered: inSecs.filter((i) => !doc.items[i.id].result),
    noPlan: inSecs.filter((i) => doc.items[i.id].result === 'no' && !(doc.items[i.id].remediation.action || '').trim()),
    outside: sections.filter((sec) => !hasItemsIn(doc, sec, doc.local.me)),
  };
}

export async function finalPayload(doc) {
  const cur = doc.finalize.current;
  if (!cur) throw new Error('not finalized');
  const items = Object.fromEntries(Object.entries(doc.items).map(([id, it]) => [id, { ...contentOf(it), status: it.status, enteredAt: it.enteredAt }]));
  return {
    finalVersion: cur.version, finalizedAt: cur.at, finalizedBy: cur.by, contentHash: cur.contentHash,
    items, summary: finalSummary(items, doc.itemSetId), prior: priorForFile(doc),
  };
}

export function backupPayload(doc, history) {
  const d = clone(doc);
  const role = d.local?.role || 'reviewer';
  delete d.local;
  return { doc: d, history: history || [], role };
}

// ---- reading and verification ------------------------------------------------

function depth(v, d = 0) {
  if (d > MAX_DEPTH) return d;
  if (v && typeof v === 'object') {
    let m = d;
    for (const x of Object.values(v)) { m = Math.max(m, depth(x, d + 1)); if (m > MAX_DEPTH) break; }
    return m;
  }
  return d;
}

export function parseFileText(text) {
  if (typeof text !== 'string') throw new FileError('corrupt');
  if (text.length > MAX_FILE_BYTES) throw new FileError('tooLarge');
  let obj;
  try { obj = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new FileError('corrupt'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new FileError('corrupt');
  if (depth(obj) > MAX_DEPTH) throw new FileError('corrupt');
  return obj;
}

function checkItems(items, set, { requireAll = false, withStatus = false } = {}) {
  if (!items || typeof items !== 'object' || Array.isArray(items)) throw new FileError('badPayload');
  const unknown = Object.keys(items).filter((id) => !set.byId[id]);
  if (unknown.length) throw new FileError('unknownItems', unknown.length);
  if (requireAll && set.ids.some((id) => !(id in items))) throw new FileError('badPayload', 'missing items');
  const errs = [];
  for (const [id, v] of Object.entries(items)) {
    if (!v || typeof v !== 'object') { errs.push(id); continue; }
    const probe = { ...emptyItem(), ...v, status: withStatus ? v.status : 'draft', rev: v.rev ?? 0, baseRev: v.baseRev ?? 0 };
    checkItemValue(id, probe, errs);
  }
  if (errs.length) throw new FileError('badValues', errs.slice(0, 5).join('; '));
}

function checkAssignment(a, set) {
  const errs = [];
  validateAssignment(a, set, errs);
  if (errs.length) throw new FileError('badValues', errs.slice(0, 5).join('; '));
}

function checkComments(comments, set) {
  if (comments === undefined) return;
  const errs = [];
  validateComments(comments, set, errs);
  if (errs.length) throw new FileError('badValues', errs.slice(0, 5).join('; '));
}

// ctx: { mode: 'start'|'reviewer'|'preparer'|'regional'|'dof', doc? }
// Returns the file object if valid; throws FileError otherwise. Never asks to "proceed anyway".
export async function verifyFile(obj, ctx) {
  if (obj.format !== FILE_FORMAT) throw new FileError('notCsa');
  if (!Number.isInteger(obj.schema)) throw new FileError('corrupt');
  if (obj.schema > FILE_SCHEMA) throw new FileError('newerSchema');
  if (!obj.payload || typeof obj.payload !== 'object') throw new FileError('corrupt');
  if (obj.checksum !== (await hashOf(obj.payload))) throw new FileError('checksum');
  if (!KINDS.includes(obj.kind)) throw new FileError('unknownKind');
  if (!(ALLOWED[ctx.mode] || []).includes(obj.kind)) throw new FileError('kindNotAllowed', obj.kind);
  const w = obj.workspace;
  if (!w || typeof w.wsId !== 'string' || !w.itemSetId) throw new FileError('corrupt');
  const set = getItemSet(w.itemSetId);
  if (!set) throw new FileError('unknownItemSet', w.itemSetId);
  if (set.serviceType !== w.serviceType || set.year !== w.year) throw new FileError('corrupt');
  if (ctx.doc) {
    const d = ctx.doc;
    if (w.wsId !== d.wsId) throw new FileError('otherWorkspace');
    if (w.serviceType !== d.serviceType || w.year !== d.year || w.itemSetId !== d.itemSetId) throw new FileError('typeMismatch');
  }
  const p = obj.payload;
  if (p.prior !== undefined && ['assignment', 'review', 'final'].includes(obj.kind)) {
    const errs = [];
    validatePrior(p.prior, set, errs, { year: w.year });
    if (errs.length) throw new FileError('badValues', errs.slice(0, 5).join('; '));
  }
  if (p.hints !== undefined && ['assignment', 'review'].includes(obj.kind)) {
    const errs = [];
    validateHints(p.hints, set, errs);
    if (errs.length) throw new FileError('badValues', errs.slice(0, 5).join('; '));
  }
  switch (obj.kind) {
    case 'submission':
      if (typeof p.submitter !== 'string' || !Array.isArray(p.sections)) throw new FileError('badPayload');
      checkItems(p.items, set);
      checkComments(p.comments, set);
      for (const [id, v] of Object.entries(p.items)) {
        if (!p.sections.includes(set.byId[id].section)) throw new FileError('badPayload', 'item outside listed sections');
        if (!Number.isInteger(v.baseRev) || v.baseRev < 0) throw new FileError('badValues', id + ': baseRev');
      }
      break;
    case 'assignment':
      if (!p.assignment || !p.master) throw new FileError('badPayload');
      checkAssignment(p.assignment, set);
      checkItems(p.master.items, set, { requireAll: true, withStatus: true });
      checkComments(p.master.comments, set);
      break;
    case 'review':
      if (!p.assignment) throw new FileError('badPayload');
      checkAssignment(p.assignment, set);
      checkItems(p.items, set, { requireAll: true, withStatus: true });
      checkComments(p.comments, set);
      break;
    case 'final': {
      checkItems(p.items, set, { requireAll: true, withStatus: true });
      if (!Number.isInteger(p.finalVersion) || p.finalVersion < 1) throw new FileError('badPayload');
      const items = Object.fromEntries(Object.entries(p.items).map(([id, v]) => [id, contentOf(v)]));
      if (p.contentHash !== (await hashOf(items))) throw new FileError('summaryMismatch');
      const again = finalSummary(p.items, w.itemSetId);
      // Key order may differ between app versions (e.g. section order); compare canonically.
      if (canonicalJSON(again) !== canonicalJSON(p.summary)) throw new FileError('summaryMismatch');
      break;
    }
    case 'backup': {
      if (!p.doc) throw new FileError('badPayload');
      if (p.doc.wsId !== w.wsId) throw new FileError('corrupt');
      // Backups written by an older app carry an older doc schema: migrate a copy, then
      // validate the migrated doc. The checksum above was verified on the original payload.
      if (isTooNew(p.doc)) throw new FileError('newerSchema');
      if (needsMigration(p.doc)) {
        let m;
        try { m = migrate(p.doc); } catch { throw new FileError('corrupt'); }
        obj = { ...obj, payload: { ...p, doc: m.doc }, migrated: m.applied };
      }
      const probe = { ...obj.payload.doc, local: {} };
      const errs = validateDoc(probe, w.wsId);
      if (errs.length) throw new FileError('badValues', errs.slice(0, 5).join('; '));
      if (!Array.isArray(p.history)) throw new FileError('badPayload');
      break;
    }
  }
  return obj;
}

export async function readAndVerify(text, ctx) {
  return verifyFile(parseFileText(text), ctx);
}
