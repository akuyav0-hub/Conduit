// Stale-connection sweep. Run the dev server with short timings first:
//   npx wrangler dev --var STALE_MS:4000 --var SWEEP_MS:1500
// then: node test/hub.liveness.mjs
const URL_WS = process.argv[2] || 'ws://127.0.0.1:8787/ws';
const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failures++; };
async function identity() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { kp, pub: b64u(raw), id: b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)).slice(0, 16)) };
}
function client(ident, watch, { pings }) {
  const ws = new WebSocket(URL_WS);
  const events = [];
  let timer;
  ws.onmessage = async (e) => {
    if (e.data === 'pong') return;
    const m = JSON.parse(e.data);
    if (m.t === 'challenge') {
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ident.kp.privateKey, enc.encode('conduit-auth|' + m.nonce)));
      ws.send(JSON.stringify({ t: 'auth', pub: ident.pub, sig: b64u(sig), watch }));
      if (pings) timer = setInterval(() => ws.readyState === 1 && ws.send('ping'), 1000);
      return;
    }
    events.push(m);
  };
  const closed = new Promise((r) => (ws.onclose = (e) => { clearInterval(timer); r(e.code); }));
  return { ws, events, closed };
}
const A = await identity(), B = await identity();
console.log('silent connections are dropped');
const a = client(A, [B.id], { pings: true });
const b = client(B, [A.id], { pings: false }); // like a laptop that went to sleep
await new Promise((r) => setTimeout(r, 1500));
ok(a.events.some((m) => m.t === 'presence' && m.id === B.id && m.online) || a.events.some((m) => m.t === 'ready' && m.online.includes(B.id)) || b.events.some((m) => m.t === 'ready' && m.online.includes(A.id)), 'both start out online');
const code = await Promise.race([b.closed, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
ok(code === 4002, `the silent connection is closed as stale (${code})`);
ok(a.events.some((m) => m.t === 'presence' && m.id === B.id && m.online === false), 'and its friend is told it went offline');
ok(a.ws.readyState === 1, 'the connection that keeps pinging stays open');
a.ws.close();
console.log(failures ? `\n${failures} FAILED` : '\nliveness test passed');
process.exit(failures ? 1 : 0);
