// One WebRTC connection per friend, opened on demand and closed when idle.
//
// Uses the standard "perfect negotiation" pattern, plus a session id on every signal so that
// either side can start over (page reload, network switch, phone waking up) without the two
// ends getting stuck talking about different connections.

import { Emitter, randomId, serial } from './util.js';

const descJSON = (d) => ({ type: d.type, sdp: d.sdp });

export class PeerLink extends Emitter {
  constructor(host, peerId) {
    super();
    this.host = host; // { me, signal, log, nameOf }
    this.peer = peerId;
    this.polite = host.me.id < peerId;
    this.pc = null;
    this.ctrl = null;
    this.localSid = null;
    this.remoteSid = null;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.route = null;
    this.waiters = [];
    this.sq = serial();
    this.lastUsed = Date.now();
  }

  get name() { return this.host.nameOf(this.peer); }
  get isOpen() { return this.ctrl?.readyState === 'open'; }
  get state() { return this.isOpen ? 'open' : this.pc ? 'connecting' : 'idle'; }

  // Largest message the data channel accepts, capped at 256 KB.
  maxChunk() {
    const m = this.pc?.sctp?.maxMessageSize;
    return m > 0 ? Math.min(m, 256 * 1024) : 64 * 1024;
  }

  ensure(timeout = 30000) {
    this.lastUsed = Date.now();
    if (this.isOpen) return Promise.resolve(this);
    if (!this.pc || ['failed', 'closed'].includes(this.pc.connectionState)) this.create(null);
    return new Promise((resolve, reject) => {
      const w = {
        resolve: () => { clearTimeout(timer); resolve(this); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        // If they answered but nothing connected, the networks couldn't find a path to each other.
        const why = this.remoteSid ? 'no network path' : 'no answer';
        if (!this.isOpen) this.down(why);
        reject(new Error(why));
      }, timeout);
      this.waiters.push(w);
    });
  }

  create(remoteSid) {
    this.teardown('restarting');
    const pc = new RTCPeerConnection({ iceServers: this.host.signal.iceServers() });
    this.pc = pc;
    this.localSid = randomId(8);
    this.remoteSid = remoteSid;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.route = null;

    const ctrl = pc.createDataChannel('ctrl', { negotiated: true, id: 0, ordered: true });
    this.ctrl = ctrl;
    ctrl.onopen = () => {
      if (this.pc !== pc) return;
      this.host.log(`link open with ${this.name}`);
      for (const w of this.waiters.splice(0)) w.resolve();
      this.emit('open');
      this.emit('state');
      this.inspectRoute();
    };
    ctrl.onclose = () => { if (this.pc === pc) this.down('control channel closed'); };
    ctrl.onmessage = (e) => {
      if (this.pc !== pc) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      this.lastUsed = Date.now();
      this.emit('ctrl', m);
    };

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (this.pc === pc) {
          if (pc.localDescription.type === 'offer' && !this.remoteSid) this.host.log(`calling ${this.name}…`);
          this.signal('sdp', descJSON(pc.localDescription));
        }
      } catch (e) {
        this.host.log(`offer to ${this.name} failed: ${e.message}`);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (this.pc === pc && candidate && candidate.candidate) this.signal('ice', candidate.toJSON());
    };
    pc.ondatachannel = ({ channel }) => { if (this.pc === pc) this.emit('datachannel', channel); };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const s = pc.connectionState;
      this.emit('state');
      if (s === 'connected') this.inspectRoute();
      else if (s === 'failed') this.down('connection failed');
      else if (s === 'disconnected') {
        clearTimeout(this.discTimer);
        this.discTimer = setTimeout(() => {
          if (this.pc === pc && pc.connectionState === 'disconnected') {
            this.host.log(`link with ${this.name} is unstable — restarting ICE`);
            try { pc.restartIce(); } catch { /* older browser */ }
          }
        }, 3000);
      }
    };
    this.emit('state');
    return pc;
  }

  signal(type, d) {
    const body = { sid: this.localSid, rsid: this.remoteSid, d };
    const tracked = type === 'sdp' && d?.type === 'offer';
    const p = this.host.signal.send(this.peer, type, body, tracked ? { track: true } : {});
    if (tracked) {
      const sid = this.localSid;
      p.then((r) => {
        if (r.t === 'offline' && this.localSid === sid && !this.isOpen) this.down(`${this.name} is offline`, true);
      });
    }
  }

  onSignal(type, body) {
    return this.sq(() => this.handle(type, body).catch((e) => this.host.log(`signal error with ${this.name}: ${e.message}`)));
  }

  async handle(type, body) {
    const { sid, rsid, d } = body || {};
    if (typeof sid !== 'string') return;

    if (type === 'bye') {
      if (this.pc && sid === this.remoteSid) this.down(`${this.name} closed the link`, true);
      return;
    }

    if (type === 'sdp') {
      if (!d || typeof d.sdp !== 'string' || (d.type !== 'offer' && d.type !== 'answer')) return;
      if (d.type === 'offer') {
        const dead = !this.pc || ['failed', 'closed'].includes(this.pc.connectionState);
        if (dead || this.remoteSid !== sid) this.host.log(`${this.name} is calling`);
        if (dead) this.create(sid);
        else if (this.remoteSid !== sid) {
          // Both sides dialed at once: the impolite side keeps its own attempt.
          if (this.remoteSid === null && !this.polite) return;
          this.create(sid); // polite side yields, or the other side started over
        }
        const pc = this.pc;
        const collision = this.makingOffer || pc.signalingState !== 'stable';
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        await pc.setLocalDescription();
        if (this.pc === pc) this.signal('sdp', descJSON(pc.localDescription));
      } else {
        if (!this.pc || rsid !== this.localSid) return;
        if (this.remoteSid === null) { this.remoteSid = sid; this.host.log(`${this.name} answered, connecting…`); }
        if (this.remoteSid !== sid || this.pc.signalingState !== 'have-local-offer') return;
        await this.pc.setRemoteDescription(d);
      }
      return;
    }

    if (type === 'ice') {
      if (!this.pc || sid !== this.remoteSid || !d) return;
      try {
        await this.pc.addIceCandidate(d);
      } catch (e) {
        if (!this.ignoreOffer) this.host.log(`ICE candidate rejected: ${e.message}`);
      }
    }
  }

  sendCtrl(obj) {
    if (!this.isOpen) return false;
    try {
      this.ctrl.send(JSON.stringify(obj));
      this.lastUsed = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  openData(label) {
    if (!this.pc || !this.isOpen) throw new Error('link not open');
    return this.pc.createDataChannel(label, { ordered: true });
  }

  async inspectRoute() {
    const pc = this.pc;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      });
      if (!pair) {
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.selected || r.nominated)) pair ||= r;
        });
      }
      if (!pair || this.pc !== pc) return;
      const l = stats.get(pair.localCandidateId);
      const r = stats.get(pair.remoteCandidateId);
      const types = [l?.candidateType, r?.candidateType];
      const route = types.includes('relay') ? 'relay' : 'direct';
      if (route !== this.route) {
        this.route = route;
        this.host.log(`route to ${this.name}: ${route === 'relay' ? 'relayed through TURN (still end-to-end encrypted)' : 'direct peer-to-peer'} [${types.join(' ↔ ')}${l?.protocol ? ` / ${l.protocol}` : ''}]`);
        this.emit('state');
      }
    } catch { /* stats not available */ }
  }

  down(reason, fromRemote = false) {
    if (!this.pc) return;
    this.host.log(`link with ${this.name} closed: ${reason}`);
    if (!fromRemote) this.signal('bye', null);
    this.teardown(reason);
    for (const w of this.waiters.splice(0)) w.reject(new Error(reason));
  }

  close(reason = 'idle') { this.down(reason); }

  teardown(reason) {
    clearTimeout(this.discTimer);
    const pc = this.pc;
    if (!pc) return;
    this.pc = null;
    this.ctrl = null;
    this.route = null;
    try { pc.close(); } catch { /* ignore */ }
    this.emit('down', reason);
    this.emit('state');
  }
}
