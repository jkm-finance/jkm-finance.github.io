// Small pure helpers shared by browser and Node tests. No DOM access here.

export function uuid() {
  return globalThis.crypto.randomUUID();
}

export function nowISO() {
  return new Date().toISOString();
}

export function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// Deterministic JSON: object keys sorted, no whitespace. Used for checksums and hashes.
export function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(v[k])).join(',') + '}';
}

export async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashOf(value) {
  return 'sha256:' + (await sha256Hex(canonicalJSON(value)));
}

// Trim and unify line endings so that equal text compares equal across PCs.
export function normText(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\r\n?/g, '\n').trim();
}

export function isISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Hotel name for file names only (never for identification).
export function fileSafe(s, max = 40) {
  const t = String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return (t || 'hotel').slice(0, max);
}
