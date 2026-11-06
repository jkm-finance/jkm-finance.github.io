// Excel row builders (SPEC §10.1). Pure, so they can be unit-tested in Node.
import { getItemSet } from './itemsets.js';
import { isItemAssigned, itemAssignees } from './model.js';
import { priorOf } from './prior.js';

const RES = { yes: 'Yes', no: 'No', na: 'N/A', hold: 'Hold' };

// Text that Excel would treat as a formula is stored as plain text (SEC-02).
export function safeCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

export function workspaceRows(doc, { lang = 'en', itemText, statusLabel = (s) => s, onlyMine = false } = {}) {
  const set = getItemSet(doc.itemSetId);
  const focus = doc.serviceType === 'focus';
  const ab = doc.ab && doc.ab.ids;
  const header = ab ? ['No', 'AuditBoard ID', 'Section', 'Risk'] : ['No', 'Section', 'Risk'];
  if (focus) header.push('HTL/FSSC', 'CPA link');
  header.push('Work Step (EN)');
  if (lang !== 'en') header.push('Work Step (' + lang.toUpperCase() + ')');
  header.push('Policy', 'Result', 'Preparer Description (internal)', 'AuditBoard Response', 'Evidence', 'Sample', 'Remediation Action', 'Remediation Owner', 'Due Date', 'Status', 'Assignee', 'Preparer', 'Last Updated', 'Reviewer Comment (latest)', 'AuditBoard Entered');
  if (doc.prior) header.push(`Prior Result (${doc.prior.year})`, `Prior Note (${doc.prior.year})`);
  const rows = [header];
  for (const m of set.items) {
    if (onlyMine && !isItemAssigned(doc, m.id, doc.local.me, m.section)) continue;
    const it = doc.items[m.id];
    const comments = (doc.comments[m.id] || []).filter((c) => c.role === 'reviewer');
    const r = ab ? [m.no, ab[m.id] || '', m.section, m.risk] : [m.no, m.section, m.risk];
    if (focus) r.push(m.tower || '', m.cpaLink || '');
    r.push(m.ws);
    if (lang !== 'en') r.push(itemText ? itemText(m, lang).ws : m.ws);
    r.push(m.policy, RES[it.result] || '', it.process || '', it.response, it.evidence, it.sample,
      it.remediation.action, it.remediation.owner, it.remediation.due || '', statusLabel(it.status), itemAssignees(doc, m.id, m.section).join(', '),
      it.submittedBy || it.updatedBy || '', it.updatedAt ? it.updatedAt.slice(0, 16).replace('T', ' ') : '',
      comments.length ? comments[comments.length - 1].text : '', it.enteredAt ? it.enteredAt.slice(0, 10) : '');
    if (doc.prior) { const pr = priorOf(doc, m.id); r.push(pr ? RES[pr.result] : '', pr ? pr.note || '' : ''); }
    rows.push(r.map(safeCell));
  }
  return rows;
}
