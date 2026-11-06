// Workspace document model and validation (DATA_MODEL §5, §7.1). Pure functions.
import { APP_ID, APP_VERSION, DOC_SCHEMA } from './version.js';
import { uuid, nowISO, normText, isISODate, hashOf } from './util.js';
import { getItemSet } from './itemsets.js';
import { validateAb } from './abexport.js';

export const STATUSES = ['empty', 'draft', 'submitted', 'returned', 'approved', 'entered'];
export const RESULTS = ['yes', 'no', 'na', 'hold'];
export const TEXT_FIELDS = ['process', 'response', 'evidence', 'sample'];
export const MAX_TEXT = 5000;
export const MAX_SHORT = 200;
export const MAX_COMMENT = 2000;
export const COMMENT_KINDS = ['comment', 'return', 'approve', 'unlock', 'reply'];
export const ROLES = ['reviewer', 'preparer'];

const WS_COLORS = ['#2f6f73', '#7a5c2e', '#4f5d8a', '#6b4f72', '#3f6b45', '#8a4f4f', '#4f6f8a', '#6f6a3f'];

export function emptyContent() {
  return { result: null, process: '', response: '', evidence: '', sample: '', remediation: { action: '', owner: '', due: null } };
}

export function emptyItem() {
  return {
    status: 'empty', ...emptyContent(),
    rev: 0, baseRev: 0, syncHash: null,
    updatedAt: null, updatedBy: null,
    submittedAt: null, submittedBy: null,
    reviewedAt: null, reviewedBy: null,
    enteredAt: null, enteredBy: null,
  };
}

// The comparable part of an item. Text is normalized so CRLF/space differences are not changes.
// `process` (preparer's internal description, schema 2) is included only when filled, so the content
// - and every hash made from it (syncHash, final contentHash) - of items without it is unchanged.
export function contentOf(item) {
  const r = item.remediation || {};
  const process = normText(item.process);
  return {
    result: item.result ?? null,
    ...(process ? { process } : {}),
    response: normText(item.response),
    evidence: normText(item.evidence),
    sample: normText(item.sample),
    remediation: { action: normText(r.action), owner: normText(r.owner), due: r.due || null },
  };
}

export function contentHash(item) {
  return hashOf(contentOf(item));
}

export function isAnswered(item) {
  const c = contentOf(item);
  return !!(c.result || c.process || c.response || c.evidence || c.sample || c.remediation.action || c.remediation.owner || c.remediation.due);
}

export function sameContent(a, b) {
  return JSON.stringify(contentOf(a)) === JSON.stringify(contentOf(b));
}

export function createWorkspace({ hotelName, serviceType, year, itemSetId, by, wsId }) {
  const set = getItemSet(itemSetId);
  if (!set) throw new Error('Unknown item set: ' + itemSetId);
  if (set.serviceType !== serviceType || set.year !== year) throw new Error('Item set does not match service type/year');
  const name = String(hotelName || '').trim();
  if (!name) throw new Error('Hotel name is required');
  const id = wsId || uuid();
  const now = nowISO();
  const items = {};
  for (const iid of set.ids) items[iid] = emptyItem();
  return {
    schema: DOC_SCHEMA, app: APP_ID, wsId: id, year, serviceType, itemSetId,
    hotelName: name.slice(0, MAX_SHORT), createdAt: now, createdBy: by, reviewerName: by,
    assignment: { version: 0, updatedAt: now, members: [], sections: {} },
    items, comments: {},
    finalize: { current: null, lastVersion: 0, log: [] },
    saveSeq: 0, savedAt: null, appVersion: APP_VERSION,
    local: { role: 'reviewer', me: by, hidden: false, lastOpenedAt: now, color: colorFor(id) },
  };
}

export function colorFor(wsId) {
  let h = 0;
  for (const ch of String(wsId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return WS_COLORS[h % WS_COLORS.length];
}

export function assignedTo(doc, section) {
  return (doc.assignment && doc.assignment.sections && doc.assignment.sections[section]) || [];
}

export function isAssigned(doc, section, name) {
  return assignedTo(doc, section).includes(name);
}

// ---- validation -------------------------------------------------------------

export function checkItemValue(id, it, errs) {
  if (!it || typeof it !== 'object') { errs.push(`${id}: not an object`); return; }
  if (!STATUSES.includes(it.status)) errs.push(`${id}: bad status`);
  if (it.result !== null && it.result !== undefined && !RESULTS.includes(it.result)) errs.push(`${id}: bad result`);
  for (const f of TEXT_FIELDS) {
    if (typeof (it[f] ?? '') !== 'string') errs.push(`${id}: ${f} not text`);
    else if ((it[f] || '').length > MAX_TEXT) errs.push(`${id}: ${f} too long`);
  }
  const r = it.remediation;
  if (!r || typeof r !== 'object') errs.push(`${id}: remediation missing`);
  else {
    if (typeof (r.action ?? '') !== 'string' || (r.action || '').length > MAX_TEXT) errs.push(`${id}: remediation.action invalid`);
    if (typeof (r.owner ?? '') !== 'string' || (r.owner || '').length > MAX_SHORT) errs.push(`${id}: remediation.owner invalid`);
    if (r.due !== null && r.due !== undefined && !isISODate(r.due)) errs.push(`${id}: remediation.due invalid`);
  }
  for (const k of ['rev', 'baseRev']) {
    if (it[k] !== undefined && (!Number.isInteger(it[k]) || it[k] < 0)) errs.push(`${id}: ${k} invalid`);
  }
}

export function validateComments(comments, set, errs) {
  if (!comments || typeof comments !== 'object') { errs.push('comments missing'); return; }
  for (const [id, list] of Object.entries(comments)) {
    if (!set.byId[id]) { errs.push(`comment for unknown item ${id}`); continue; }
    if (!Array.isArray(list)) { errs.push(`${id}: comments not a list`); continue; }
    for (const c of list) {
      if (!c || typeof c.id !== 'string' || typeof c.text !== 'string' || !COMMENT_KINDS.includes(c.kind)) errs.push(`${id}: bad comment`);
      else if (c.text.length > MAX_COMMENT) errs.push(`${id}: comment too long`);
    }
  }
}

// Returns a list of problems; empty list = valid. `key` is the storage key the doc is saved under.
export function validateDoc(doc, key) {
  const errs = [];
  if (!doc || typeof doc !== 'object') return ['document missing'];
  if (doc.app !== APP_ID) errs.push('app mismatch');
  if (key !== undefined && doc.wsId !== key) errs.push('wsId does not match storage key');
  if (typeof doc.wsId !== 'string' || doc.wsId.length < 8) errs.push('wsId invalid');
  const set = getItemSet(doc.itemSetId);
  if (!set) return errs.concat('unknown item set ' + doc.itemSetId);
  if (set.serviceType !== doc.serviceType || set.year !== doc.year) errs.push('item set does not match service type/year');
  if (!String(doc.hotelName || '').trim()) errs.push('hotel name missing');
  const items = doc.items || {};
  const keys = Object.keys(items);
  const missing = set.ids.filter((id) => !(id in items));
  const extra = keys.filter((id) => !set.byId[id]);
  if (missing.length) errs.push(`missing items: ${missing.length}`);
  if (extra.length) errs.push(`unknown items: ${extra.length}`);
  for (const id of keys) if (set.byId[id]) checkItemValue(id, items[id], errs);
  validateComments(doc.comments, set, errs);
  validateAb(doc.ab, set, errs);
  if (!Number.isInteger(doc.saveSeq) || doc.saveSeq < 0) errs.push('saveSeq invalid');
  return errs;
}

export function answeredCount(doc) {
  return Object.values(doc.items).filter(isAnswered).length;
}

export function resultCount(doc) {
  return Object.values(doc.items).filter((i) => i.result).length;
}
