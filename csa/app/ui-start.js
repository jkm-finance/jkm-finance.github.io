// Start screen: user name, workspace list, new CSA, assignment / final / backup files (SPEC §3).
import { YEAR, APP_VERSION } from './version.js';
import { h, clear, modal, dropZone, toast, fmtTime } from './dom.js';
import { t } from './i18n.js';
import { createWorkspace } from './model.js';
import { itemSetIdFor, getItemSet } from './itemsets.js';
import { readAndVerify } from './files.js';
import { workspaceFromAssignment, applyAssignment } from './merge.js';
import { openWorkspace, setUserName, langRow, openDof } from './main.js';

export async function renderStart(ctl) {
  const root = clear(document.getElementById('root'));
  const s = ctl.state;
  const box = h('div', { class: 'gbox wide' });
  root.appendChild(h('div', { class: 'gate' }, box));

  box.appendChild(h('div', { class: 'glogo' }, h('span', { class: 'csa-badge', text: 'CSA' }), t('app.title')));
  box.appendChild(h('div', { class: 'gsub', text: t('app.subtitle') + ' · v' + APP_VERSION }));

  const nameIn = h('input', { class: 'gin', value: s.me || '', placeholder: t('start.namePh'), maxlength: '80', 'aria-label': t('start.name') });
  nameIn.addEventListener('change', () => setUserName(nameIn.value.trim()));
  box.appendChild(h('div', { class: 'gsec', text: t('start.name') }));
  box.appendChild(nameIn);
  const needName = () => {
    const v = nameIn.value.trim();
    if (!v) { toast(t('start.nameRequired')); nameIn.focus(); return null; }
    if (v !== s.me) setUserName(v);
    return v;
  };

  const list = await ctl.store.listWorkspaces();
  const visible = list.filter((w) => !w.hidden).sort((a, b) => String(b.lastOpenedAt).localeCompare(String(a.lastOpenedAt)));
  const hidden = list.filter((w) => w.hidden);
  box.appendChild(h('div', { class: 'gsec', text: t('start.myWorkspaces') }));
  if (!visible.length) box.appendChild(h('div', { class: 'wsmeta', text: t('start.noWorkspaces') }));
  box.appendChild(h('div', { class: 'wslist' }, visible.map((w) => wsRow(w, () => { if (needName()) openWorkspace(w.wsId); }))));
  if (hidden.length) {
    box.appendChild(h('details', null, h('summary', { text: t('start.hidden', { n: hidden.length }) }),
      h('div', { class: 'wslist' }, hidden.map((w) => wsRow(w, () => { if (needName()) openWorkspace(w.wsId); })))));
  }

  box.appendChild(h('div', { class: 'gsec', text: t('start.begin') }));
  box.appendChild(h('div', { class: 'gacts' },
    h('button', { class: 'gbtn', text: t('start.newCsa'), onclick: () => { const me = needName(); if (me) newCsaDialog(ctl, me); } }),
    h('button', { class: 'gbtn alt', text: t('start.loadAssignment'), onclick: () => { const me = needName(); if (me) fileDialog(ctl, 'assignment', me); } }),
    h('button', { class: 'gbtn alt', text: t('start.openFinal'), onclick: () => fileDialog(ctl, 'final') }),
    h('button', { class: 'gbtn alt', text: t('start.restoreBackup'), onclick: () => { const me = needName(); if (me) fileDialog(ctl, 'backup', me); } })));
  box.appendChild(langRow(() => renderStart(ctl)));
}

function wsRow(w, onOpen) {
  const row = h('div', { class: 'wsrow', tabindex: '0', role: 'button', onclick: onOpen, onkeydown: (e) => { if (e.key === 'Enter') onOpen(); } },
    h('div', { class: 'wsname' }, w.hotelName,
      h('div', { class: 'wsmeta', text: `${w.serviceType === 'full' ? 'Full' : 'Focus'} · ${w.year} · ${t('role.' + w.role)} · ${t('start.lastOpened')} ${fmtTime(w.lastOpenedAt)} · ID ${w.wsId.slice(0, 6)}` })),
    w.finalized ? h('span', { class: 'badge st st-approved', text: t('final.badge') }) : null);
  row.style.borderLeftColor = w.color || '';
  return row;
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
