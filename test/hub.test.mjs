// Protocol test for the signaling hub. Run with: node test/hub.test.mjs ws://127.0.0.1:8787/ws
const URL_WS = process.argv[2] || 'ws://127.0.0.1:8787/ws';
const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failures++; };

async function identity() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const id = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)).slice(0, 16));
  return { kp, pub: b64u(raw), id };
}

function client(ident, watch = [], { badSig = false } = {}) {
  const ws = new WebSocket(URL_WS);
  const inbox = [];
  const waiters = [];
  ws.onmessage = async (e) => {
    if (e.data === 'pong') return;
    const m = JSON.parse(e.data);
    if (m.t === 'challenge') {
      let sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ident.kp.privateKey, enc.encode('conduit-auth|' + m.nonce)));
      if (badSig) sig[5] ^= 0xff;
      ws.send(JSON.stringify({ t: 'auth', pub: ident.pub, sig: b64u(sig), watch }));
      return;
    }
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  };
  const closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
  const next = (pred, ms = 3000) => {
    const hit = inbox.find(pred);
    if (hit) { inbox.splice(inbox.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((res) => {
      const w = { pred, res: (m) => { inbox.splice(inbox.indexOf(m), 1); res(m); } };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); res(null); } }, ms);
    });
  };
  const send = (o) => ws.send(JSON.stringify(o));
  return { ws, next, send, closed, inbox };
}

const A = await identity(), B = await identity(), C = await identity();

console.log('auth + mutual presence');
const a = client(A, [B.id]);
const ra = await a.next((m) => m.t === 'ready');
ok(ra && ra.id === A.id, 'A authenticates and gets its id back');
ok(Array.isArray(ra?.ice) && ra.ice.length > 0, 'A receives STUN servers');
ok(Number.isFinite(ra?.now) && Math.abs(ra.now - Date.now()) < 5000, 'A receives the hub clock (fixes devices with a wrong clock)');
const b = client(B, [A.id]);
const rb = await b.next((m) => m.t === 'ready');
ok(rb && rb.online.includes(A.id), 'B sees A online (mutual watch)');
const pa = await a.next((m) => m.t === 'presence' && m.id === B.id);
ok(pa && pa.online === true, 'A is told B came online');

console.log('background status');
b.send({ t: 'away', away: true });
const aw = await a.next((m) => m.t === 'presence' && m.id === B.id && m.away === true);
ok(aw && aw.online === true, 'A sees B as online but in the background');
b.send({ t: 'away', away: false });
const back = await a.next((m) => m.t === 'presence' && m.id === B.id && m.away === false);
ok(!!back, 'A sees B come back');

console.log('relay');
a.send({ t: 'send', to: B.id, data: { hello: 1 }, ref: 'r1' });
const mb = await b.next((m) => m.t === 'msg');
ok(mb && mb.from === A.id && mb.data.hello === 1, 'B receives A\'s message with hub-attested sender');
const ack = await a.next((m) => m.ref === 'r1');
ok(ack && ack.t === 'sent', 'A gets delivery ack');

console.log('non-mutual watcher learns nothing');
const c = client(C, [A.id]);
const rc = await c.next((m) => m.t === 'ready');
ok(rc && !rc.online.includes(A.id), 'C (not A\'s friend) does not see A online');
const leak = await a.next((m) => m.t === 'presence' && m.id === C.id, 800);
ok(!leak, 'A is not told about C');

console.log('offline mailbox');
b.ws.close();
const off = await a.next((m) => m.t === 'presence' && m.id === B.id && m.online === false);
ok(!!off, 'A is told B went offline');
a.send({ t: 'send', to: B.id, data: { req: 'friend' }, queue: true, ref: 'r2' });
const q = await a.next((m) => m.ref === 'r2');
ok(q && q.t === 'queued', 'message for offline B is queued');
a.send({ t: 'send', to: B.id, data: { x: 1 }, ref: 'r3' });
const o = await a.next((m) => m.ref === 'r3');
ok(o && o.t === 'offline', 'non-queued message to offline B reports offline');
const b2 = client(B, [A.id]);
await b2.next((m) => m.t === 'ready');
const mail = await b2.next((m) => m.t === 'msg' && m.queued);
ok(mail && mail.data.req === 'friend' && Number.isInteger(mail.seq), 'B gets queued mail on reconnect');
b2.send({ t: 'mail-ack', seq: mail.seq });
await new Promise((r) => setTimeout(r, 200));

console.log('one session per identity');
const b3 = client(B, [A.id]);
await b3.next((m) => m.t === 'ready');
const code = await b2.closed;
ok(code === 4000, 'older session for the same identity is replaced (code 4000)');
const again = await b3.next((m) => m.t === 'msg' && m.queued, 800);
ok(!again, 'acked mail is not redelivered');
const flap = await a.next((m) => m.t === 'presence' && m.id === B.id && m.online === false, 600);
ok(!flap, 'replacement does not announce B offline');

console.log('security');
const evil = client(await identity(), [], { badSig: true });
const err = await evil.next((m) => m.t === 'err');
ok(err && err.e === 'bad-signature', 'bad signature is rejected');
ok((await evil.closed) === 4001, 'and the socket is closed');
const spoof = new WebSocket(URL_WS);
const spoofMsgs = [];
spoof.onmessage = (e) => spoofMsgs.push(JSON.parse(e.data));
await new Promise((r) => (spoof.onopen = r));
spoof.send(JSON.stringify({ t: 'send', to: A.id, data: {} }));
const spoofClose = await new Promise((r) => (spoof.onclose = (e) => r(e.code)));
ok(spoofClose === 4001 && spoofMsgs.some((m) => m.e === 'auth-required'), 'unauthenticated relay is refused');

for (const x of [a, b3, c]) x.ws.close();
console.log(failures ? `\n${failures} FAILED` : '\nall hub tests passed');
process.exit(failures ? 1 : 0);
