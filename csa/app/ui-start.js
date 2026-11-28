// Start screen (SPEC §3): name once, continue a workspace, or start new by role (reviewer / preparer / results).
import { YEAR, APP_VERSION } from './version.js';
import { h, clear, modal, dropZone, toast, fmtTime, download } from './dom.js';
import { t } from './i18n.js';
import { createWorkspace } from './model.js';
import { itemSetIdFor, getItemSet } from './itemsets.js';
import { readAndVerify, buildFile, backupPayload, fileName } from './files.js';
import { tryEditLock } from './safety.js';
import { workspaceFromAssignment, applyAssignment } from './merge.js';
import { openWorkspace, setUserName, langRow, openDof } from './main.js';
import { FinalStore } from './store.js';
import { newFromExport } from './ui-ab.js';

export async function renderStart(ctl) {
  const root = clear(document.getElementById('root'));
  const s = ctl.state;
  const box = h('div', { class: 'gbox wide' });
  root.appendChild(h('div', { class: 'gate' }, box));

  box.appendChild(h('div', { class: 'glogo' }, h('span', { class: 'csa-badge', text: 'CSA' }), t('app.title')));
  box.appendChild(h('div', { class: 'gsub', text: t('app.subtitle') + ' · v' + APP_VERSION }));
  const banner = h('div');
  box.appendChild(banner);
  newerVersion().then((v) => { if (v) banner.appendChild(h('div', { class: 'gnotice' }, h('span', { text: t('start.newVersion', { v }) }), h('button', { class: 'btn btn-p', text: t('start.reload'), onclick: () => location.reload() }))); });

  // Name: asked prominently once; afterwards a small editable line.
  const nameIn = h('input', { class: 'gin' + (s.me ? ' gin-sm' : ''), value: s.me || '', placeholder: t('start.namePh'), maxlength: '80', 'aria-label': t('start.name') });
  nameIn.addEventListener('change', () => setUserName(nameIn.value.trim()));
  if (s.me) box.appendChild(h('label', { class: 'gname' }, h('span', { text: '👤 ' + t('start.name') }), nameIn));
  else box.appendChild(h('div', { class: 'gfirst' }, h('div', { class: 'gsec', text: t('start.name') }), nameIn, h('div', { class: 'wsmeta', text: t('start.nameHelp') })));
  const needName = () => {
    const v = nameIn.value.trim();
    if (!v) { toast(t('start.nameRequired')); nameIn.classList.add('need'); nameIn.scrollIntoView({ block: 'center' }); nameIn.focus(); return null; }
    nameIn.classList.remove('need');
    if (v !== s.me) setUserName(v);
    return v;
  };

  // Continue: one big row per workspace (hotel · Full/Focus · year · role). The ID stays in the tooltip only.
  const list = await ctl.store.listWorkspaces();
  const visible = list.filter((w) => !w.hidden).sort((a, b) => String(b.lastOpenedAt).localeCompare(String(a.lastOpenedAt)));
  const hidden = list.filter((w) => w.hidden);
  // Opening shows progress on the row; anything that goes wrong is shown, never silent.
  const open = (w) => async (row) => {
    if (!needName() || row.classList.contains('busy')) return;
    row.classList.add('busy');
    // If opening hangs, say where it stopped instead of spinning forever.
    const slow = setTimeout(async () => {
      if (!row.isConnected || !row.classList.contains('busy')) return;
      const r = await modal({ title: t('start.openSlow'), body: h('div', null, h('p', { text: w.hotelName }), h('p', { class: 'ferr', text: t('start.openStep') + ': ' + (ctl.state.openStep || '?') + ' · v' + APP_VERSION }), h('p', { class: 'wsmeta', text: t('start.openSlowHelp') })), buttons: [{ label: t('start.keepWaiting'), value: null }, { label: t('start.reload'), cls: 'btn-p', value: 'reload' }] });
      if (r === 'reload') location.reload();
    }, 10000);
    try { await openWorkspace(w.wsId); clearTimeout(slow); } catch (e) {
      clearTimeout(slow);
      row.classList.remove('busy');
      await modal({ title: t('start.openFailed'), body: h('div', null, h('p', { text: w.hotelName }), h('p', { class: 'ferr', text: String((e && (e.message || e.name)) || e).slice(0, 300) }), h('p', { class: 'wsmeta', text: t('start.openFailedHelp') })), buttons: [{ label: t('btn.close'), cls: 'btn-p', value: null }] });
    }
  };
  const del = (w) => () => deleteFromStart(ctl, w);
  if (visible.length) box.appendChild(h('div', { class: 'gsec', text: t('start.continue') }));
  box.appendChild(h('div', { class: 'wslist' }, visible.map((w) => wsRow(w, open(w), del(w)))));
  if (hidden.length) {
    box.appendChild(h('details', { class: 'ghidden' }, h('summary', { text: t('start.hidden', { n: hidden.length }) }),
      h('div', { class: 'wslist' }, hidden.map((w) => wsRow(w, open(w), del(w))))));
  }

  // Start something new by what you do (reviewer / preparer / results). Folded away when there is work to continue.
  const savedFinals = await new FinalStore('view').open().then((fs) => fs.all()).catch(() => []);
  const nSaved = new Set(savedFinals.map((r) => r.wsId)).size;
  const card = (cls, icon, title, desc, ...btns) => h('div', { class: 'rcard ' + cls }, h('div', { class: 'rc-ic', text: icon }), h('b', { text: title }), h('p', { text: desc }), ...btns);
  const cards = h('div', { class: 'rcards' },
    card('rc-reviewer', '📝', t('start.card.reviewer'), t('start.card.reviewerDesc'),
      h('button', { class: 'gbtn', text: t('start.newCsa'), onclick: () => { const me = needName(); if (me) newCsaDialog(ctl, me); } }),
      h('button', { class: 'gbtn link', text: t('start.fromExport'), onclick: () => { const me = needName(); if (me) newFromExport(ctl, me, { openWorkspace }); } })),
    card('rc-preparer', '✍️', t('start.card.preparer'), t('start.card.preparerDesc'),
      h('button', { class: 'gbtn', text: t('start.loadAssignment'), onclick: () => { const me = needName(); if (me) fileDialog(ctl, 'assignment', me); } })),
    card('rc-result', '👁', t('start.card.result'), t('start.card.resultDesc'),
      h('button', { class: 'gbtn', text: t('start.openFinal'), onclick: () => fileDialog(ctl, 'final') }),
      nSaved ? h('button', { class: 'gbtn link', text: t('start.viewSaved') + ` (${nSaved})`, onclick: () => openDof(null) }) : null));
  const restore = h('div', { class: 'grestore' }, h('button', { class: 'gbtn link', text: t('start.restoreLink'), onclick: () => { const me = needName(); if (me) fileDialog(ctl, 'backup', me); } }));
  const newer = h('details', { class: 'gnew' }, h('summary', { text: t('start.newOrOpen') }), h('div', { class: 'gsec', text: t('start.whatDo') }), cards, restore);
  if (!visible.length) { newer.open = true; newer.classList.add('solo'); }   // nothing to continue: no fold, just the choices
  box.appendChild(newer);
  box.appendChild(langRow(() => renderStart(ctl)));
}

function wsRow(w, onOpen, onDelete) {
  const go = () => onOpen(row);
  const row = h('div', { class: 'wsrow', tabindex: '0', role: 'button', title: 'ID ' + w.wsId.slice(0, 6), onclick: go, onkeydown: (e) => { if (e.key === 'Enter' && e.target === row) go(); } },
    h('div', { class: 'wsname' }, w.hotelName,
      h('div', { class: 'wsmeta', text: `${w.serviceType === 'full' ? 'Full' : 'Focus'} · ${w.year} · ${t('start.lastOpened')} ${fmtTime(w.lastOpenedAt)}` })),
    h('span', { class: 'wsrole r-' + w.role, text: t('role.' + w.role) }),
    w.finalized ? h('span', { class: 'badge st st-approved', text: t('final.badge') }) : null,
    h('span', { class: 'wsopening', text: t('start.opening') }),
    h('button', { class: 'wsdel', type: 'button', title: t('start.delete'), 'aria-label': t('start.delete') + ' ' + w.hotelName, text: t('start.delete'), onclick: (e) => { e.stopPropagation(); onDelete(); } }),
    h('span', { class: 'wsgo', text: '›' }));
  row.style.borderLeftColor = w.color || '';
  return row;
}

// Newer deploy than the code running in this tab (a tab left open keeps the old code until reloaded).
async function newerVersion() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const v = r.ok ? (await r.json()).version : null;
    return v && v !== APP_VERSION ? v : null;
  } catch { return null; }
}

// Delete from the start screen: one warning dialog. A workspace with any entries is downloaded as a full backup first,
// so a mistaken delete can be undone with "Restore from a full backup".
async function deleteFromStart(ctl, w) {
  const lock = await tryEditLock(w.wsId);
  if (!lock) { await modal({ title: t('start.delTitle'), body: h('p', { text: t('start.delBusy', { hotel: w.hotelName }) }), buttons: [{ label: t('btn.close'), cls: 'btn-p', value: null }] }); return; }
  try {
    const doc = await ctl.store.load(w.wsId);
    if (!doc) return;
    const history = await ctl.store.history(w.wsId);
    const n = Object.values(doc.items).filter((i) => i.updatedAt || (i.status && i.status !== 'empty')).length;
    const hasData = n > 0 || history.some((e) => e.action !== 'create');
    const ok = await modal({
      title: t('start.delTitle'),
      body: h('div', null,
        h('p', { class: 'delname', text: `${doc.hotelName} · ${doc.serviceType === 'full' ? 'Full' : 'Focus'} · ${doc.year} · ${t('role.' + (doc.local?.role || 'reviewer'))}` }),
        h('p', { class: 'ferr', text: t('start.delWarn') }),
        h('p', { text: hasData ? t('start.delHasData', { n }) : t('start.delEmpty') })),
      buttons: [{ label: t('btn.cancel'), value: false }, { label: t('start.delOk'), cls: 'btn-n', value: true }],
    });
    if (!ok) return;
    if (hasData) download(JSON.stringify(await buildFile('backup', doc, backupPayload(doc, history))), fileName('backup', doc));
    await ctl.store.deleteWorkspace(w.wsId);
    if (sessionStorage.getItem('jkmcsa.current') === w.wsId) sessionStorage.removeItem('jkmcsa.current');
    toast(hasData ? t('start.deletedBackup') : t('backup.deleted'));
  } catch (e) {
    toast(t('err.' + (e.code || 'storage')));
  } finally {
    lock.release();
  }
  renderStart(ctl);
}

async function newCsaDialog(ctl, me) {
  let svc = 'full';
  const nameIn = h('input', { type: 'text', maxlength: '120', placeholder: t('start.hotelPh') });
  const cards = h('div', { class: 'svc-cards' });
  const drawCards = () => {
    clear(cards);
    for (const k of ['full', 'focus']) {
      const set = getItemSet(itemSetIdFor(k, YEAR));
      cards.appendChild(h('button', { class: 'svc-card' + (svc === k ? ' act' : ''), onclick: () => { svc = k; drawCards(); } },
        h('b', { text: k === 'full' ? 'Full Service' : 'Focus Service' }), h('span', { text: t('start.items', { n: set.items.length }) })));
    }
  };
  drawCards();
  const ok = await modal({
    title: t('start.newCsa'),
    body: h('div', null, h('p', { text: t('start.newCsaHelp') }), h('div', { class: 'fl', text: t('start.hotel') }), nameIn, h('div', { class: 'fl', text: t('start.service') }), cards, h('p', { class: 'wsmeta', text: t('start.year') + ': ' + YEAR })),
    buttons: [{ label: t('btn.cancel'), value: false }, { label: t('btn.create'), cls: 'btn-p', value: true, validate: () => { if (!nameIn.value.trim()) { nameIn.focus(); return false; } return true; } }],
    onMount: () => nameIn.focus(),
  });
  if (!ok) return;
  const doc = createWorkspace({ hotelName: nameIn.value.trim(), serviceType: svc, year: YEAR, itemSetId: itemSetIdFor(svc, YEAR), by: me });
  try {
    await ctl.store.create(doc);
    await ctl.store.appendHistory([{ wsId: doc.wsId, itemId: null, at: doc.createdAt, by: me, role: 'reviewer', action: 'create', detail: { hotelName: doc.hotelName, serviceType: svc } }]);
    openWorkspace(doc.wsId);
  } catch (e) { toast(t('err.' + (e.code || 'storage'))); }
}

// Start-screen file loading: assignment (preparer), final (Hotel DOF), backup (restore).
async function fileDialog(ctl, kind, me) {
  const status = h('div', { class: 'mbody-status' });
  let close;
  const onFiles = async ([f]) => {
    if (!f) return;
    clear(status);
    try {
      const file = await readAndVerify(f.text, { mode: 'start' });
      if (file.kind !== kind) throw Object.assign(new Error(), { code: 'wrongKindHere' });
      if (kind === 'assignment') await startFromAssignment(ctl, file, me);
      else if (kind === 'final') { close(null); openDof(file); return; }
      else await restoreBackup(ctl, file, me);
      close(null);
    } catch (e) {
      status.appendChild(h('p', { class: 'ferr', text: `${f.name}: ${t('ferr.' + (e.code || 'corrupt'))}` }));
    }
  };
  await modal({
    title: t('start.file.' + kind),
    body: h('div', null, h('p', { text: t('start.fileHelp.' + kind) }), dropZone(t('files.drop'), onFiles, { multiple: false }), status),
    buttons: [{ label: t('btn.close'), value: null }],
    onMount: (m) => { close = m.close; },
  });
}

async function startFromAssignment(ctl, file, me) {
  const names = file.payload.assignment.members || [];
  let name = me;
  if (!names.includes(me)) {
    const sel = h('select', null, h('option', { value: me, text: me + ' ' + t('start.notInList') }), names.map((n) => h('option', { value: n, text: n })));
    const pick = await modal({ title: t('start.whoAreYou'), body: h('div', null, h('p', { text: t('start.notAssignedHelp', { name: me }) }), sel), buttons: [{ label: t('btn.cancel'), value: null }, { label: t('btn.ok'), cls: 'btn-p', value: () => sel.value }] });
    if (!pick) return;
    name = pick;
    if (name !== me) await setUserName(name);
  }
  const existing = await ctl.store.load(file.workspace.wsId).catch(() => null);
  if (existing) {
    if (existing.local.role !== 'preparer') throw Object.assign(new Error(), { code: 'ownWorkspace' });
    await ctl.store.snapshot(existing, 'before-import');
    const r = await applyAssignment({ ...existing, local: { ...existing.local, me: name } }, file);
    await ctl.store.save(r.doc, { allowShrink: true });
    await ctl.store.appendHistory(r.events);
    toast(t('start.assignmentUpdated'));
  } else {
    const r = await workspaceFromAssignment(file, name);
    await ctl.store.create(r.doc);
    await ctl.store.appendHistory(r.events);
  }
  openWorkspace(file.workspace.wsId);
}

export async function restoreBackup(ctl, file, me) {
  const p = file.payload;
  const existing = await ctl.store.load(file.workspace.wsId).catch(() => null);
  if (existing) {
    const ok = await modal({ title: t('start.restoreBackup'), body: h('p', { text: t('start.replaceConfirm', { hotel: existing.hotelName, at: fmtTime(existing.savedAt), file: fmtTime(file.createdAt) }) }), buttons: [{ label: t('btn.cancel'), value: false }, { label: t('btn.replace'), cls: 'btn-n', value: true }] });
    if (!ok) return;
  }
  const doc = { ...p.doc, local: existing ? existing.local : { role: p.role || 'reviewer', me, hidden: false, lastOpenedAt: new Date().toISOString(), color: null } };
  if (!doc.local.color) { const { colorFor } = await import('./model.js'); doc.local.color = colorFor(doc.wsId); }
  await ctl.store.replaceFromBackup(doc, p.history || [], existing);
  toast(t('backup.restored'));
  openWorkspace(doc.wsId);
}
