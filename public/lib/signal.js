// Connection to the hub. It authenticates this device, relays signed messages to friends,
// and reports which friends are online. Only small control messages pass through here —
// never file data.

import { Emitter, randomId, serial, unb64u } from './util.js';
import { sign, verify, fingerprint } from './identity.js';

// Message types the hub may hold for an offline friend (everything else needs both online).
const QUEUEABLE = new Set(['friend-request', 'friend-accept', 'friend-decline', 'friend-remove', 'profile']);
const MAX_SKEW = 10 * 60e3;
const MAX_QUEUED_AGE = 8 * 24 * 3600e3;
const DEFAULT_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

export class Signal extends Emitter {
  constructor(ident, lookupFriend) {
    super();
    this.ident = ident;
    this.lookupFriend = lookupFriend; // id -> friend record or null
    this.url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.ws = null;
    this.state = 'offline';
    this.wanted = false;
    this.backoff = 1000;
    this.watch = [];
    this.seen = new Map();
    this.outq = serial();
    this.inq = serial();
    this.refs = new Map();
    this.pending = [];
    this.ice = DEFAULT_ICE;
    this.iceAt = 0;
    this.skew = 0; // hub clock minus this device's clock
    // Phones and tablets freeze pages in the background, so they tell friends when that happens.
    this.freezes = matchMedia('(pointer: coarse)').matches;
    addEventListener('online', () => this.kick());
    addEventListener('pageshow', () => this.kick());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.freezes) this.raw({ t: 'away', away: true });
        return;
      }
      this.raw('ping');
      if (this.freezes) this.raw({ t: 'away', away: false });
      this.kick();
    });
  }

  // Time on the hub's clock, so a device whose clock is off still agrees with its friends.
  now() { return Date.now() + this.skew; }

  get online() { return this.state === 'online'; }

  start() { this.wanted = true; this.connect(); }

  kick() {
    if (!this.wanted || (this.ws && this.ws.readyState <= 1)) return;
    clearTimeout(this.retry);
    this.backoff = 1000;
    this.connect();
  }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    this.setState('connecting');
    let ws;
    try { ws = new WebSocket(this.url); } catch { this.scheduleRetry(); return; }
    this.ws = ws;
    ws.onmessage = (e) => this.onFrame(ws, e.data);
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      clearInterval(this.pinger);
      this.setState('offline');
      if (e.code === 4000) { this.wanted = false; this.emit('replaced'); return; }
      this.scheduleRetry();
    };
  }

  scheduleRetry() {
    if (!this.wanted) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), this.backoff + Math.random() * 400);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  async onFrame(ws, raw) {
    if (typeof raw !== 'string' || raw === 'pong') return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'challenge': {
        if (typeof m.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(m.nonce)) { ws.close(); return; }
        const sig = await sign(this.ident, 'conduit-auth|' + m.nonce);
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'auth', pub: this.ident.pub, sig, watch: this.watch }));
        return;
      }
      case 'ready': {
        if (m.id !== this.ident.id) { ws.close(); return; }
        this.backoff = 1000;
        if (Number.isFinite(m.now)) this.skew = m.now - Date.now();
        if (Math.abs(this.skew) > 120e3) {
          this.emit('log', `this device's clock is ${Math.round(Math.abs(this.skew) / 60e3)} min ${this.skew < 0 ? 'fast' : 'slow'}; using the server's time instead`);
        }
        this.setIce(m.ice);
        clearInterval(this.pinger);
        this.pinger = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 25000);
        this.setState('online');
        if (this.freezes && document.hidden) this.raw({ t: 'away', away: true });
        this.emit('presence-list', m.online || [], m.away || []);
        for (const p of this.pending.splice(0)) this.send(p.to, p.type, p.body, p.opts);
        return;
      }
      case 'presence': this.emit('presence', m.id, !!m.online, !!m.away); return;
      case 'presence-list': this.emit('presence-list', m.online || [], m.away || []); return;
      case 'ice': this.setIce(m.ice); return;
      case 'msg': this.inq(() => this.onMessage(m)); return;
      case 'sent': case 'queued': case 'offline': case 'err': {
        const done = m.ref && this.refs.get(m.ref);
        if (done) { this.refs.delete(m.ref); done(m); } else if (m.t === 'err') this.emit('log', `hub: ${m.e}`);
        return;
      }
      default:
    }
  }

  setIce(ice) {
    if (Array.isArray(ice) && ice.length) { this.ice = ice; this.iceAt = Date.now(); }
  }

  async onMessage(m) {
    const why = {};
    const msg = await this.open(m.from, m.data, why);
    if (m.seq) this.raw({ t: 'mail-ack', seq: m.seq });
    if (msg) {
      msg.queued = !!m.queued;
      this.emit('message', msg);
      return;
    }
    const friend = this.lookupFriend(m.from);
    const who = friend ? friend.nick || friend.name : `unknown device ${String(m.from).slice(0, 6)}…`;
    this.emit('log', `ignored a message from ${who}${why.reason ? `: ${why.reason}` : ''}`);
  }

  // Verifies a signed envelope. Only friends get through — plus friend requests, which are
  // checked separately against your invites.
  async open(from, data, why = {}) {
    const no = (reason) => { why.reason = reason; return null; };
    if (!data || typeof data.m !== 'string' || typeof data.s !== 'string' || data.m.length > 60000) return no('malformed');
    let env;
    try { env = JSON.parse(data.m); } catch { return no('malformed'); }
    if (!env || env.v !== 1 || env.to !== this.ident.id || env.from !== from || typeof env.type !== 'string') return no('not addressed to this device');
    const age = this.now() - env.ts;
    const maxAge = QUEUEABLE.has(env.type) ? MAX_QUEUED_AGE : MAX_SKEW;
    if (!(age < maxAge && age > -MAX_SKEW)) return no(`its timestamp is ${Math.round(Math.abs(age) / 60e3)} min ${age < 0 ? 'in the future' : 'old'} (a clock is wrong, or one of you is on an older version)`);
    if (typeof env.n !== 'string' || this.seen.has(env.n)) return no('duplicate');

    let pub = this.lookupFriend(env.from)?.pub || null;
    if (!pub && env.type === 'friend-request' && typeof env.body?.k === 'string') {
      try { if ((await fingerprint(unb64u(env.body.k))) === env.from) pub = env.body.k; } catch { /* malformed */ }
    }
    if (!pub) return no(env.type === 'friend-request' ? 'bad friend request' : 'not on your friends list');
    if (!(await verify(pub, 'conduit-sig|' + data.m, data.s))) return no('signature didn’t match the key you saved for them');
    this.remember(env.n);
    return { from: env.from, type: env.type, body: env.body ?? null, ts: env.ts, pub };
  }

  remember(n) {
    this.seen.set(n, Date.now());
    if (this.seen.size > 4000) {
      const cutoff = Date.now() - 2 * MAX_SKEW;
      for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k);
    }
  }

  // Signs and sends a message to one device. Order is preserved.
  async send(to, type, body, opts = {}) {
    const queue = !!opts.queue && QUEUEABLE.has(type);
    if (!this.online) {
      if (queue) { this.pending.push({ to, type, body, opts }); return { t: 'pending' }; }
      return { t: 'not-connected' };
    }
    const r = await this.outq(async () => {
      const env = { v: 1, from: this.ident.id, to, type, body, ts: this.now(), n: randomId(12) };
      const m = JSON.stringify(env);
      const s = await sign(this.ident, 'conduit-sig|' + m);
      const frame = { t: 'send', to, data: { m, s } };
      if (queue) frame.queue = true;
      let wait = null;
      if (queue || opts.track) {
        frame.ref = randomId(8);
        wait = new Promise((resolve) => {
          this.refs.set(frame.ref, resolve);
          setTimeout(() => { if (this.refs.delete(frame.ref)) resolve({ t: 'timeout' }); }, 10000);
        });
      }
      return { ok: this.raw(frame), wait };
    });
    if (!r.ok) {
      if (queue) { this.pending.push({ to, type, body, opts }); return { t: 'pending' }; }
      return { t: 'not-connected' };
    }
    return r.wait ? r.wait : { t: 'sent' };
  }

  raw(obj) {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    return true;
  }

  setWatch(ids) {
    this.watch = [...new Set(ids)];
    if (this.online) this.raw({ t: 'watch', ids: this.watch });
  }

  iceServers() {
    if (this.online && Date.now() - this.iceAt > 4 * 3600e3) this.raw({ t: 'ice' });
    return this.ice;
  }

  // Relay credentials are only issued once you have a confirmed friend, so ask again after one forms.
  refreshIce() {
    setTimeout(() => this.raw({ t: 'ice' }), 500);
  }
}
