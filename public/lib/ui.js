// DOM helpers: element builder, icons, sheets (modal dialogs), toasts, QR codes.

import { encode } from '../vendor/uqr.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'vars') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const PATHS = {
  out: 'M6.5 17.5 17.5 6.5M9 6.5h8.5V15',
  in: 'M17.5 6.5 6.5 17.5M15 17.5H6.5V9',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  friends: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5M15.5 4.4a3.5 3.5 0 0 1 0 6.3M18 14.8c2 .7 3.2 2.5 3.5 5.2',
  inbox: 'M3 13l3-8h12l3 8M3 13v6h18v-6M3 13h5l1.5 2.5h5L16 13h5',
  you: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c.8-4 4-6.5 8-6.5s7.2 2.5 8 6.5',
  log: 'M3.5 5h17v14h-17zM7 9.5l2.5 2.5L7 14.5M12 15h5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  share: 'M12 3v12M7.5 7.5 12 3l4.5 4.5M5 12v8h14v-8',
  save: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  folder: 'M3 6h6l2 2h10v11H3z',
  retry: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5',
};

export function icon(name) {
  const el = svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'square', 'stroke-linejoin': 'miter', 'aria-hidden': 'true', focusable: 'false' });
  el.append(svg('path', { d: PATHS[name] || '' }));
  return el;
}

export function openSheet(build, { label = 'Dialog', onClose } = {}) {
  const dlg = h('dialog', { class: 'sheet', 'aria-label': label });
  const inner = h('div', { class: 'sheet-inner' });
  dlg.append(inner);
  document.getElementById('sheet-root').append(dlg);
  const api = {
    el: dlg,
    close() { if (dlg.open) dlg.close(); },
    set(content) { inner.replaceChildren(...[content].flat(Infinity).filter(Boolean)); },
  };
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) api.close(); });
  api.set(build(api));
  dlg.showModal();
  return api;
}

export function sheetHead(title, sheet, { plate = false } = {}) {
  return h('div', { class: 'sheet-head' },
    plate
      ? h('div', { class: 'plate' }, h('span', { class: 'plate-text' }, title))
      : h('h2', { class: 'sheet-title' }, title),
    h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => sheet.close() }, icon('x')));
}

export function toast(text, { bad = false, ms = 4200 } = {}) {
  const t = h('div', { class: bad ? 'toast bad' : 'toast', role: bad ? 'alert' : 'status' }, text);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

export function confirmSheet({ title, body, yes, danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    openSheet((sheet) => [
      sheetHead(title, sheet),
      body ? h('p', { class: 'lede' }, body) : null,
      h('div', { class: 'row' },
        h('button', { class: danger ? 'btn danger' : 'btn go', onclick: () => { answer = true; sheet.close(); } }, yes),
        h('button', { class: 'btn quiet', onclick: () => sheet.close() }, 'Keep it')),
    ], { label: title, onClose: () => resolve(answer) });
  });
}

export function qrSvg(text) {
  const { size, data } = encode(text, { ecc: 'M', border: 0 });
  let d = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y][x]) { x++; continue; }
      let run = 1;
      while (x + run < size && data[y][x + run]) run++;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run;
    }
  }
  const el = svg('svg', { viewBox: `0 0 ${size} ${size}`, 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': 'QR code of the invite link' });
  el.append(svg('path', { d, fill: '#000' }));
  return el;
}
