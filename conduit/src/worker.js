// Conduit signaling hub — a Cloudflare Worker plus one Durable Object.
//
// The hub only introduces devices to each other. File bytes never pass through it:
// they go browser-to-browser over WebRTC (or through a TURN relay, still end-to-end encrypted).
// Every message the hub relays is signed by the sender's device key, so the hub can't forge
// or alter anything without the receiving browser noticing and dropping it.

import { DurableObject } from 'cloudflare:workers';

const MAX_FRAME = 64 * 1024;                // largest signaling frame we relay
const MAILBOX_TTL = 7 * 24 * 3600 * 1000;   // queued friend requests live for 7 days
const MAILBOX_PER_RECIPIENT = 100;
const MAILBOX_PER_PAIR = 5;
const WATCH_MAX = 1000;                     // max friends one device can watch for presence
const RATE_BURST = 300;                     // messages a socket may send in a burst
const RATE_REFILL_PER_MS = 0.06;            // ~60 messages per second sustained
const TURN_TTL = 12 * 3600;                 // seconds a TURN credential stays valid
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
// A connection that hasn't pinged in this long is treated as gone (laptop asleep, phone locked,
// tab killed). Apps ping every 25 s; a throttled background tab still pings about once a minute.
const STALE_MS = 150 * 1000;
const SWEEP_MS = 60 * 1000;

const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      const origin = request.headers.get('Origin');
      if (origin && !originAllowed(origin, url, env)) {
        return new Response('Origin not allowed', { status: 403 });
      }
      const hub = env.HUB.get(env.HUB.idFromName('main'));
      return hub.fetch(request);
    }

    if (url.pathname === '/api/health') {
      return Response.json(
        { ok: true, turn: Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return env.ASSETS.fetch(request);
  },
};

function originAllowed(origin, url, env) {
  try {
    const o = new URL(origin);
    if (o.host === url.host) return true;
    const extra = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    return extra.includes(o.origin);
  } catch {
    return false;
  }
}

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS watch (
      owner TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (owner, target)) WITHOUT ROWID`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS watch_by_target ON watch (target, owner)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mailbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, rcpt TEXT NOT NULL, sender TEXT NOT NULL,
      data TEXT NOT NULL, exp INTEGER NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS mailbox_by_rcpt ON mailbox (rcpt, seq)`);
    // Keepalive pings are answered without waking the object up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.rates = new WeakMap();
    this.dead = new WeakSet();
    this.iceCache = new Map();
    this.byId = null;
  }

  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const nonce = b64u(crypto.getRandomValues(new Uint8Array(24)));
    server.serializeAttachment({ nonce, id: null, opened: Date.now() });
    server.send(JSON.stringify({ t: 'challenge', nonce }));
    await this.armSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_FRAME) return this.fail(ws, 'bad-frame');
    if (!this.allow(ws)) return this.reply(ws, { t: 'err', e: 'rate-limited' });
    let msg;
    try { msg = JSON.parse(raw); } catch { return this.fail(ws, 'bad-json'); }
    const att = attachment(ws);
    if (!att.id) {
      if (msg.t === 'auth') return this.auth(ws, att, msg);
      return this.fail(ws, 'auth-required');
    }
    switch (msg.t) {
      case 'send': return this.relay(ws, att.id, msg);
      case 'watch': return this.setWatch(ws, att.id, msg.ids, true);
      case 'mail-ack': return this.ackMail(att.id, msg.seq);
      case 'away': return this.setAway(ws, att, !!msg.away);
      case 'ice': return this.reply(ws, { t: 'ice', ice: await this.iceFor(att.id, true) });
      default: return this.reply(ws, { t: 'err', e: 'unknown-type' });
    }
  }

  async webSocketClose(ws) {
    this.closed(ws);
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
  }

  async webSocketError(ws) {
    this.closed(ws);
  }

  closed(ws) {
    const att = attachment(ws);
    // getWebSockets() can still list a socket while it closes, so mark it dead explicitly.
    this.dead.add(ws);
    try { ws.serializeAttachment({ id: null, closed: true }); } catch { /* already gone */ }
    this.byId = null;
    if (att.id && !this.sockets().has(att.id)) this.announce(att.id, false);
  }

  // ---- auth: prove you hold the private key behind your device id ----
  async auth(ws, att, msg) {
    let pub, sig;
    try { pub = unb64u(String(msg.pub)); sig = unb64u(String(msg.sig)); } catch { return this.fail(ws, 'bad-auth'); }
    if (pub.length !== 65 || pub[0] !== 4 || sig.length !== 64 || !att.nonce) return this.fail(ws, 'bad-auth');
    let ok = false;
    try {
      const key = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, enc.encode('conduit-auth|' + att.nonce));
    } catch { ok = false; }
    if (!ok) return this.fail(ws, 'bad-signature');

    const id = b64u((await sha256(pub)).slice(0, 16));
    // One live session per device identity: the newest connection wins (e.g. a second tab).
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws && attachment(other).id === id) {
        other.serializeAttachment({ id: null, replaced: true });
        try { other.close(4000, 'replaced'); } catch { /* ignore */ }
      }
    }
    ws.serializeAttachment({ id, since: Date.now(), away: false });
    this.byId = null;
    if (Array.isArray(msg.watch)) this.setWatch(ws, id, msg.watch, false);

    const { online, away } = this.presenceFor(id);
    // The hub's clock lets devices with a wrong clock still agree on message timestamps.
    this.reply(ws, { t: 'ready', id, online, away, now: Date.now(), ice: await this.iceFor(id) });
    this.announce(id, true, false);
    this.deliverMail(ws, id);
  }

  // ---- relay a signed message to another device (or queue it if allowed) ----
  relay(ws, from, msg) {
    const { to, ref } = msg;
    if (typeof to !== 'string' || !ID_RE.test(to) || msg.data === undefined) {
      return ref && this.reply(ws, { t: 'err', e: 'bad-message', ref });
    }
    const frame = JSON.stringify({ t: 'msg', from, data: msg.data });
    if (frame.length > MAX_FRAME) return ref && this.reply(ws, { t: 'err', e: 'too-large', ref });

    const target = this.sockets().get(to);
    if (target) {
      safeSend(target, frame);
      return ref && this.reply(ws, { t: 'sent', ref });
    }
    if (!msg.queue) return ref && this.reply(ws, { t: 'offline', ref });

    const now = Date.now();
    this.sql.exec('DELETE FROM mailbox WHERE exp < ?', now);
    const perRcpt = this.sql.exec('SELECT COUNT(*) AS n FROM mailbox WHERE rcpt = ?', to).one().n;
    const perPair = this.sql.exec('SELECT COUNT(*) AS n FROM mailbox WHERE rcpt = ? AND sender = ?', to, from).one().n;
    if (perRcpt >= MAILBOX_PER_RECIPIENT || perPair >= MAILBOX_PER_PAIR) {
      return ref && this.reply(ws, { t: 'err', e: 'mailbox-full', ref });
    }
    this.sql.exec('INSERT INTO mailbox (rcpt, sender, data, exp) VALUES (?, ?, ?, ?)',
      to, from, JSON.stringify(msg.data), now + MAILBOX_TTL);
    return ref && this.reply(ws, { t: 'queued', ref });
  }

  deliverMail(ws, id) {
    const rows = this.sql.exec(
      'SELECT seq, sender, data FROM mailbox WHERE rcpt = ? AND exp >= ? ORDER BY seq', id, Date.now()).toArray();
    for (const r of rows) {
      safeSend(ws, JSON.stringify({ t: 'msg', from: r.sender, data: JSON.parse(r.data), queued: true, seq: r.seq }));
    }
  }

  ackMail(id, seq) {
    if (Number.isSafeInteger(seq)) this.sql.exec('DELETE FROM mailbox WHERE rcpt = ? AND seq <= ?', id, seq);
  }

  // ---- presence: you only see friends who also have you in their list (mutual) ----
  setWatch(ws, owner, ids, respond) {
    if (!Array.isArray(ids)) return;
    const clean = [...new Set(ids.filter((x) => typeof x === 'string' && ID_RE.test(x) && x !== owner))]
      .slice(0, WATCH_MAX);
    const before = new Set(this.mutual(owner));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM watch WHERE owner = ?', owner);
      for (const t of clean) this.sql.exec('INSERT INTO watch (owner, target) VALUES (?, ?)', owner, t);
    });
    const after = this.mutual(owner);
    const afterSet = new Set(after);
    const map = this.sockets();
    const ownerOnline = map.has(owner);
    for (const p of after) {
      if (!before.has(p) && ownerOnline) {
        const s = map.get(p);
        if (s) safeSend(s, JSON.stringify({ t: 'presence', id: owner, online: true, away: !!attachment(map.get(owner)).away }));
      }
    }
    for (const p of before) {
      if (!afterSet.has(p)) {
        const s = map.get(p);
        if (s) safeSend(s, JSON.stringify({ t: 'presence', id: owner, online: false }));
      }
    }
    if (respond) this.reply(ws, { t: 'presence-list', ...this.presenceFor(owner) });
  }

  mutual(id) {
    return this.sql.exec(
      `SELECT a.owner AS peer FROM watch a
       JOIN watch b ON b.owner = ? AND b.target = a.owner
       WHERE a.target = ?`, id, id).toArray().map((r) => r.peer);
  }

  presenceFor(id) {
    const map = this.sockets();
    const online = this.mutual(id).filter((p) => map.has(p));
    return { online, away: online.filter((p) => attachment(map.get(p)).away) };
  }

  // Phones report when Conduit goes to the background, since they can't answer from there.
  setAway(ws, att, away) {
    if (!!att.away === away) return;
    ws.serializeAttachment({ ...att, away });
    this.announce(att.id, true, away);
  }

  async armSweep() {
    if ((await this.ctx.storage.getAlarm()) == null) {
      await this.ctx.storage.setAlarm(Date.now() + (Number(this.env.SWEEP_MS) || SWEEP_MS));
    }
  }

  // Drops connections that went silent, so friends stop showing as online when they aren't.
  async alarm() {
    const now = Date.now();
    const staleAfter = Number(this.env.STALE_MS) || STALE_MS;
    let live = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (this.dead.has(ws)) continue;
      const att = attachment(ws);
      if (!att.id) {
        if (att.opened && now - att.opened > 30000) { try { ws.close(4001, 'auth timeout'); } catch { /* gone */ } this.closed(ws); }
        else if (att.opened) live++;
        continue;
      }
      const ping = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0;
      if (now - Math.max(ping, att.since || 0) > staleAfter) {
        try { ws.close(4002, 'stale'); } catch { /* gone */ }
        this.closed(ws);
      } else {
        live++;
      }
    }
    if (live) await this.ctx.storage.setAlarm(Date.now() + (Number(this.env.SWEEP_MS) || SWEEP_MS));
  }

  announce(id, online, away = false) {
    const peers = this.mutual(id);
    if (!peers.length) return;
    const map = this.sockets();
    const frame = JSON.stringify({ t: 'presence', id, online, away: online && away });
    for (const p of peers) {
      const s = map.get(p);
      if (s) safeSend(s, frame);
    }
  }

  sockets() {
    if (!this.byId) {
      const m = new Map();
      for (const ws of this.ctx.getWebSockets()) {
        if (this.dead.has(ws)) continue;
        if (typeof ws.readyState === 'number' && ws.readyState > 1) continue;
        const a = attachment(ws);
        if (a.id) m.set(a.id, ws);
      }
      this.byId = m;
    }
    return this.byId;
  }

  // ---- ICE servers: free Cloudflare STUN always; TURN relay only for devices with a confirmed friend ----
  async iceFor(id, fresh = false) {
    const stun = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
    const { TURN_KEY_ID, TURN_KEY_API_TOKEN } = this.env;
    if (!TURN_KEY_ID || !TURN_KEY_API_TOKEN) return stun;
    if (!this.mutual(id).length) return stun;
    const cached = this.iceCache.get(id);
    if (!fresh && cached && cached.exp > Date.now()) return cached.ice;
    try {
      const r = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: TURN_TTL }),
        });
      if (!r.ok) throw new Error('TURN API ' + r.status);
      const j = await r.json();
      const list = Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers];
      // Browsers block port 53, so those URLs would only add a timeout.
      const ice = list
        .map((s) => ({ ...s, urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)) }))
        .filter((s) => s.urls.length);
      this.iceCache.set(id, { ice, exp: Date.now() + (TURN_TTL * 1000) / 2 });
      return ice;
    } catch {
      return stun;
    }
  }

  // ---- helpers ----
  allow(ws) {
    const now = Date.now();
    let b = this.rates.get(ws);
    if (!b) { b = { tokens: RATE_BURST, at: now }; this.rates.set(ws, b); }
    b.tokens = Math.min(RATE_BURST, b.tokens + (now - b.at) * RATE_REFILL_PER_MS);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  reply(ws, obj) { safeSend(ws, JSON.stringify(obj)); }

  fail(ws, e) {
    this.reply(ws, { t: 'err', e });
    try { ws.close(4001, e); } catch { /* ignore */ }
  }
}

function attachment(ws) {
  try { return ws.deserializeAttachment() || {}; } catch { return {}; }
}

function safeSend(ws, s) {
  try { ws.send(s); } catch { /* socket closing */ }
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(str) {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64url');
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
