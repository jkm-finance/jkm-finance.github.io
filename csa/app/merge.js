// Merging exchanged files into a workspace (SPEC §6.2, §7). Pure functions.
// Files passed in here must already have passed files.verifyFile().
import { clone, nowISO, hashOf } from './util.js';
import { getItemSet } from './itemsets.js';
import { contentOf, emptyItem, isAnswered, isItemAssigned, colorFor } from './model.js';
import { APP_ID, APP_VERSION, DOC_SCHEMA } from './version.js';

const key = (c) => JSON.stringify(contentOf(c));

function ev(doc, action, itemId, detail) {
  return { wsId: doc.wsId, itemId: itemId || null, at: nowISO(), by: doc.local.me, role: doc.local.role, action, detail: detail || null };
}

function mergeComments(target, incoming) {
  let added = 0;
  for (const [id, list] of Object.entries(incoming || {})) {
    const cur = (target[id] = target[id] || []);
    const seen = new Set(cur.map((c) => c.id));
    for (const c of list) if (!seen.has(c.id)) { cur.push(clone(c)); seen.add(c.id); added += 1; }
    cur.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
  return added;
}

// ---- reviewer: submissions ---------------------------------------------------

// Returns a plan: per-item decisions and per-file counts. Nothing is changed.
export function previewSubmissions(doc, files) {
  if (doc.local.role !== 'reviewer') throw new Error('Only the reviewer merges submissions');
  const set = getItemSet(doc.itemSetId);
  const byItem = {};
  files.forEach((f, fi) => {
    for (const [id, v] of Object.entries(f.payload.items)) {
      (byItem[id] = byItem[id] || []).push({ fi, content: contentOf(v), baseRev: v.baseRev, submitter: f.payload.submitter, submittedAt: v.submittedAt });
    }
  });
  const fileStats = files.map((f) => ({
    submitter: f.payload.submitter, sections: f.payload.sections, createdAt: f.createdAt,
    assignmentVersion: f.payload.assignmentVersion, staleAssignment: (f.payload.assignmentVersion || 0) < (doc.assignment.version || 0),
    total: Object.keys(f.payload.items).length, new: 0, changed: 0, same: 0, conflict: 0, rejected: 0, outside: 0,
  }));
  const decisions = {};
  for (const id of set.ids) {
    const entries = byItem[id];
    if (!entries) continue;
    const cur = doc.items[id];
    const section = set.byId[id].section;
    const outside = entries.filter((e) => !isItemAssigned(doc, id, e.submitter, section)).map((e) => e.fi);
    outside.forEach((fi) => { fileStats[fi].outside += 1; });
    let type;
    if (cur.status === 'entered') {
      type = 'rejected';
    } else {
      const distinct = [...new Set(entries.map((e) => key(e.content)))];
      const curKey = key(cur);
      if (distinct.length > 1) type = 'conflict';
      else if (distinct[0] === curKey) type = 'same';
      else if (cur.status === 'approved') type = 'conflict';
      else if (entries.some((e) => (cur.rev || 0) > e.baseRev)) type = 'conflict';
      else type = isAnswered(cur) ? 'changed' : 'new';
    }
    const statKey = type === 'changed' || type === 'new' ? type : type;
    entries.forEach((e) => { fileStats[e.fi][statKey] += 1; });
    decisions[id] = {
      id, type, section, outside,
      candidates: [{ source: 'master', content: contentOf(cur), status: cur.status, rev: cur.rev || 0 }]
        .concat(entries.map((e) => ({ source: e.fi, content: e.content, submitter: e.submitter, baseRev: e.baseRev, submittedAt: e.submittedAt }))),
    };
  }
  const conflicts = Object.values(decisions).filter((d) => d.type === 'conflict').map((d) => d.id);
  return { decisions, fileStats, conflicts };
}

// choices: { resolutions: { [id]: 'master' | fileIndex }, includeOutside: { [id]: true } }
export function applySubmissions(doc0, files, plan, choices = {}) {
  const res = choices.resolutions || {};
  const incOut = choices.includeOutside || {};
  const missing = plan.conflicts.filter((id) => res[id] === undefined);
  if (missing.length) throw Object.assign(new Error('Unresolved conflicts'), { code: 'unresolved', ids: missing });
  const doc = clone(doc0);
  const events = [];
  const at = nowISO();
  const summary = { applied: 0, same: 0, keptMaster: 0, rejected: 0, skippedOutside: 0 };
  for (const d of Object.values(plan.decisions)) {
    const it = doc.items[d.id];
    if (d.type === 'rejected') { summary.rejected += 1; continue; }
    // An item counts as "outside" only if every file that carries it is outside the assignment.
    const fromFiles = d.candidates.filter((c) => c.source !== 'master');
    const allOutside = fromFiles.every((c) => d.outside.includes(c.source));
    if (allOutside && !incOut[d.id]) { summary.skippedOutside += 1; continue; }
    let pickSrc;
    if (d.type === 'conflict') pickSrc = res[d.id];
    else if (d.type === 'same') pickSrc = 'same';
    else pickSrc = fromFiles.find((c) => !d.outside.includes(c.source) || incOut[d.id]).source;
    if (pickSrc === 'master') {
      summary.keptMaster += 1;
      events.push(ev(doc, 'conflict-resolve', d.id, { chosen: 'master', rejected: fromFiles.map((c) => ({ submitter: c.submitter, content: c.content })) }));
      continue;
    }
    if (pickSrc === 'same') {
      summary.same += 1;
      if (!['approved', 'submitted'].includes(it.status)) {
        const sub = fromFiles[0];
        Object.assign(it, { status: 'submitted', submittedAt: sub.submittedAt || at, submittedBy: sub.submitter, rev: (it.rev || 0) + 1 });
        events.push(ev(doc, 'status', d.id, { to: 'submitted', via: 'merge' }));
      }
      continue;
    }
    const chosen = d.candidates.find((c) => c.source === pickSrc);
    if (!chosen) throw new Error('Bad resolution for ' + d.id);
    const before = contentOf(it);
    Object.assign(it, { process: '' }, clone(chosen.content), {
      status: 'submitted', submittedAt: chosen.submittedAt || at, submittedBy: chosen.submitter,
      updatedAt: at, updatedBy: chosen.submitter, rev: (it.rev || 0) + 1,
    });
    summary.applied += 1;
    const rejected = fromFiles.filter((c) => c.source !== pickSrc).map((c) => ({ submitter: c.submitter, content: c.content }));
    if (d.type === 'conflict') rejected.push({ submitter: 'master', content: before });
    events.push(ev(doc, d.type === 'conflict' ? 'conflict-resolve' : 'merge', d.id, { chosen: chosen.submitter, before, after: chosen.content, rejected: rejected.length ? rejected : undefined }));
  }
  for (const f of files) mergeComments(doc.comments, f.payload.comments);
  if (doc.finalize.current && (summary.applied || summary.same)) {
    events.push(ev(doc, 'unfinalize', null, { version: doc.finalize.current.version }));
    doc.finalize.current = null;
  }
  events.push(ev(doc, 'merge', null, { files: files.map((f) => ({ submitter: f.payload.submitter, createdAt: f.createdAt, sections: f.payload.sections })), summary }));
  return { doc, events, summary };
}

// ---- preparer: assignment and review results ----------------------------------

// Take the reviewer's version of an item unless the preparer has unsent local changes.
async function takeMaster(it, m, { forceIfLocked = true } = {}) {
  const localHash = await hashOf(contentOf(it));
  const unsynced = isAnswered(it) && it.syncHash !== localHash;
  const locked = m.status === 'entered';
  if (unsynced && !(forceIfLocked && locked)) {
    it.masterStatus = m.status;
    it.differsFromMaster = key(it) !== key(m);
    return 'keptLocal';
  }
  Object.assign(it, { process: '' }, contentOf(m), {
    status: m.status, rev: m.rev || 0, baseRev: m.rev || 0,
    reviewedAt: m.reviewedAt || null, reviewedBy: m.reviewedBy || null,
    enteredAt: m.enteredAt || null, enteredBy: m.enteredBy || null,
    submittedBy: m.submittedBy || it.submittedBy || null,
    updatedAt: m.updatedAt || it.updatedAt, updatedBy: m.updatedBy || it.updatedBy,
  });
  it.syncHash = await hashOf(contentOf(it));
  it.masterStatus = m.status;
  it.differsFromMaster = false;
  return unsynced ? 'forcedLocked' : 'tookMaster';
}

export async function applyReview(doc0, file) {
  if (doc0.local.role !== 'preparer') throw new Error('Only a preparer applies review results');
  const doc = clone(doc0);
  const p = file.payload;
  const counts = { tookMaster: 0, keptLocal: 0, forcedLocked: 0, returned: [] };
  for (const [id, m] of Object.entries(p.items)) {
    const r = await takeMaster(doc.items[id], m);
    counts[r] += 1;
    if (m.status === 'returned') counts.returned.push(id);
  }
  doc.assignment = clone(p.assignment);
  doc.reviewerName = p.reviewerName || doc.reviewerName;
  const added = mergeComments(doc.comments, p.comments);
  const events = [ev(doc, 'import', null, { kind: 'review', createdAt: file.createdAt, counts: { ...counts, returned: counts.returned.length }, comments: added })];
  return { doc, events, counts };
}

// Re-applying an assignment file to an existing preparer workspace: assignment always,
// item content only where the preparer has no unsent changes.
export async function applyAssignment(doc0, file) {
  const doc = clone(doc0);
  const p = file.payload;
  const counts = { tookMaster: 0, keptLocal: 0, forcedLocked: 0 };
  for (const [id, m] of Object.entries(p.master.items)) counts[await takeMaster(doc.items[id], m)] += 1;
  doc.assignment = clone(p.assignment);
  doc.reviewerName = p.reviewerName || doc.reviewerName;
  mergeComments(doc.comments, p.master.comments);
  return { doc, events: [ev(doc, 'import', null, { kind: 'assignment', version: p.assignment.version, counts })], counts };
}

// New preparer workspace from an assignment file (same wsId as the reviewer's).
export async function workspaceFromAssignment(file, me) {
  const w = file.workspace;
  const set = getItemSet(w.itemSetId);
  const items = {};
  for (const id of set.ids) items[id] = emptyItem();
  const doc = {
    schema: DOC_SCHEMA, app: APP_ID, wsId: w.wsId, year: w.year, serviceType: w.serviceType, itemSetId: w.itemSetId,
    hotelName: w.hotelName, createdAt: nowISO(), createdBy: me, reviewerName: file.payload.reviewerName,
    assignment: { version: 0, updatedAt: null, members: [], sections: {} },
    items, comments: {}, finalize: { current: null, lastVersion: 0, log: [] },
    saveSeq: 0, savedAt: null, appVersion: APP_VERSION,
    local: { role: 'preparer', me, hidden: false, lastOpenedAt: nowISO(), color: colorFor(w.wsId) },
  };
  return applyAssignment(doc, file);
}
