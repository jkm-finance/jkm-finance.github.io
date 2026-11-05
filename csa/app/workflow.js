// Item states, permissions and transitions (SPEC §4). Pure functions on a cloned document.
// Every mutating function returns { doc, events } and never changes its input.
import { clone, nowISO, uuid, normText, hashOf } from './util.js';
import { contentOf, isAnswered, isAssigned, sameContent, MAX_COMMENT, emptyContent } from './model.js';
import { getItemSet } from './itemsets.js';

const EDITABLE_BY_PREPARER = ['empty', 'draft', 'submitted', 'returned'];

function res(ok, reason) { return { ok, reason: ok ? null : reason }; }

// ctx: { role, status, assigned, answered, hasReason }
export function can(action, ctx) {
  const { role, status } = ctx;
  if (role === 'dof' || role === 'regional') return res(false, 'readonly');
  switch (action) {
    case 'edit':
      if (status === 'entered') return res(false, 'locked');
      if (role === 'reviewer') return res(true);
      if (role === 'preparer') {
        if (!ctx.assigned) return res(false, 'notAssigned');
        return res(EDITABLE_BY_PREPARER.includes(status), 'statusNotEditable');
      }
      return res(false, 'role');
    case 'submit':
      if (role !== 'preparer') return res(false, 'role');
      if (!ctx.answered) return res(false, 'unanswered');
      return res(['draft', 'submitted', 'returned'].includes(status), 'statusNotSubmittable');
    case 'approve':
      if (role !== 'reviewer') return res(false, 'role');
      if (!ctx.hasResult) return res(false, 'noResult');
      return res(['draft', 'submitted', 'returned'].includes(status), 'statusNotApprovable');
    case 'return':
      if (role !== 'reviewer') return res(false, 'role');
      if (!ctx.hasReason) return res(false, 'reasonRequired');
      return res(['draft', 'submitted', 'approved'].includes(status), 'statusNotReturnable');
    case 'enter':
      if (role !== 'reviewer') return res(false, 'role');
      return res(status === 'approved', 'notApproved');
    case 'unlock':
      if (role !== 'reviewer') return res(false, 'role');
      if (!ctx.hasReason) return res(false, 'reasonRequired');
      return res(status === 'entered', 'notLocked');
    case 'comment':
      return res(role === 'reviewer' || role === 'preparer', 'role');
    case 'assign': case 'merge': case 'finalize': case 'exportReview': case 'exportAssignment':
      return res(role === 'reviewer', 'role');
    case 'exportSubmission': case 'importReview':
      return res(role === 'preparer', 'role');
    default:
      return res(false, 'unknownAction');
  }
}

export function itemCtx(doc, id, extra = {}) {
  const set = getItemSet(doc.itemSetId);
  const it = doc.items[id];
  const meta = set.byId[id];
  return {
    role: doc.local.role, status: it.status,
    assigned: doc.local.role === 'reviewer' || isAssigned(doc, meta.section, doc.local.me),
    answered: isAnswered(it), hasResult: !!it.result, ...extra,
  };
}

function ev(doc, action, itemId, detail) {
  return { wsId: doc.wsId, itemId: itemId || null, at: nowISO(), by: doc.local.me, role: doc.local.role, action, detail: detail || null };
}

function bumpRev(doc, it) {
  if (doc.local.role === 'reviewer') it.rev = (it.rev || 0) + 1;
}

// Any change to an approved/entered item's content, result or lock state clears finalization.
function touchFinal(doc, events) {
  if (doc.finalize.current) {
    events.push(ev(doc, 'unfinalize', null, { version: doc.finalize.current.version }));
    doc.finalize.current = null;
  }
}

function assertOk(r) {
  if (!r.ok) { const e = new Error('Not allowed: ' + r.reason); e.code = r.reason; throw e; }
}

// patch: subset of content fields, e.g. { response: '...' } or { remediation: { due: '2026-12-01' } }
export function editItem(doc0, id, patch) {
  assertOk(can('edit', itemCtx(doc0, id)));
  const doc = clone(doc0);
  const it = doc.items[id];
  const before = contentOf(it);
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'remediation') it.remediation = { ...it.remediation, ...v };
    else if (k in emptyContent()) it[k] = v;
  }
  const after = contentOf(it);
  const events = [];
  if (JSON.stringify(before) === JSON.stringify(after)) return { doc: doc0, events };
  const role = doc.local.role;
  if (role === 'preparer') {
    it.status = isAnswered(it) ? 'draft' : 'empty';
  } else if (it.status === 'empty' && isAnswered(it)) {
    it.status = 'draft';
  } else if (it.status === 'draft' && !isAnswered(it)) {
    it.status = 'empty';
  }
  it.updatedAt = nowISO();
  it.updatedBy = doc.local.me;
  bumpRev(doc, it);
  const changed = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  events.push(ev(doc, 'edit', id, { fields: changed, before: pick(before, changed), after: pick(after, changed) }));
  if (['approved', 'entered'].includes(it.status) || changed.includes('result')) touchFinal(doc, events);
  return { doc, events };
}

function pick(o, keys) { return Object.fromEntries(keys.map((k) => [k, o[k]])); }

function setStatus(doc, id, status, events, detail) {
  const it = doc.items[id];
  const from = it.status;
  it.status = status;
  bumpRev(doc, it);
  events.push(ev(doc, 'status', id, { from, to: status, ...(detail || {}) }));
}

export function addComment(doc0, id, text, kind = 'comment') {
  assertOk(can('comment', itemCtx(doc0, id)));
  const t = normText(text);
  if (!t) throw Object.assign(new Error('Empty comment'), { code: 'emptyComment' });
  if (t.length > MAX_COMMENT) throw Object.assign(new Error('Comment too long'), { code: 'commentTooLong' });
  const doc = clone(doc0);
  const c = { id: uuid(), at: nowISO(), by: doc.local.me, role: doc.local.role, kind, text: t };
  (doc.comments[id] = doc.comments[id] || []).push(c);
  return { doc, events: [], comment: c };
}

export function approve(doc0, ids) {
  const doc = clone(doc0);
  const events = [];
  for (const id of ids) {
    assertOk(can('approve', itemCtx(doc, id)));
    setStatus(doc, id, 'approved', events);
    Object.assign(doc.items[id], { reviewedAt: nowISO(), reviewedBy: doc.local.me });
  }
  return { doc, events };
}

export function returnItem(doc0, id, reason) {
  const r = normText(reason);
  assertOk(can('return', itemCtx(doc0, id, { hasReason: !!r })));
  let { doc } = addComment(doc0, id, r, 'return');
  const events = [];
  const wasApproved = doc.items[id].status === 'approved';
  setStatus(doc, id, 'returned', events, { reason: r });
  Object.assign(doc.items[id], { reviewedAt: nowISO(), reviewedBy: doc.local.me });
  if (wasApproved) touchFinal(doc, events);
  return { doc, events };
}

export function markEntered(doc0, ids) {
  const doc = clone(doc0);
  const events = [];
  for (const id of ids) {
    assertOk(can('enter', itemCtx(doc, id)));
    setStatus(doc, id, 'entered', events);
    Object.assign(doc.items[id], { enteredAt: nowISO(), enteredBy: doc.local.me });
  }
  return { doc, events };
}

export function unlock(doc0, id, reason) {
  const r = normText(reason);
  assertOk(can('unlock', itemCtx(doc0, id, { hasReason: !!r })));
  let { doc } = addComment(doc0, id, r, 'unlock');
  const events = [];
  setStatus(doc, id, 'approved', events, { reason: r });
  Object.assign(doc.items[id], { enteredAt: null, enteredBy: null });
  events.push(ev(doc, 'unlock', id, { reason: r }));
  return { doc, events };
}

// Preparer: mark the given items submitted and remember what was sent (syncHash).
export async function markSubmitted(doc0, ids) {
  const doc = clone(doc0);
  const events = [];
  const at = nowISO();
  for (const id of ids) {
    assertOk(can('submit', itemCtx(doc, id)));
    const it = doc.items[id];
    it.status = 'submitted';
    it.submittedAt = at;
    it.submittedBy = doc.local.me;
    it.syncHash = await hashOf(contentOf(it));
    events.push(ev(doc, 'status', id, { to: 'submitted' }));
  }
  return { doc, events };
}

export function setAssignment(doc0, sections) {
  assertOk(can('assign', { role: doc0.local.role }));
  const doc = clone(doc0);
  const clean = {};
  const members = new Set();
  for (const [sec, names] of Object.entries(sections)) {
    const list = [...new Set((names || []).map((n) => normText(n)).filter(Boolean))];
    if (list.length) { clean[sec] = list; list.forEach((n) => members.add(n)); }
  }
  doc.assignment = { version: (doc.assignment.version || 0) + 1, updatedAt: nowISO(), members: [...members].sort(), sections: clean };
  return { doc, events: [ev(doc, 'assign', null, { version: doc.assignment.version, sections: clean })] };
}

// ---- finalization -----------------------------------------------------------

export function finalizeBlockers(doc) {
  const set = getItemSet(doc.itemSetId);
  const out = [];
  for (const meta of set.items) {
    const it = doc.items[meta.id];
    if (!it.result) out.push({ id: meta.id, reason: 'noResult' });
    else if (['draft', 'submitted', 'returned', 'empty'].includes(it.status)) out.push({ id: meta.id, reason: it.status });
  }
  return out;
}

export async function finalize(doc0) {
  assertOk(can('finalize', { role: doc0.local.role }));
  const blockers = finalizeBlockers(doc0);
  if (blockers.length) throw Object.assign(new Error('Cannot finalize'), { code: 'blocked', blockers });
  const doc = clone(doc0);
  const version = (doc.finalize.lastVersion || 0) + 1;
  const items = Object.fromEntries(Object.entries(doc.items).map(([id, it]) => [id, contentOf(it)]));
  const contentHash = await hashOf(items);
  const at = nowISO();
  doc.finalize.current = { version, at, by: doc.local.me, contentHash };
  doc.finalize.lastVersion = version;
  doc.finalize.log.push({ version, at, by: doc.local.me, contentHash });
  return { doc, events: [ev(doc, 'finalize', null, { version, contentHash })] };
}

export { sameContent };
