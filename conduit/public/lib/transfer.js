// The transfer engine.
//
// The sender reads files from disk in 4 MB blocks and streams them over a WebRTC data channel.
// Two brakes keep it fast without flooding anything:
//   1. the channel's own send buffer (pause above 8 MB, resume below 2 MB), and
//   2. a window of bytes the receiver hasn't written to disk yet (48 MB), so a slow disk on
//      the other end never piles data up in memory.
// If the connection drops, the receiver reports exactly how far it got and the sender carries
// on from that byte — no restarting a 20 GB file from zero.

import { Emitter, randomId, Meter, safeName, safePath, fmtBytes, fmtSpeed, fmtDuration } from './util.js';
import { openSink } from './sinks.js';

const MB = 1024 * 1024;
const BLOCK = 4 * MB;
const HIGH_WATER = 8 * MB;
const LOW_WATER = 2 * MB;
const WINDOW = 48 * MB;
const FLUSH = 2 * MB;
const OFFER_PAGE = 48 * 1024;
const MAX_FILES = 20000;
const STALE_IN_MS = 30 * 60e3;
const FINAL = new Set(['done', 'declined', 'canceled', 'failed']);
const CLOSED = Symbol('closed');
const STALE = Symbol('stale');
const TID_RE = /^[A-Za-z0-9_-]{8,20}$/;

export const isFinal = (b) => FINAL.has(b.status);

export class Transfers extends Emitter {
  // host provides: link(id), isOnline(id), nameOf(id), log(msg), decide(batch),
  //                sinkMode(batch, gesture), received(batch, file, result), record(batch), folder
  constructor(host) {
    super();
    this.host = host;
    this.out = new Map();
    this.in = new Map();
    this.retryTimers = new Map();
    this.soon = new Map();
    setInterval(() => this.sweep(), 60e3);
  }

  all() { return [...this.out.values(), ...this.in.values()]; }
  get(tid) { return this.out.get(tid) || this.in.get(tid); }
  activeWith(peer) { return this.all().some((b) => b.peer === peer && !isFinal(b)); }
  anyMoving() { return this.all().some((b) => b.status === 'sending' || b.status === 'receiving'); }
  name(b) { return this.host.nameOf(b.peer); }

  changed(b, throttled = false) {
    if (!throttled) {
      clearTimeout(this.soon.get(b.tid));
      this.soon.delete(b.tid);
      this.emit('update', b);
      return;
    }
    if (this.soon.has(b.tid)) return;
    this.soon.set(b.tid, setTimeout(() => { this.soon.delete(b.tid); this.emit('update', b); }, 200));
  }

  note(b, text) { b.note = text; this.changed(b); }

  // ───────────────────────────── sending ─────────────────────────────

  send(peer, items) {
    const files = items.slice(0, MAX_FILES).map((it, i) => ({
      i,
      file: it.file,
      name: safeName(it.file.name),
      path: safePath(it.dir || ''),
      size: it.file.size,
      type: String(it.file.type || '').slice(0, 100),
      done: false,
    }));
    if (!files.length) return null;
    const b = {
      tid: randomId(9), dir: 'out', peer, files,
      total: files.reduce((s, f) => s + f.size, 0),
      pos: 0, acked: 0, status: 'queued', note: '', created: Date.now(), started: 0, finished: 0,
      gen: 0, dc: null, wake: null, syncedOn: null, speed: new Meter(),
    };
    this.out.set(b.tid, b);
    this.host.log(`queued ${files.length} file${files.length > 1 ? 's' : ''} (${fmtBytes(b.total)}) for ${this.name(b)}`);
    this.changed(b);
    this.kick(peer);
    return b;
  }

  async kick(peer) {
    const waiting = [...this.out.values()].filter((b) => b.peer === peer && !isFinal(b) && b.status !== 'sending');
    if (!waiting.length) return;
    if (!this.host.isOnline(peer)) {
      const away = this.host.isAway?.(peer);
      for (const b of waiting) {
        this.note(b, away ? `Waiting for ${this.name(b)} to open Conduit (it's in the background on their phone)`
          : b.status === 'queued' ? `Waiting for ${this.name(b)} to come online` : `Paused until ${this.name(b)} reconnects`);
      }
      return;
    }
    const link = this.host.link(peer);
    if (link.isOpen) { this.onLinkOpen(peer); return; }
    for (const b of waiting) if (b.status === 'queued') this.note(b, 'Connecting…');
    try {
      await link.ensure();
    } catch (e) {
      const noPath = /network path|failed/.test(e.message);
      const who = this.host.nameOf(peer);
      for (const b of waiting) {
        if (!isFinal(b)) {
          this.note(b, noPath ? `No network path to ${who} yet. Retrying.`
            : `${who} isn't answering. Conduit may be closed or in the background on their device. Retrying.`);
        }
      }
      if (noPath) this.host.log(`no direct path to ${who}: one of you is behind a strict firewall or carrier NAT. Turning on the TURN relay fixes this (see README).`);
      this.retryLater(peer, 8000);
    }
  }

  retryLater(peer, ms) {
    clearTimeout(this.retryTimers.get(peer));
    this.retryTimers.set(peer, setTimeout(() => this.kick(peer), ms));
  }

  onLinkOpen(peer) {
    const link = this.host.link(peer);
    for (const b of this.out.values()) {
      if (b.peer !== peer || isFinal(b)) continue;
      if (b.status === 'queued') this.offer(b, link);
      else if (b.syncedOn !== link.localSid) {
        b.syncedOn = link.localSid;
        link.sendCtrl({ t: 'sync', tid: b.tid });
      }
    }
  }

  offer(b, link) {
    b.status = 'offered';
    b.syncedOn = link.localSid;
    b.note = `Waiting for ${this.name(b)} to accept`;
    let page = [];
    let bytes = 0;
    let first = true;
    const flush = () => {
      link.sendCtrl(first
        ? { t: 'offer', tid: b.tid, n: b.files.length, total: b.total, files: page }
        : { t: 'offer-more', tid: b.tid, files: page });
      first = false;
      page = [];
      bytes = 0;
    };
    for (const f of b.files) {
      const meta = { name: f.name, path: f.path, size: f.size, type: f.type };
      const s = JSON.stringify(meta).length;
      if (bytes + s > OFFER_PAGE && page.length) flush();
      page.push(meta);
      bytes += s;
    }
    flush();
    this.changed(b);
  }

  offsetOf(b, fi) {
    let n = 0;
    for (let i = 0; i < fi; i++) n += b.files[i].size;
    return n;
  }

  async pump(b, link, fi, o) {
    if (!(fi >= 0 && fi < b.files.length) || !(o >= 0 && o <= b.files[fi].size)) {
      this.endOut(b, 'failed', 'Received a bad resume point');
      return;
    }
    const gen = ++b.gen;
    if (b.dc) { const old = b.dc; b.dc = null; try { old.close(); } catch { /* ignore */ } }
    b.files.forEach((f) => { f.done = f.i < fi; });
    b.pos = b.acked = this.offsetOf(b, fi) + o;
    b.status = 'sending';
    b.note = '';
    b.started ||= Date.now();
    b.speed.reset();
    this.changed(b);

    let dc;
    try { dc = link.openData(`x|${b.tid}`); } catch { this.interruptOut(b, gen, 'link not ready'); return; }
    b.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onbufferedamountlow = () => b.wake?.();
    dc.onclose = () => {
      if (b.dc !== dc) return;
      b.dc = null;
      b.wake?.();
      this.interruptOut(b, gen, 'data channel closed');
    };

    try {
      await opened(dc, 20000);
      const chunk = link.maxChunk();
      if (b.pos > 0) this.host.log(`resuming "${b.files[fi].name}" at ${fmtBytes(o)}`);
      for (let i = fi; i < b.files.length; i++) {
        const f = b.files[i];
        let off = i === fi ? o : 0;
        // A browser can report a file it can't open as empty; probe so it fails loudly instead.
        if (f.size === 0) await f.file.slice(0, 1).arrayBuffer().catch((e) => { throw Object.assign(new Error(f.name), { name: e.name || 'NotReadableError' }); });
        await this.room(b, dc, gen);
        dc.send(JSON.stringify({ f: i, o: off }));
        let next = off < f.size ? readBlock(f.file, off) : null;
        while (off < f.size) {
          const buf = await next;
          if (!buf.byteLength) throw Object.assign(new Error('empty read'), { name: 'NotReadableError' });
          const end = off + buf.byteLength;
          next = end < f.size ? readBlock(f.file, end) : null;
          for (let p = 0; p < buf.byteLength; p += chunk) {
            await this.room(b, dc, gen);
            const len = Math.min(chunk, buf.byteLength - p);
            dc.send(new Uint8Array(buf, p, len));
            b.pos += len;
          }
          off = end;
        }
        await this.room(b, dc, gen);
        dc.send(JSON.stringify({ e: i }));
      }
    } catch (e) {
      if (e === STALE || b.gen !== gen || isFinal(b)) return;
      if (e.name === 'NotReadableError' || e.name === 'NotFoundError') {
        const which = b.files.find((f) => !f.done && e.message === f.name)?.name;
        this.cancel(b.tid, `couldn't read ${which ? `“${which}”` : 'a file'} (moved, renamed or changed?)`, 'failed');
        return;
      }
      this.interruptOut(b, gen, e.message);
    }
  }

  async room(b, dc, gen) {
    for (;;) {
      if (b.gen !== gen || isFinal(b)) throw STALE;
      if (dc.readyState !== 'open') throw new Error('data channel closed');
      if (dc.bufferedAmount < HIGH_WATER && b.pos - b.acked < WINDOW) return;
      await new Promise((resolve) => {
        const t = setTimeout(done, 1000);
        function done() {
          clearTimeout(t);
          if (b.wake === done) b.wake = null;
          resolve();
        }
        b.wake = done;
      });
    }
  }

  interruptOut(b, gen, reason) {
    if (b.gen !== gen || isFinal(b) || b.status === 'interrupted') return;
    b.gen++;
    if (b.dc) { try { b.dc.close(); } catch { /* ignore */ } b.dc = null; }
    b.status = 'interrupted';
    b.syncedOn = null;
    b.note = 'Connection dropped. Resumes on its own when it’s back.';
    b.speed.reset();
    this.host.log(`transfer to ${this.name(b)} paused: ${reason}`);
    this.changed(b);
    this.retryLater(b.peer, 2500);
  }

  finishOut(b) {
    if (isFinal(b)) return;
    b.gen++;
    b.status = 'done';
    b.finished = Date.now();
    b.acked = b.total;
    const secs = (b.finished - b.started) / 1000;
    b.note = `Delivered in ${fmtDuration(secs)}`;
    this.host.log(`sent ${fmtBytes(b.total)} to ${this.name(b)} in ${fmtDuration(secs)} (avg ${fmtSpeed(b.total / Math.max(secs, 0.001))})`);
    const dc = b.dc;
    b.dc = null;
    setTimeout(() => { try { dc?.close(); } catch { /* ignore */ } }, 1000);
    this.host.record(b);
    this.changed(b);
  }

  endOut(b, status, note) {
    if (isFinal(b)) return;
    b.gen++;
    b.status = status;
    b.note = note;
    b.finished = Date.now();
    if (b.dc) { try { b.dc.close(); } catch { /* ignore */ } b.dc = null; }
    b.wake?.();
    this.host.log(`transfer to ${this.name(b)}: ${note}`);
    this.host.record(b);
    this.changed(b);
  }

  // ───────────────────────────── receiving ─────────────────────────────

  onOffer(peer, m, link) {
    if (typeof m.tid !== 'string' || !TID_RE.test(m.tid)) return;
    const existing = this.in.get(m.tid);
    if (existing) {
      if (existing.peer === peer) this.reportState(existing, link);
      return;
    }
    if (!Number.isSafeInteger(m.n) || m.n < 1 || m.n > MAX_FILES || !Array.isArray(m.files)) return;
    const b = {
      tid: m.tid, dir: 'in', peer, n: m.n, files: [], total: 0, written: 0,
      status: 'collecting', note: '', created: Date.now(), started: 0, finished: 0, interruptedAt: 0,
      cur: 0, queue: [], busy: false, dc: null, buf: null, bufLen: 0, skip: 0, idleWaiters: [],
      mode: 'inbox', speed: new Meter(),
    };
    this.in.set(b.tid, b);
    this.addFiles(b, m.files);
  }

  onOfferMore(peer, m) {
    const b = this.in.get(m.tid);
    if (b && b.peer === peer && b.status === 'collecting' && Array.isArray(m.files)) this.addFiles(b, m.files);
  }

  addFiles(b, list) {
    for (const f of list) {
      if (b.files.length >= b.n) break;
      const size = Number(f?.size);
      if (!Number.isSafeInteger(size) || size < 0) { this.endIn(b, 'failed', 'Received an invalid file list'); return; }
      b.files.push({
        i: b.files.length, name: safeName(f.name), path: safePath(f.path), size,
        type: String(f.type || '').slice(0, 100), written: 0, done: false, sink: null,
      });
      b.total += size;
    }
    if (b.files.length === b.n && b.status === 'collecting') {
      b.status = 'pending';
      b.note = 'Waiting for you to accept';
      this.host.log(`${this.name(b)} wants to send ${b.n} file${b.n > 1 ? 's' : ''} (${fmtBytes(b.total)})`);
      this.changed(b);
      this.host.decide(b);
    }
  }

  async accept(tid, { gesture = false } = {}) {
    const b = this.in.get(tid);
    if (!b || b.status !== 'pending') return;
    b.status = 'accepted';
    b.note = 'Starting…';
    b.started = Date.now();
    this.changed(b);
    try { b.mode = await this.host.sinkMode(b, gesture); } catch { b.mode = 'inbox'; }
    if (isFinal(b)) return;
    if (!this.host.link(b.peer).sendCtrl({ t: 'accept', tid })) {
      b.status = 'interrupted';
      b.interruptedAt = Date.now();
      b.note = 'Accepted. Waiting for the connection.';
      this.changed(b);
    }
  }

  decline(tid) {
    const b = this.in.get(tid);
    if (!b || isFinal(b)) return;
    this.host.link(b.peer).sendCtrl({ t: 'decline', tid });
    this.endIn(b, 'declined', 'You declined');
  }

  onDataChannel(peer, dc) {
    const m = /^x\|([A-Za-z0-9_-]{8,20})$/.exec(dc.label);
    const b = m && this.in.get(m[1]);
    if (!b || b.peer !== peer || !['accepted', 'receiving', 'interrupted'].includes(b.status)) {
      try { dc.close(); } catch { /* ignore */ }
      return;
    }
    const old = b.dc;
    b.dc = dc;
    if (old) { try { old.close(); } catch { /* ignore */ } }
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (e) => { if (b.dc === dc) this.enqueue(b, e.data); };
    dc.onclose = () => { if (b.dc === dc) { b.dc = null; this.enqueue(b, CLOSED); } };
    if (b.status !== 'receiving') {
      b.status = 'receiving';
      b.note = '';
      b.speed.reset();
      this.changed(b);
    }
  }

  enqueue(b, item) {
    b.queue.push(item);
    if (!b.busy) this.drain(b);
  }

  async drain(b) {
    b.busy = true;
    try {
      while (b.queue.length) {
        const item = b.queue.shift();
        if (isFinal(b)) { b.queue.length = 0; break; }
        if (item === CLOSED) {
          await this.flush(b);
          this.interruptIn(b);
        } else if (typeof item === 'string') {
          await this.onHeader(b, JSON.parse(item));
        } else {
          await this.onChunk(b, item);
        }
      }
    } catch (e) {
      if (!isFinal(b)) {
        const why = e.name === 'QuotaExceededError' ? 'Out of storage space on this device' : e.message || String(e);
        this.cancel(b.tid, why, 'failed');
      }
    } finally {
      b.busy = false;
      for (const r of b.idleWaiters.splice(0)) r();
    }
  }

  idle(b) { return b.busy ? new Promise((r) => b.idleWaiters.push(r)) : Promise.resolve(); }

  async onHeader(b, h) {
    if (Number.isInteger(h.f)) {
      await this.flush(b);
      const f = b.files[h.f];
      if (!f || f.done) throw new Error('bad file header');
      if (b.files.slice(0, h.f).some((x) => !x.done)) throw new Error('files arrived out of order');
      if (!Number.isSafeInteger(h.o) || h.o < 0 || h.o > f.written) throw new Error('gap in received data');
      b.cur = h.f;
      b.skip = f.written - h.o; // bytes we already have (only after a reconnect race)
      if (!f.sink) f.sink = await openSink(b, f, this.host);
    } else if (Number.isInteger(h.e)) {
      await this.flush(b);
      const f = b.files[h.e];
      if (!f || f.done || h.e !== b.cur) throw new Error('bad end-of-file marker');
      if (f.written !== f.size) throw new Error(`size mismatch on ${f.name}`);
      if (!f.sink) f.sink = await openSink(b, f, this.host);
      const result = await f.sink.close();
      f.sink = null;
      f.done = true;
      await this.host.received(b, f, result);
      this.host.link(b.peer).sendCtrl({ t: 'fdone', tid: b.tid, i: f.i });
      if (b.files.every((x) => x.done)) this.finishIn(b);
    }
  }

  async onChunk(b, ab) {
    const f = b.files[b.cur];
    if (!f || !f.sink || f.done) throw new Error('data arrived before its file header');
    let u8 = new Uint8Array(ab);
    if (b.skip) {
      const s = Math.min(b.skip, u8.length);
      b.skip -= s;
      u8 = u8.subarray(s);
      if (!u8.length) return;
    }
    if (f.written + b.bufLen + u8.length > f.size) throw new Error(`more data than expected for ${f.name}`);
    let p = 0;
    while (p < u8.length) {
      if (!b.buf) { b.buf = new Uint8Array(FLUSH); b.bufLen = 0; }
      const n = Math.min(FLUSH - b.bufLen, u8.length - p);
      b.buf.set(u8.subarray(p, p + n), b.bufLen);
      b.bufLen += n;
      p += n;
      if (b.bufLen === FLUSH) await this.flush(b);
    }
  }

  async flush(b) {
    if (!b.bufLen) return;
    const f = b.files[b.cur];
    const buf = b.buf;
    const n = b.bufLen;
    b.buf = null;
    b.bufLen = 0;
    await f.sink.write(buf, n);
    f.written += n;
    b.written += n;
    b.speed.add(b.written);
    this.host.link(b.peer).sendCtrl({ t: 'ack', tid: b.tid, b: b.written });
    this.changed(b, true);
  }

  interruptIn(b) {
    if (isFinal(b) || b.status === 'interrupted' || b.status === 'pending' || b.status === 'collecting') return;
    b.status = 'interrupted';
    b.interruptedAt = Date.now();
    b.note = 'Connection dropped. Resumes on its own when it’s back.';
    b.speed.reset();
    this.changed(b);
  }

  async reportState(b, link) {
    if (b.status === 'collecting' || b.status === 'pending') { link.sendCtrl({ t: 'state', tid: b.tid, s: 'pending' }); return; }
    if (isFinal(b)) { link.sendCtrl({ t: 'state', tid: b.tid, s: b.status }); return; }
    if (b.dc) {
      const old = b.dc;
      b.dc = null;
      try { old.close(); } catch { /* ignore */ }
      this.enqueue(b, CLOSED);
    }
    await this.idle(b);
    if (isFinal(b)) { link.sendCtrl({ t: 'state', tid: b.tid, s: b.status }); return; }
    const fi = b.files.findIndex((f) => !f.done);
    if (fi < 0) return;
    link.sendCtrl({ t: 'state', tid: b.tid, s: 'resume', fi, o: b.files[fi].written });
  }

  finishIn(b) {
    if (isFinal(b)) return;
    b.status = 'done';
    b.finished = Date.now();
    const secs = (b.finished - b.started) / 1000;
    b.note = `Received in ${fmtDuration(secs)}`;
    this.host.log(`received ${fmtBytes(b.total)} from ${this.name(b)} in ${fmtDuration(secs)} (avg ${fmtSpeed(b.total / Math.max(secs, 0.001))})`);
    const dc = b.dc;
    b.dc = null;
    setTimeout(() => { try { dc?.close(); } catch { /* ignore */ } }, 1000);
    this.host.record(b);
    this.changed(b);
  }

  endIn(b, status, note) {
    if (isFinal(b)) return;
    b.status = status;
    b.note = note;
    b.finished = Date.now();
    b.queue.length = 0;
    b.buf = null;
    b.bufLen = 0;
    if (b.dc) { try { b.dc.close(); } catch { /* ignore */ } b.dc = null; }
    for (const f of b.files) {
      if (f.sink) { const s = f.sink; f.sink = null; s.abort(); }
    }
    this.host.log(`transfer from ${this.name(b)}: ${note}`);
    this.host.record(b);
    this.changed(b);
  }

  // ───────────────────────────── both sides ─────────────────────────────

  cancel(tid, why = '', status = 'canceled') {
    const b = this.get(tid);
    if (!b || isFinal(b)) return;
    this.host.link(b.peer).sendCtrl({ t: 'cancel', tid, s: status, why });
    const note = status === 'failed' ? `Failed: ${why}` : why || 'You canceled';
    if (b.dir === 'out') this.endOut(b, status, note); else this.endIn(b, status, note);
  }

  onCtrl(peer, m, link) {
    if (!m || typeof m.t !== 'string') return;
    const out = this.out.get(m.tid);
    const mine = out && out.peer === peer ? out : null;
    switch (m.t) {
      case 'offer': this.onOffer(peer, m, link); break;
      case 'offer-more': this.onOfferMore(peer, m); break;
      case 'sync': {
        const b = this.in.get(m.tid);
        if (b && b.peer === peer) this.reportState(b, link);
        else link.sendCtrl({ t: 'state', tid: m.tid, s: 'unknown' });
        break;
      }
      case 'accept':
        if (mine && mine.status === 'offered') this.pump(mine, link, 0, 0);
        break;
      case 'decline':
        if (mine) this.endOut(mine, 'declined', `${this.name(mine)} declined`);
        break;
      case 'ack':
        if (mine && Number.isSafeInteger(m.b) && m.b > mine.acked) {
          mine.acked = Math.min(m.b, mine.total);
          mine.speed.add(mine.acked);
          mine.wake?.();
          this.changed(mine, true);
        }
        break;
      case 'fdone':
        if (mine && Number.isInteger(m.i) && mine.files[m.i]) {
          mine.files[m.i].done = true;
          if (mine.files.every((f) => f.done)) this.finishOut(mine);
        }
        break;
      case 'state': this.onState(peer, m, link); break;
      case 'cancel': {
        const b = this.get(m.tid);
        if (!b || b.peer !== peer || isFinal(b)) break;
        const status = m.s === 'failed' ? 'failed' : 'canceled';
        const why = typeof m.why === 'string' ? m.why.slice(0, 200) : '';
        const note = `${status === 'failed' ? 'Failed' : 'Canceled'} by ${this.name(b)}${why ? `: ${why}` : ''}`;
        if (b.dir === 'out') this.endOut(b, status, note); else this.endIn(b, status, note);
        break;
      }
      default:
    }
  }

  onState(peer, m, link) {
    const b = this.out.get(m.tid);
    if (!b || b.peer !== peer || isFinal(b)) return;
    switch (m.s) {
      case 'pending':
        b.status = 'offered';
        this.note(b, `Waiting for ${this.name(b)} to accept`);
        break;
      case 'resume':
        if (Number.isInteger(m.fi) && Number.isSafeInteger(m.o)) this.pump(b, link, m.fi, m.o);
        break;
      case 'done': this.finishOut(b); break;
      case 'declined': this.endOut(b, 'declined', `${this.name(b)} declined`); break;
      case 'canceled': this.endOut(b, 'canceled', `Canceled by ${this.name(b)}`); break;
      case 'failed': this.endOut(b, 'failed', `Failed on ${this.name(b)}'s side`); break;
      case 'unknown':
        if (b.status === 'offered' || b.status === 'queued') this.offer(b, link);
        else this.endOut(b, 'failed', `${this.name(b)}'s app restarted mid-transfer. Send it again.`);
        break;
      default:
    }
  }

  onLinkDown(peer) {
    let retry = false;
    for (const b of this.out.values()) {
      if (b.peer !== peer || isFinal(b)) continue;
      retry = true;
      if (b.status === 'sending') this.interruptOut(b, b.gen, 'link down');
      else b.syncedOn = null;
    }
    for (const b of this.in.values()) {
      if (b.peer !== peer || isFinal(b)) continue;
      if (b.dc) {
        const old = b.dc;
        b.dc = null;
        this.enqueue(b, CLOSED);
        try { old.close(); } catch { /* ignore */ }
      } else if (b.status === 'receiving' || b.status === 'accepted') {
        this.interruptIn(b);
      }
    }
    if (retry) this.retryLater(peer, 2500);
  }

  // Forget receives whose sender vanished long ago.
  sweep() {
    const now = Date.now();
    for (const b of this.in.values()) {
      if (b.status === 'interrupted' && now - b.interruptedAt > STALE_IN_MS) {
        this.endIn(b, 'failed', `${this.name(b)} never came back`);
      }
    }
  }
}

function readBlock(file, off) {
  const p = file.slice(off, Math.min(off + BLOCK, file.size)).arrayBuffer();
  p.catch(() => {});
  return p;
}

function opened(dc, ms) {
  if (dc.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('data channel did not open')), ms);
    dc.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    dc.addEventListener('close', () => { clearTimeout(t); reject(new Error('data channel closed')); }, { once: true });
  });
}
