// DOM helpers. All text goes in through textContent — never innerHTML — so imported
// file content can never run as script (SPEC §13).

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'why') continue;
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    // A disabled control says why (UI-08): `why` becomes the tooltip only while disabled.
    if (attrs.disabled && attrs.why) { el.title = attrs.why; el.setAttribute('aria-description', attrs.why); }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else if (k instanceof Node) el.appendChild(k);
    else el.appendChild(document.createTextNode(String(k)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function $(sel, root = document) { return root.querySelector(sel); }

export function toast(text, ms = 2600) {
  const t = h('div', { class: 'toast', role: 'status', text });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Modal dialog. buttons: [{ label, cls, value, disabled }]. Resolves with the clicked value (or null on close).
export function modal({ title, body, buttons = [], wide = false, closable = true, onMount }) {
  return new Promise((resolve) => {
    const bg = h('div', { class: 'modal-bg' });
    const done = (v) => { bg.remove(); document.removeEventListener('keydown', esc); resolve(v); };
    const esc = (e) => { if (e.key === 'Escape' && closable) done(null); };
    const foot = h('div', { class: 'mfoot' });
    const btnEls = buttons.map((b) => {
      const el = h('button', { class: 'btn ' + (b.cls || 'btn-l'), disabled: b.disabled, text: b.label, onclick: async () => {
        if (b.validate && !(await b.validate())) return;
        done(typeof b.value === 'function' ? b.value() : b.value);
      } });
      foot.appendChild(el);
      return el;
    });
    const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'mhdr' }, h('span', { text: title }), closable ? h('button', { class: 'x', 'aria-label': 'close', text: '×', onclick: () => done(null) }) : null),
      h('div', { class: 'mbody' }, body),
      buttons.length ? foot : null);
    bg.appendChild(box);
    document.body.appendChild(bg);
    document.addEventListener('keydown', esc);
    if (onMount) onMount({ buttons: btnEls, close: done, box });
  });
}

export function download(text, name, type = 'application/json') {
  const blob = text instanceof Blob ? text : new Blob([text], { type: type + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// File picker + drag & drop area. onFiles receives [{ name, text }].
export function dropZone(label, onFiles, { multiple = true, accept = '.json,application/json', binary = false } = {}) {
  const input = h('input', { type: 'file', accept, multiple, class: 'hidden' });
  const zone = h('div', { class: 'drop', tabindex: '0', role: 'button', text: label });
  const read = async (list) => {
    const out = [];
    for (const f of list) out.push(binary ? { name: f.name, file: f, size: f.size } : { name: f.name, text: await f.text(), size: f.size });
    onFiles(out);
  };
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); read([...e.dataTransfer.files]); });
  input.addEventListener('change', () => { read([...input.files]); input.value = ''; });
  return h('div', null, zone, input);
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function pct(v) { return v === null || v === undefined ? '—' : (Math.round(v * 10) / 10) + '%'; }
