// Excel row builders (SPEC §10.1). Pure, so they can be unit-tested in Node.
import { getItemSet } from './itemsets.js';
import { assignedTo } from './model.js';

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
  header.push('Policy', 'Result', 'Preparer Description (internal)', 'AuditBoard Response', 'Evidence', 'Sample', 'Remediation Action', 'Remediation Owner', 'Due Date', 'Status', 'Preparer', 'Last Updated', 'Reviewer Comment (latest)', 'AuditBoard Entered');
  const rows = [header];
  for (const m of set.items) {
    if (onlyMine && !assignedTo(doc, m.section).includes(doc.local.me)) continue;
    const it = doc.items[m.id];
    const comments = (doc.comments[m.id] || []).filter((c) => c.role === 'reviewer');
    const r = ab ? [m.no, ab[m.id] || '', m.section, m.risk] : [m.no, m.section, m.risk];
    if (focus) r.push(m.tower || '', m.cpaLink || '');
    r.push(m.ws);
    if (lang !== 'en') r.push(itemText ? itemText(m, lang).ws : m.ws);
    r.push(m.policy, RES[it.result] || '', it.process || '', it.response, it.evidence, it.sample,
      it.remediation.action, it.remediation.owner, it.remediation.due || '', statusLabel(it.status),
      it.submittedBy || it.updatedBy || '', it.updatedAt ? it.updatedAt.slice(0, 16).replace('T', ' ') : '',
      comments.length ? comments[comments.length - 1].text : '', it.enteredAt ? it.enteredAt.slice(0, 10) : '');
    rows.push(r.map(safeCell));
  }
  return rows;
}
