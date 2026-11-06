// Boot, gates and the workspace controller (autosave, restore points, backups, tab lock).
import { APP_VERSION, YEAR } from './version.js';
import { withProgress } from './schedule.js';
import { todayLocal } from './util.js';
import { h, clear, toast, modal, download } from './dom.js';
import { t, getLang, setLang } from './i18n.js';
import { WorkStore, StoreError } from './store.js';
import { tryEditLock, waitEditLock, onSaved, announceSaved, requestPersist, fsSupported, pickBackupDir, dirPermission, writeBackup } from './safety.js';
import { buildFile, backupPayload, FileError } from './files.js';
import { renderStart } from './ui-start.js';
import { renderWorkspace, refreshChrome } from './ui-work.js';
import { renderRegional } from './ui-regional.js';
import { renderDofViewer } from './ui-report.js';

const PASSWORDS = { jkm: 'work', apac: 'region' };   // screen gate only (SPEC §13)
const SAVE_DELAY = 800;
const SNAP_EVERY = 5 * 60 * 1000;
const BACKUP_EVERY = 15 * 1000;

export const ctl = {
  store: null,
  state: {
    doc: null, readonly: false, lock: null, view: 'overview', section: null, itemId: null,
    filters: {}, saving: 'idle', lastSavedAt: null, fatal: null, shrink: null,
    backup: { status: 'none', dir: null, lastSeq: -1, lastAt: null, error: null },
    lastSnapAt: 0, lastSnapSeq: -1, dirty: false, pendingEvents: [],
  },
  t,
};
window.__csa = ctl;   // for browser tests only

// ---- boot -------------------------------------------------------------------

async function boot() {
  document.documentElement.lang = getLang();
  installErrorTrap();
  try {
    ctl.store = await new WorkStore().open();
  } catch (e) {
    showFatalStart(e instanceof StoreError ? e.code : 'noIndexedDB');
    return;
  }
  requestPersist().then((ok) => ctl.store.kvSet('persistRequested', { ok, at: new Date().toISOString() }).catch(() => {}));
  ctl.state.me = (await ctl.store.kvGet('userName')) || '';
  checkVersionLater();
  const auth = sessionStorage.getItem('jkmcsa.auth');
  if (auth === 'region') return enterRegional();
  if (auth === 'work') return afterAuth();
  renderPassword();
}

function showFatalStart(code) {
  const root = clear(document.getElementById('root'));
  root.appendChild(h('div', { class: 'gate' }, h('div', { class: 'gbox' },
    h('div', { class: 'glogo' }, h('span', { class: 'csa-badge', text: 'CSA' }), 'CSA 2026'),
    h('p', { class: 'gerr', text: t('err.' + code) }),
    h('p', { class: 'gsub', text: t('start.storageHelp') }))));
}

function renderPassword() {
  const root = clear(document.getElementById('root'));
  const input = h('input', { class: 'gin', type: 'password', autocomplete: 'off', 'aria-label': t('pw.label'), placeholder: t('pw.label') });
  const err = h('div', { class: 'gerr' });
  const go = () => {
    const mode = PASSWORDS[input.value.trim().toLowerCase()];
    if (!mode) { err.textContent = t('pw.wrong'); input.select(); return; }
    sessionStorage.setItem('jkmcsa.auth', mode);
    if (mode === 'region') enterRegional(); else afterAuth();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  root.appendChild(h('div', { class: 'gate' }, h('div', { class: 'gbox' },
    h('div', { class: 'glogo' }, h('span', { class: 'csa-badge', text: 'CSA' }), t('app.title')),
    h('div', { class: 'gsub', text: t('app.subtitle') }),
    input, err, h('button', { class: 'gbtn', text: t('pw.enter'), onclick: go }),
    langRow(() => renderPassword()),
    h('div', { class: 'gsub', text: 'v' + APP_VERSION }))));
  input.focus();
}

export function langRow(rerender) {
  return h('div', { class: 'lang-row' }, ['ko', 'en', 'ja'].map((l) =>
    h('button', { class: 'btn btn-l' + (getLang() === l ? ' btn-p' : ''), text: l.toUpperCase(), onclick: () => { setLang(l); document.documentElement.lang = l; rerender(); } })),
    guideLink('btn btn-l'));
}

// Opens the user guide in the current UI language (static pages under guide/).
export function guideLink(cls = 'btn btn-o') {
  return h('a', { class: cls + ' guide-link', href: 'guide/' + getLang() + '.html', target: '_blank', rel: 'noopener', text: '? ' + t('guide.open') });
}

async function afterAuth() {
  const last = sessionStorage.getItem('jkmcsa.current');
  if (last && (await ctl.store.load(last).catch(() => null))) return openWorkspace(last);
  renderStart(ctl);
}

async function enterRegional() { renderRegional(ctl); }

export function goStart() {
  closeWorkspace().then(() => renderStart(ctl));
}

export async function openDof(file) { return renderDofViewer(ctl, file); }

// ---- workspace lifecycle ----------------------------------------------------

export async function setUserName(name) {
  ctl.state.me = name;
  await ctl.store.kvSet('userName', name);
}

export async function openWorkspace(wsId) {
  await closeWorkspace();
  const s = ctl.state;
  let doc;
  try { doc = await ctl.store.load(wsId); } catch (e) { toast(t('err.' + (e.code || 'storage'))); return renderStart(ctl); }
  if (!doc) { sessionStorage.removeItem('jkmcsa.current'); return renderStart(ctl); }
  const lock = await tryEditLock(wsId);
  Object.assign(s, { doc, readonly: !lock, lock, view: 'overview', section: null, itemId: null, filters: {}, fatal: null, shrink: null, dirty: false, pendingEvents: [], lastSnapSeq: doc.saveSeq, lastSnapAt: Date.now() });
  s.backup = { status: 'none', dir: null, lastSeq: -1, lastAt: null, error: null };
  sessionStorage.setItem('jkmcsa.current', wsId);
  if (lock) {
    if (s.me && doc.local.me !== s.me) doc.local.me = s.me;
    s.doc = await ctl.store.touch(doc, { lastOpenedAt: new Date().toISOString(), me: doc.local.me });
    await initBackupDir();
  } else {
    s.unwait = waitEditLock(wsId, (l) => { s.pendingLock = l; refreshChrome(ctl); });
  }
  s.unsub = onSaved(async (m) => {
    if (m.wsId !== wsId || !s.readonly) return;
    const fresh = await ctl.store.load(wsId);
    if (fresh) { s.doc = fresh; renderWorkspace(ctl); }
  });
  renderWorkspace(ctl);
}

// Second tab: take over editing once the first tab has closed.
export async function takeOverEditing() {
  const s = ctl.state;
  if (!s.pendingLock) return;
  s.lock = s.pendingLock; s.pendingLock = null; s.readonly = false;
  s.doc = await ctl.store.load(s.doc.wsId);
  await initBackupDir();
  renderWorkspace(ctl);
}

export async function closeWorkspace() {
  const s = ctl.state;
  if (!s.doc) return;
  if (!s.readonly) { await flush(); await maybeBackup(true); }
  if (s.unsub) s.unsub();
  if (s.unwait) s.unwait();
  if (s.lock) s.lock.release();
  if (s.pendingLock) s.pendingLock.release();
  Object.assign(s, { doc: null, lock: null, pendingLock: null, unsub: null, unwait: null, readonly: false, pendingEvents: [], dirty: false });
  sessionStorage.removeItem('jkmcsa.current');
}

// ---- applying changes -------------------------------------------------------

// Coalesce consecutive edits of the same item/fields into one history event (DATA_MODEL §6).
function queueEvents(events) {
  const q = ctl.state.pendingEvents;
  for (const e of events) {
    const last = q[q.length - 1];
    if (last && e.action === 'edit' && last.action === 'edit' && last.itemId === e.itemId &&
        JSON.stringify(last.detail.fields) === JSON.stringify(e.detail.fields) && Date.parse(e.at) - Date.parse(last.at) < 5000) {
      last.detail.after = e.detail.after; last.at = e.at;
    } else q.push(e);
  }
}

export function apply(result, { render = false } = {}) {
  const s = ctl.state;
  if (!result || result.doc === s.doc) return;
  if (s.readonly || s.fatal) { toast(t('err.readonly')); return; }
  s.doc = withProgress(result.doc, todayLocal());
  queueEvents(result.events || []);
  s.dirty = true;
  scheduleSave();
  if (render) renderWorkspace(ctl); else refreshChrome(ctl);
}

// Runs a pure operation and reports "not allowed" errors in the user's language.
export async function run(fn, opts) {
  try {
    const r = await fn(ctl.state.doc);
    apply(r, opts);
    return r;
  } catch (e) {
    toast(t('err.' + (e.code || 'generic')));
    return null;
  }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush().catch(() => {}), SAVE_DELAY);
}

let saving = null;
export async function flush({ allowShrink = false } = {}) {
  clearTimeout(saveTimer);
  if (saving) { await saving; }
  const s = ctl.state;
  if (!s.doc || s.readonly || s.fatal || (!s.dirty && !allowShrink)) return;
  if (s.shrink && !allowShrink) return;
  saving = (async () => {
    s.saving = 'saving'; refreshChrome(ctl);
    const snapshotDoc = s.doc;
    const events = s.pendingEvents.splice(0);
    s.dirty = false;
    try {
      const saved = await ctl.store.save(snapshotDoc, { allowShrink });
      // Keep anything typed while saving; only adopt the new sequence number.
      if (s.doc === snapshotDoc) s.doc = saved;
      else { s.doc = { ...s.doc, saveSeq: saved.saveSeq, savedAt: saved.savedAt }; s.dirty = true; scheduleSave(); }
      await ctl.store.appendHistory(events);
      s.saving = 'saved'; s.lastSavedAt = saved.savedAt; s.shrink = null; s.saveError = null;
      announceSaved(saved.wsId, saved.saveSeq);
      maybeAutoSnapshot();
    } catch (e) {
      s.pendingEvents.unshift(...events);
      s.dirty = true;
      handleSaveError(e);
    } finally {
      saving = null;
      refreshChrome(ctl);
    }
  })();
  return saving;
}

async function handleSaveError(e) {
  const s = ctl.state;
  s.saving = 'error';
  s.saveError = e.code || 'storage';
  if (e.code === 'shrink') {
    s.shrink = e.detail;
    renderWorkspace(ctl);
  } else if (e.code === 'staleSeq') {
    // Someone else saved this workspace. Keep our version as a restore point, then reload.
    try { await ctl.store.snapshot(s.doc, 'stale-recovery'); } catch { /* ignore */ }
    s.doc = await ctl.store.load(s.doc.wsId);
    s.dirty = false; s.pendingEvents = [];
    toast(t('err.staleSeq'), 6000);
    renderWorkspace(ctl);
  }
}

// User confirmed a large deletion (DP-07): restore point first, then save.
export async function confirmShrink(keep) {
  const s = ctl.state;
  if (!s.shrink) return;
  if (keep) {
    const prev = await ctl.store.load(s.doc.wsId);
    s.doc = prev; s.dirty = false; s.pendingEvents = []; s.shrink = null; s.saving = 'saved';
  } else {
    const stored = await ctl.store.load(s.doc.wsId);
    await ctl.store.snapshot(stored, 'before-shrink');
    s.shrink = null;
    await flush({ allowShrink: true });
  }
  renderWorkspace(ctl);
}

// Destructive operations: save, restore point, apply, save (FR-82).
export async function withRestorePoint(reason, fn, { allowShrink = false } = {}) {
  const s = ctl.state;
  if (s.readonly || s.fatal) { toast(t('err.readonly')); return null; }
  await flush();
  if (s.dirty) { toast(t('err.saveFirst')); return null; }
  await ctl.store.snapshot(s.doc, reason);
  let r;
  try { r = await fn(s.doc); } catch (e) { toast(t('err.' + (e.code || 'generic'))); return null; }
  if (!r || r.doc === s.doc) return r;
  s.doc = withProgress(r.doc, todayLocal()); queueEvents(r.events || []); s.dirty = true;
  await flush({ allowShrink });
  renderWorkspace(ctl);
  return r;
}

async function maybeAutoSnapshot() {
  const s = ctl.state;
  if (!s.doc || s.doc.saveSeq === s.lastSnapSeq || Date.now() - s.lastSnapAt < SNAP_EVERY) return;
  s.lastSnapAt = Date.now(); s.lastSnapSeq = s.doc.saveSeq;
  try { await ctl.store.snapshot(s.doc, 'auto'); await ctl.store.pruneSnaps(s.doc.wsId); } catch { /* reported by save path */ }
}

export async function restoreSnapshot(id) {
  const s = ctl.state;
  await flush();
  try {
    s.doc = await ctl.store.restore(s.doc, id);
    await ctl.store.appendHistory([{ wsId: s.doc.wsId, itemId: null, at: new Date().toISOString(), by: s.doc.local.me, role: s.doc.local.role, action: 'restore', detail: { snapId: id } }]);
    toast(t('backup.restored'));
  } catch (e) { toast(t('err.' + (e.code || 'generic'))); }
  renderWorkspace(ctl);
}

// ---- automatic folder backup -------------------------------------------------

async function initBackupDir() {
  const b = ctl.state.backup;
  if (!fsSupported()) { b.status = 'unsupported'; return; }
  const dir = await ctl.store.kvGet('backupDir').catch(() => null);
  if (!dir) { b.status = 'none'; return; }
  b.dir = dir;
  b.status = (await dirPermission(dir).catch(() => 'denied')) === 'granted' ? 'ok' : 'needPermission';
}

export async function chooseBackupDir() {
  try {
    const dir = await pickBackupDir();
    await ctl.store.kvSet('backupDir', dir);
    ctl.state.backup.dir = dir; ctl.state.backup.status = 'ok';
    await maybeBackup(true);
    refreshChrome(ctl);
  } catch (e) { if (e.name !== 'AbortError') toast(t('err.backupFailed')); }
}

export async function reconnectBackup() {
  const b = ctl.state.backup;
  if (!b.dir) return chooseBackupDir();
  b.status = (await dirPermission(b.dir, true).catch(() => 'denied')) === 'granted' ? 'ok' : 'needPermission';
  if (b.status === 'ok') await maybeBackup(true);
  refreshChrome(ctl);
}

export async function fullBackupFile() {
  const d = ctl.state.doc;
  return buildFile('backup', d, backupPayload(d, await ctl.store.history(d.wsId)));
}

async function maybeBackup(force = false) {
  const s = ctl.state, b = s.backup;
  if (!s.doc || s.readonly || b.status !== 'ok') return;
  if (!force && s.doc.saveSeq === b.lastSeq) return;
  try {
    const file = await fullBackupFile();
    const r = await writeBackup(b.dir, s.doc, JSON.stringify(file));
    b.lastSeq = s.doc.saveSeq; b.lastAt = new Date().toISOString(); b.error = null;
    await ctl.store.kvSet('backupState:' + s.doc.wsId, { lastAt: b.lastAt, lastSaveSeq: b.lastSeq, bytes: r.bytes || 0 });
  } catch (e) {
    b.error = e.name || 'error';
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') b.status = 'needPermission';
  }
  refreshChrome(ctl);
}

setInterval(() => maybeBackup().catch(() => {}), BACKUP_EVERY);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { flush().then(() => maybeBackup(true)).catch(() => {}); }
});
window.addEventListener('pagehide', () => { flush().catch(() => {}); });
window.addEventListener('beforeunload', (e) => {
  const s = ctl.state;
  if (s.doc && !s.readonly && (s.dirty || s.saving === 'saving' || s.saving === 'error')) { flush().catch(() => {}); e.preventDefault(); e.returnValue = ''; }
});

// ---- unexpected errors: stop autosave so a broken state is never written ------

function installErrorTrap() {
  const trap = (msg) => {
    const s = ctl.state;
    if (s.fatal) return;
    s.fatal = String(msg || 'error').slice(0, 300);
    clearTimeout(saveTimer);
    try { refreshChrome(ctl); } catch { /* ignore */ }
  };
  window.addEventListener('error', (e) => trap(e.message));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r instanceof FileError || r instanceof StoreError) return;   // handled where they occur
    trap(r && r.message);
  });
}

export async function exportEmergency() {
  const d = ctl.state.doc;
  if (!d) return;
  const file = await fullBackupFile();
  const { fileName } = await import('./files.js');
  download(JSON.stringify(file), fileName('backup', d));
}

// ---- new version notice (no automatic reload) ---------------------------------

function checkVersionLater() {
  const check = async () => {
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const v = await r.json();
      if (v.version && v.version !== APP_VERSION) { ctl.state.newVersion = v.version; refreshChrome(ctl); }
    } catch { /* offline is fine */ }
  };
  setTimeout(check, 20000);
  setInterval(check, 30 * 60 * 1000);
}

export { YEAR, modal };
boot();
