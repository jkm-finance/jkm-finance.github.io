// Tab locking, cross-tab notices, persistent storage and automatic folder backup
// (SPEC §11, DATA_MODEL §7.4, §8.2). Browser only.
import { YEAR } from './version.js';
import { fileSafe, todayLocal } from './util.js';
import { backupsToDelete } from './guard.js';
import { answeredCount } from './model.js';

// ---- one editing tab per workspace ---------------------------------------------

const lockName = (wsId) => `jkmcsa:ws:${wsId}`;

// Resolves to { release() } if this tab may edit, or null if another tab holds the lock.
export function tryEditLock(wsId) {
  if (!navigator.locks) return Promise.resolve({ release() {}, unsupported: true });
  return new Promise((resolve) => {
    navigator.locks.request(lockName(wsId), { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(null); return undefined; }
      return new Promise((release) => resolve({ release }));
    });
  });
}

// Waits until the lock becomes free, then holds it and calls onGranted({ release }).
export function waitEditLock(wsId, onGranted) {
  if (!navigator.locks) return () => {};
  const ac = new AbortController();
  navigator.locks.request(lockName(wsId), { signal: ac.signal }, () => new Promise((release) => onGranted({ release })))
    .catch(() => {});
  return () => ac.abort();
}

let channel = null;
export function onSaved(handler) {
  if (!globalThis.BroadcastChannel) return () => {};
  channel = channel || new BroadcastChannel('jkmcsa');
  const fn = (e) => { if (e.data && e.data.type === 'saved') handler(e.data); };
  channel.addEventListener('message', fn);
  return () => channel.removeEventListener('message', fn);
}
export function announceSaved(wsId, saveSeq) {
  if (!globalThis.BroadcastChannel) return;
  channel = channel || new BroadcastChannel('jkmcsa');
  channel.postMessage({ type: 'saved', wsId, saveSeq });
}

export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* not available */ }
  return false;
}

// ---- automatic folder backup ---------------------------------------------------

export const fsSupported = () => typeof globalThis.showDirectoryPicker === 'function';

export async function pickBackupDir() {
  return globalThis.showDirectoryPicker({ id: 'jkmcsa-backup', mode: 'readwrite' });
}

export async function dirPermission(handle, ask = false) {
  if (!handle) return 'none';
  const opts = { mode: 'readwrite' };
  let p = await handle.queryPermission(opts);
  if (p !== 'granted' && ask) p = await handle.requestPermission(opts);
  return p;
}

export function backupNames(doc) {
  const svc = doc.serviceType === 'full' ? 'Full' : 'Focus';
  const base = `CSA${doc.year}_${fileSafe(doc.hotelName)}_${svc}_${doc.wsId.slice(0, 6)}`;
  return { latest: `${base}_LATEST.json`, dated: `${base}_${todayLocal()}.json` };
}

async function writeFile(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();   // writes to a temp file; the old file stays until close()
  try {
    await w.write(text);
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* ignore */ }
    throw e;
  }
}

// Writes LATEST and today's file, then prunes this workspace's files older than 30 days.
// Empty workspaces are never written (DATA_MODEL §8.2).
export async function writeBackup(dir, doc, text) {
  if (answeredCount(doc) === 0) return { skipped: 'empty' };
  const n = backupNames(doc);
  await writeFile(dir, n.latest, text);
  await writeFile(dir, n.dated, text);
  const names = [];
  for await (const [name, h] of dir.entries()) if (h.kind === 'file') names.push(name);
  const del = backupsToDelete(names, YEAR, doc.wsId.slice(0, 6), todayLocal());
  for (const name of del) { try { await dir.removeEntry(name); } catch { /* keep going */ } }
  return { written: [n.latest, n.dated], pruned: del, bytes: text.length };
}
