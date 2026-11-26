// Device identity and the cryptography behind the friend allowlist.
//
// Each browser generates its own P-256 key pair on first launch. The private key is created
// non-extractable, so not even this app's own code can read it out — it can only sign with it.
// Your device id is a hash of your public key, so nobody can claim your id without your key.

import { db } from './db.js';
import { b64u, unb64u, enc, dec, sha256, randomId } from './util.js';

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

export async function fingerprint(pubRaw) {
  return b64u((await sha256(pubRaw)).slice(0, 16));
}

export async function loadIdentity() {
  let ident = await db.get('kv', 'identity');
  if (!ident) {
    const kp = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    ident = { privateKey: kp.privateKey, pub: b64u(raw), id: await fingerprint(raw), created: Date.now() };
    await db.put('kv', ident, 'identity');
  }
  return ident;
}

export async function sign(ident, text) {
  return b64u(await crypto.subtle.sign(SIGN, ident.privateKey, enc.encode(text)));
}

const keyCache = new Map();
async function importPub(pubB64) {
  let key = keyCache.get(pubB64);
  if (!key) {
    key = await crypto.subtle.importKey('raw', unb64u(pubB64), ECDSA, false, ['verify']);
    keyCache.set(pubB64, key);
  }
  return key;
}

export async function verify(pubB64, text, sigB64) {
  try {
    return await crypto.subtle.verify(SIGN, await importPub(pubB64), unb64u(sigB64), enc.encode(text));
  } catch {
    return false;
  }
}

// Both people see the same 16 digits. Comparing them in person or on a call proves
// nobody swapped keys in the middle.
export async function safetyCode(pubA, pubB) {
  const [x, y] = [pubA, pubB].sort();
  const h = await sha256(`conduit-safety|${x}|${y}`);
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]);
  return (n % 10n ** 16n).toString().padStart(16, '0').match(/.{4}/g).join(' ');
}

// A friend request proves it came from someone holding your invite — without the invite
// secret ever crossing the hub. The proof is bound to the requester's own key, so even the
// hub can't lift it and use it for a different key.
export async function inviteProof(token, requesterPub, inviterId) {
  const key = await crypto.subtle.importKey('raw', unb64u(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(`conduit-invite|${requesterPub}|${inviterId}`)));
}

export const newInviteToken = () => randomId(16);

// Invite codes are compact so the QR stays easy to scan:
// [version 1][public key 65 bytes][invite token 16 bytes][display name, UTF-8]
export function encodeInvite({ pub, token, name }) {
  const p = unb64u(pub);
  const t = unb64u(token);
  let n = enc.encode([...String(name || '')].slice(0, 32).join(''));
  while (n.length > 64) n = n.slice(0, -1);
  const out = new Uint8Array(82 + n.length);
  out[0] = 1;
  out.set(p, 1);
  out.set(t, 66);
  out.set(n, 82);
  return b64u(out);
}

export async function decodeInvite(code) {
  const b = unb64u(String(code).trim());
  if (b[0] !== 1 || b.length < 82 || b[1] !== 4) throw new Error('That is not a Conduit invite');
  const pub = b64u(b.slice(1, 66));
  await importPub(pub); // throws if the key is malformed
  return {
    pub,
    id: await fingerprint(b.slice(1, 66)),
    token: b64u(b.slice(66, 82)),
    name: dec.decode(b.slice(82)).trim() || 'Friend',
  };
}

// Accepts a full invite link, just the fragment, or just the code.
export function extractInviteCode(text) {
  const s = String(text || '').trim();
  const m = s.match(/[#&?]join=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{100,}$/.test(s)) return s;
  return null;
}
