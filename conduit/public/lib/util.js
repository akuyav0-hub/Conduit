// Small shared helpers: encoding, formatting, events, ordered queues.

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function b64u(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64url');
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomId = (bytes = 12) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export const fmtSpeed = (bps) => (bps > 0 ? `${fmtBytes(bps)}/s` : '—');

export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 1) return '<1s';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}

export function fmtAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export class Emitter {
  constructor() { this._h = new Map(); }
  on(evt, fn) {
    if (!this._h.has(evt)) this._h.set(evt, new Set());
    this._h.get(evt).add(fn);
    return () => this._h.get(evt)?.delete(fn);
  }
  emit(evt, ...args) {
    for (const fn of this._h.get(evt) || []) {
      try { fn(...args); } catch (e) { console.error(`[${evt}]`, e); }
    }
  }
}

// Runs async tasks one after another, in the order they were queued.
export function serial() {
  let chain = Promise.resolve();
  return (task) => {
    const p = chain.then(task, task);
    chain = p.catch(() => {});
    return p;
  };
}

// Measures throughput over a short sliding window.
export class Meter {
  constructor(windowMs = 3000) { this.w = windowMs; this.s = []; }
  add(total) {
    const t = performance.now();
    this.s.push([t, total]);
    while (this.s.length > 2 && t - this.s[0][0] > this.w) this.s.shift();
  }
  rate() {
    const s = this.s;
    if (s.length < 2) return 0;
    const [t0, b0] = s[0];
    const [t1, b1] = s[s.length - 1];
    return t1 - t0 > 250 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
  }
  reset() { this.s = []; }
}

// Strip anything that could escape a folder or break a filename on Windows/macOS/Linux.
export function safeName(name) {
  let n = String(name || 'file').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').trim();
  n = n.replace(/^\.+$/, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  return (n || 'file').slice(0, 200);
}

export function safePath(path) {
  return String(path || '')
    .split(/[/\\]+/)
    .filter((p) => p && p !== '.' && p !== '..')
    .map(safeName)
    .slice(0, 32)
    .join('/')
    .slice(0, 600);
}

export function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
