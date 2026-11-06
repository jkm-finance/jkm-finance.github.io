// Policy reference -> PDF on the CPA site (the same documents the CPA dashboard opens; not copied here).
// Data from tools/sync_policies.py.
import POLICIES from '../data/policies.js';
import { h } from './dom.js';

export function policyCode(policy) {
  const p = (policy || '').trim();
  for (const k of Object.keys(POLICIES)) if (k.includes(' ') && p.startsWith(k)) return k;
  return p.split(/[\s\t]+/)[0] || '';
}

export function policyUrl(policy) {
  const f = POLICIES[policyCode(policy)];
  return f && /^https:\/\/rlee1829\.github\.io\//.test(f) ? f : null;
}

// A link that opens the PDF in a new tab, or plain text when the reference is not a document.
export function policyEl(policy, cls = 'poltag') {
  const text = policy || '—';
  const url = policyUrl(policy);
  if (!url) return h('span', { class: cls, text });
  return h('a', { class: cls + ' pollink', href: url, target: '_blank', rel: 'noopener noreferrer', title: 'PDF', text: text + ' ↗' });
}
