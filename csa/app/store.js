// IndexedDB storage (DATA_MODEL §4, §7). Browser only.
// Three separate databases keep hotel work, Hotel DOF viewing and Area/Regional data apart.
import { DB_VERSION, APP_VERSION } from './version.js';
import { canonicalJSON, nowISO, clone } from './util.js';
import { validateDoc } from './model.js';
import { detectShrink, needsMigration, isTooNew, migrate, snapsToDelete } from './guard.js';

export const DB = { work: 'jkmcsa_work', view: 'jkmcsa_view', region: 'jkmcsa_region' };

export class StoreError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail || null; }
}

function req2p(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

function txDone(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new StoreError('aborted'));
  });
}

function wrapErr(e) {
  if (e instanceof StoreError) return e;
  if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) return new StoreError('quota', e.message);
  return new StoreError('storage', e && e.message);
}

export function openDB(name) {
  return new Promise((res, rej) => {
    if (!globalThis.indexedDB) { rej(new StoreError('noIndexedDB')); return; }
    let r;
    try { r = indexedDB.open(name, DB_VERSION); } catch (e) { rej(new StoreError('noIndexedDB', e.message)); return; }
    r.onupgradeneeded = () => {
      const db = r.result;
      // Stores are only ever added (DATA_MODEL §4.1).
      if (name === DB.work) {
        if (!db.objectStoreNames.contains('ws')) db.createObjectStore('ws', { keyPath: 'wsId' });
        if (!db.objectStoreNames.contains('ws_prev')) db.createObjectStore('ws_prev', { keyPath: 'wsId' });
        if (!db.objectStoreNames.contains('history')) {
          const h = db.createObjectStore('history', { keyPath: 'seq', autoIncrement: true });
          h.createIndex('wsId', 'wsId');
          h.createIndex('wsItem', ['wsId', 'itemId']);
        }
        if (!db.objectStoreNames.contains('snaps')) {
          const s = db.createObjectStore('snaps', { keyPath: 'id', autoIncrement: true });
          s.createIndex('wsId', 'wsId');
        }
      } else {
        if (!db.objectStoreNames.contains('finals')) {
          const f = db.createObjectStore('finals', { keyPath: ['wsId', 'finalVersion'] });
          f.createIndex('wsId', 'wsId');
        }
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(new StoreError('noIndexedDB', r.error && r.error.message));
    r.onblocked = () => rej(new StoreError('blocked'));
  });
}

// ---- hotel work database ------------------------------------------------------

export class WorkStore {
  async open() { this.db = await openDB(DB.work); return this; }

  async kvGet(k) { return req2p(this.db.transaction('kv').objectStore('kv').get(k)); }
  async kvSet(k, v) { const tx = this.db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); await txDone(tx); }

  async listWorkspaces() {
    const all = await req2p(this.db.transaction('ws').objectStore('ws').getAll());
    return all.map((d) => ({
      wsId: d.wsId, hotelName: d.hotelName, serviceType: d.serviceType, year: d.year,
      role: d.local?.role, hidden: !!d.local?.hidden, lastOpenedAt: d.local?.lastOpenedAt, savedAt: d.savedAt,
      color: d.local?.color, finalized: !!d.finalize?.current, schema: d.schema,
    }));
  }

  // Loads and, if needed, migrates (with a restore point first). Never writes a too-new doc.
  async load(wsId) {
    const doc = await req2p(this.db.transaction('ws').objectStore('ws').get(wsId));
    if (!doc) return null;
    if (isTooNew(doc)) throw new StoreError('newerSchema');
    if (needsMigration(doc)) {
      await this.snapshot(doc, 'before-migrate');
      const { doc: m, applied } = migrate(doc);
      const saved = await this.save(m, { allowShrink: true, skipSeqCheck: true });
      await this.appendHistory([{ wsId, itemId: null, at: nowISO(), by: m.local?.me || '', role: m.local?.role || '', action: 'migrate', detail: { applied } }]);
      return saved;
    }
    return doc;
  }

  async loadPrev(wsId) { return req2p(this.db.transaction('ws_prev').objectStore('ws_prev').get(wsId)); }

  // Atomic save with previous copy, sequence check, shrink guard and read-back verification.
  async save(doc, { allowShrink = false, skipSeqCheck = false, isNew = false } = {}) {
    const errs = validateDoc(doc, doc.wsId);
    if (errs.length) throw new StoreError('invalid', errs.slice(0, 5));
    const next = clone(doc);
    let tx;
    try {
      tx = this.db.transaction(['ws', 'ws_prev'], 'readwrite');
      const ws = tx.objectStore('ws');
      const cur = await req2p(ws.get(doc.wsId));
      if (isNew && cur) { tx.abort(); throw new StoreError('exists'); }
      if (!isNew && !cur) { tx.abort(); throw new StoreError('missing'); }
      if (cur && !skipSeqCheck && cur.saveSeq !== doc.saveSeq) { tx.abort(); throw new StoreError('staleSeq', { stored: cur.saveSeq, mine: doc.saveSeq }); }
      if (cur && !allowShrink) {
        const s = detectShrink(cur, doc);
        if (s) { tx.abort(); throw new StoreError('shrink', s); }
      }
      next.saveSeq = (cur ? cur.saveSeq : doc.saveSeq) + 1;
      next.savedAt = nowISO();
      next.appVersion = APP_VERSION;
      if (cur) tx.objectStore('ws_prev').put(cur);
      ws.put(next);
      await txDone(tx);
    } catch (e) {
      throw wrapErr(e);
    }
    const back = await req2p(this.db.transaction('ws').objectStore('ws').get(doc.wsId));
    if (!back || canonicalJSON(back) !== canonicalJSON(next)) throw new StoreError('verifyFailed');
    return back;
  }

  // Writes only the local (PC-specific) part, e.g. last opened time; same safety path.
  async touch(doc, patch) {
    const d = clone(doc);
    d.local = { ...d.local, ...patch };
    return this.save(d, { allowShrink: true });
  }

  async appendHistory(events) {
    if (!events || !events.length) return;
    const tx = this.db.transaction('history', 'readwrite');
    const st = tx.objectStore('history');
    for (const e of events) st.add(clone(e));
    try { await txDone(tx); } catch (e) { throw wrapErr(e); }
  }

  async history(wsId, itemId) {
    const st = this.db.transaction('history').objectStore('history');
    const list = itemId ? await req2p(st.index('wsItem').getAll([wsId, itemId])) : await req2p(st.index('wsId').getAll(wsId));
    return list;
  }

  async snapshot(doc, reason) {
    const tx = this.db.transaction('snaps', 'readwrite');
    tx.objectStore('snaps').add({ wsId: doc.wsId, at: nowISO(), reason, saveSeq: doc.saveSeq, doc: clone(doc) });
    try { await txDone(tx); } catch (e) { throw wrapErr(e); }
  }

  async listSnaps(wsId) {
    const all = await req2p(this.db.transaction('snaps').objectStore('snaps').index('wsId').getAll(wsId));
    return all.map((s) => ({ id: s.id, at: s.at, reason: s.reason, saveSeq: s.saveSeq }));
  }

  async getSnap(id) { return req2p(this.db.transaction('snaps').objectStore('snaps').get(id)); }

  async pruneSnaps(wsId) {
    const del = snapsToDelete(await this.listSnaps(wsId));
    if (!del.length) return 0;
    const tx = this.db.transaction('snaps', 'readwrite');
    for (const id of del) tx.objectStore('snaps').delete(id);
    await txDone(tx);
    return del.length;
  }

  // Restore a snapshot of THIS workspace only. A restore point of the current state is taken first.
  async restore(current, snapId) {
    const snap = await this.getSnap(snapId);
    if (!snap || snap.wsId !== current.wsId || snap.doc.wsId !== current.wsId) throw new StoreError('otherWorkspace');
    await this.snapshot(current, 'before-restore');
    const d = clone(snap.doc);
    d.saveSeq = current.saveSeq;
    d.local = { ...snap.doc.local, ...current.local };
    return this.save(d, { allowShrink: true });
  }

  async create(doc) { return this.save(doc, { isNew: true }); }

  // Replace a workspace from a verified backup file (same wsId) or create it.
  async replaceFromBackup(doc, history, existing) {
    if (existing) {
      if (existing.wsId !== doc.wsId) throw new StoreError('otherWorkspace');
      await this.snapshot(existing, 'before-import');
      const d = clone(doc); d.saveSeq = existing.saveSeq; d.local = { ...doc.local, ...existing.local };
      const saved = await this.save(d, { allowShrink: true });
      await this.appendHistory(history.filter((e) => e.wsId === doc.wsId).map((e) => { const x = { ...e }; delete x.seq; return x; }));
      return saved;
    }
    const d = clone(doc); d.saveSeq = 0;
    const saved = await this.create(d);
    await this.appendHistory(history.filter((e) => e.wsId === doc.wsId).map((e) => { const x = { ...e }; delete x.seq; return x; }));
    return saved;
  }

  // Step 2 of deletion (FR-83). Caller has already enforced backup download + typed name.
  async deleteWorkspace(wsId) {
    const tx = this.db.transaction(['ws', 'ws_prev', 'history', 'snaps'], 'readwrite');
    tx.objectStore('ws').delete(wsId);
    tx.objectStore('ws_prev').delete(wsId);
    for (const name of ['history', 'snaps']) {
      const idx = tx.objectStore(name).index('wsId');
      const keys = await req2p(idx.getAllKeys(wsId));
      for (const k of keys) tx.objectStore(name).delete(k);
    }
    await txDone(tx);
  }
}

// ---- read-only final results (Hotel DOF / Area-Regional) ------------------------

export class FinalStore {
  constructor(which) { this.which = which; }
  async open() { this.db = await openDB(DB[this.which]); return this; }
  async put(file) {
    const rec = { wsId: file.workspace.wsId, finalVersion: file.payload.finalVersion, receivedAt: nowISO(), file: clone(file) };
    const tx = this.db.transaction('finals', 'readwrite');
    const st = tx.objectStore('finals');
    const existing = await req2p(st.get([rec.wsId, rec.finalVersion]));
    st.put(existing && canonicalJSON(existing.file) !== canonicalJSON(file) ? { ...rec, conflictWith: existing.file } : rec);
    try { await txDone(tx); } catch (e) { throw wrapErr(e); }
    return { replaced: !!existing, sameContent: existing ? canonicalJSON(existing.file) === canonicalJSON(file) : null };
  }
  async all() { return req2p(this.db.transaction('finals').objectStore('finals').getAll()); }
  async removeWorkspace(wsId) {
    const tx = this.db.transaction('finals', 'readwrite');
    const keys = await req2p(tx.objectStore('finals').index('wsId').getAllKeys(wsId));
    for (const k of keys) tx.objectStore('finals').delete(k);
    await txDone(tx);
  }
  // Latest version per workspace; older versions listed as history (FR-65).
  async latest() {
    const by = {};
    for (const r of await this.all()) (by[r.wsId] = by[r.wsId] || []).push(r);
    return Object.values(by).map((list) => {
      list.sort((a, b) => b.finalVersion - a.finalVersion);
      return { latest: list[0], older: list.slice(1) };
    });
  }
}
