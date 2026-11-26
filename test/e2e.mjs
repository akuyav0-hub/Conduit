// End-to-end test: two real Chrome profiles befriend each other through the UI, transfer large
// files, survive a forced connection drop mid-transfer, and ignore a stranger.
// Usage: node test/e2e.mjs   (expects `npx wrangler dev` on 127.0.0.1:8787)

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, statSync, rmSync, mkdirSync, writeFileSync, readFileSync, createReadStream, openSync, writeSync, closeSync } from 'node:fs';

// Uses the project's Playwright if installed (npm i -D playwright && npx playwright install chromium).
const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.mjs'));
const CHROME = existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;

function ensureFile(path, bytes) {
  if (existsSync(path) && statSync(path).size === bytes) return;
  const fd = openSync(path, 'w');
  for (let left = bytes; left > 0; left -= 16 << 20) writeSync(fd, randomBytes(Math.min(left, 16 << 20)));
  closeSync(fd);
}
mkdirSync('/tmp/conduit-test', { recursive: true });
ensureFile('/tmp/conduit-test/a.bin', 300 * 1024 * 1024);
ensureFile('/tmp/conduit-test/b.bin', 700 * 1024 * 1024);
if (!existsSync('/tmp/conduit-test/tiny.txt')) writeFileSync('/tmp/conduit-test/tiny.txt', 'hello from conduit\n');
if (!existsSync('/tmp/conduit-test/empty.dat')) writeFileSync('/tmp/conduit-test/empty.dat', '');


const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const DIR = '/tmp/conduit-test';
const SHOTS = process.env.SHOTS || '/tmp/conduit-shots';
mkdirSync(SHOTS, { recursive: true });
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };
const sha = (p) => new Promise((res) => { const h = createHash('sha256'); createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))); });

async function profile(name, viewport, mobile = false) {
  const dir = `/tmp/conduit-profile-${name}`;
  rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME,
    headless: true,
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name} pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [${name} console] ${m.text()}`); });
  return { ctx, page };
}

async function onboard(page, name) {
  await page.waitForSelector('#first-name');
  await page.fill('#first-name', name);
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForFunction(() => window.conduit?.signal?.state === 'online', null, { timeout: 15000 });
}

const logHas = (page, re) => page.evaluate((src) => window.conduit.state.log.some((l) => new RegExp(src).test(l.msg)), re.source);

async function hashInPage(page, rec) {
  return page.evaluate(async (r) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('inbox');
    const file = await (await dir.getFileHandle(r.opfs)).getFile();
    const buf = await file.arrayBuffer();
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return { size: file.size, hex: [...d].map((x) => x.toString(16).padStart(2, '0')).join('') };
  }, rec);
}

const t0 = Date.now();
const A = await profile('alice', { width: 1280, height: 860 });
const B = await profile('bob', { width: 390, height: 844 }, true);

console.log('onboarding + invite');
await A.page.goto(BASE);
await onboard(A.page, 'Alice');
await A.page.screenshot({ path: `${SHOTS}/01-alice-empty.png` });
await A.page.click('#add-friend');
await A.page.fill('#inv-label', 'Bob');
await A.page.getByRole('button', { name: 'Create invite' }).click();
const link = (await A.page.textContent('#invite-link')).trim();
ok(/#join=[A-Za-z0-9_-]{100,}$/.test(link), `invite link created (${link.length} chars)`);
await A.page.screenshot({ path: `${SHOTS}/02-alice-invite.png` });
await A.page.keyboard.press('Escape');

await B.page.goto(link);
await B.page.screenshot({ path: `${SHOTS}/03-bob-gate.png` });
await onboard(B.page, 'Bob');
await B.page.getByRole('button', { name: 'Send friend request' }).waitFor();
await B.page.screenshot({ path: `${SHOTS}/04-bob-invite-sheet.png` });
const codeB = (await B.page.textContent('dialog .code')).trim();
await B.page.getByRole('button', { name: 'Send friend request' }).click();
ok(!(await B.page.evaluate(() => location.hash)), 'invite is stripped from the address bar after opening');

console.log('approval');
await A.page.waitForSelector('.decision >> text=Bob wants to connect', { timeout: 15000 });
await A.page.screenshot({ path: `${SHOTS}/05-alice-request.png` });
const metaA = await A.page.textContent('.decision');
ok(metaA.includes(codeB), 'both sides show the same safety code');
ok(metaA.includes('Used your invite for Bob'), 'request shows which invite was used');
await A.page.getByRole('button', { name: 'Approve' }).click();
await B.page.waitForFunction(() => [...window.conduit.state.friends.values()].some((f) => f.name === 'Alice' && f.status === 'friend'), null, { timeout: 15000 });
ok(true, 'Bob sees the approval');
const ids = {
  alice: await A.page.evaluate(() => window.conduit.state.me.id),
  bob: await B.page.evaluate(() => window.conduit.state.me.id),
};
await A.page.waitForFunction((id) => window.conduit.state.online.has(id), ids.bob, { timeout: 15000 });
await B.page.waitForFunction((id) => window.conduit.state.online.has(id), ids.alice, { timeout: 15000 });
ok(true, 'presence: both see each other online');
const invUses = await A.page.evaluate(() => [...window.conduit.state.invites.values()][0].uses);
ok(invUses === 1, 'single-use invite is now spent');

console.log('transfer 1: 300 MB + two small files, manual accept');
const files1 = [`${DIR}/a.bin`, `${DIR}/tiny.txt`, `${DIR}/empty.dat`];
const [chooser] = await Promise.all([A.page.waitForEvent('filechooser'), A.page.getByRole('button', { name: 'Send files to Bob' }).click()]);
await chooser.setFiles(files1);
await A.page.locator('dialog').getByRole('button', { name: /^Send to / }).click();
await B.page.waitForSelector('.decision >> text=Alice wants to send you 3 files', { timeout: 20000 });
await B.page.screenshot({ path: `${SHOTS}/06-bob-incoming.png` });
const tStart = Date.now();
await B.page.getByRole('button', { name: 'Accept' }).click();
await A.page.waitForFunction(() => [...window.conduit.transfers.out.values()].some((b) => b.status === 'sending' && b.acked > 40e6), null, { timeout: 60000 });
await A.page.screenshot({ path: `${SHOTS}/07-alice-sending.png` });
await B.page.screenshot({ path: `${SHOTS}/08-bob-receiving.png` });
await A.page.waitForFunction(() => [...window.conduit.transfers.out.values()].every((b) => b.status === 'done'), null, { timeout: 300000 });
const secs1 = (Date.now() - tStart) / 1000;
const size1 = statSync(`${DIR}/a.bin`).size;
ok(true, `delivered in ${secs1.toFixed(1)}s (${(size1 / 1048576 / secs1).toFixed(1)} MB/s end to end, including accept + disk writes)`);
const route = await A.page.evaluate((id) => window.conduit.links.get(id)?.route, ids.bob);
ok(route === 'direct', `route is direct peer-to-peer (${route})`);
await B.page.waitForFunction(() => window.conduit.state.inbox.length >= 3, null, { timeout: 20000 });
const inbox1 = await B.page.evaluate(() => window.conduit.state.inbox.map((r) => ({ name: r.name, size: r.size, opfs: r.opfs, kind: r.kind })));
const recA = inbox1.find((r) => r.name === 'a.bin');
const got = await hashInPage(B.page, recA);
ok(got.size === size1, `received size matches (${got.size})`);
ok(got.hex === await sha(`${DIR}/a.bin`), 'SHA-256 of the received 300 MB file matches the original');
const tiny = await hashInPage(B.page, inbox1.find((r) => r.name === 'tiny.txt'));
ok(tiny.hex === await sha(`${DIR}/tiny.txt`), 'small file intact');
const empty = inbox1.find((r) => r.name === 'empty.dat');
ok(empty && empty.size === 0 && (await hashInPage(B.page, empty)).size === 0, 'zero-byte file arrives as an empty file');
await A.page.screenshot({ path: `${SHOTS}/09-alice-done.png` });

console.log('transfer 2: 700 MB with auto-accept and a forced connection drop mid-transfer');
await B.page.evaluate(async (id) => {
  const f = window.conduit.state.friends.get(id);
  f.autoAccept = true;
}, ids.alice);
const [chooser2] = await Promise.all([A.page.waitForEvent('filechooser'), A.page.getByRole('button', { name: 'Send files to Bob' }).click()]);
await chooser2.setFiles([`${DIR}/b.bin`]);
await A.page.locator('dialog').getByRole('button', { name: /^Send to / }).click();
await A.page.waitForFunction(() => [...window.conduit.transfers.out.values()].some((b) => b.status === 'sending' && b.acked > 220e6), null, { timeout: 120000 });
const before = await A.page.evaluate(() => [...window.conduit.transfers.out.values()].find((b) => b.status === 'sending').acked);
// Kill Alice's side of the connection without a goodbye, like a Wi-Fi drop.
await A.page.evaluate((id) => window.conduit.links.get(id).teardown('test: simulated network drop'), ids.bob);
await A.page.waitForFunction(() => [...window.conduit.transfers.out.values()].some((b) => b.status === 'interrupted'), null, { timeout: 10000 });
await A.page.screenshot({ path: `${SHOTS}/10-alice-interrupted.png` });
ok(true, `interrupted at ${(before / 1048576).toFixed(0)} MB`);
await A.page.waitForFunction(() => [...window.conduit.transfers.out.values()].every((b) => b.status === 'done'), null, { timeout: 300000 });
ok(await logHas(A.page, /resuming "b\.bin" at/), 'sender resumed from where the receiver left off (no restart from zero)');
await B.page.waitForFunction(() => window.conduit.state.inbox.some((r) => r.name === 'b.bin'), null, { timeout: 20000 });
const recB = await B.page.evaluate(() => window.conduit.state.inbox.find((r) => r.name === 'b.bin'));
const got2 = await hashInPage(B.page, recB);
ok(got2.hex === await sha(`${DIR}/b.bin`), 'SHA-256 of the 700 MB file matches after the reconnect');

console.log('stranger');
const C = await profile('mallory', { width: 800, height: 700 });
await C.page.goto(BASE);
await onboard(C.page, 'Mallory');
await C.page.evaluate((id) => window.conduit.signal.send(id, 'sdp', { sid: 'abcdefgh', rsid: null, d: { type: 'offer', sdp: 'v=0' } }), ids.alice);
await C.page.evaluate((id) => window.conduit.signal.send(id, 'friend-request', { k: window.conduit.state.me.pub, n: 'Mallory', p: 'forged-proof' }, { queue: true }), ids.alice);
await A.page.waitForTimeout(1500);
ok(await logHas(A.page, /ignored a message from unknown device/), 'connection attempt from a non-friend is dropped');
ok(await logHas(A.page, /ignored a friend request from "Mallory"/), 'friend request without a valid invite is ignored');
ok(!(await A.page.evaluate(() => window.conduit.state.requests.size)), 'no approval prompt appears for the stranger');
const malloryOnline = await C.page.evaluate((id) => window.conduit.state.online.has(id), ids.alice);
ok(!malloryOnline, 'stranger cannot see Alice’s online status');

await A.page.click('[data-view="you"]');
await A.page.screenshot({ path: `${SHOTS}/11-alice-you.png`, fullPage: true });
await B.page.click('[data-view="inbox"]');
await B.page.screenshot({ path: `${SHOTS}/12-bob-inbox.png` });
await A.page.click('[data-view="home"]');
await A.page.click('#log-toggle');
await A.page.screenshot({ path: `${SHOTS}/13-alice-log.png` });

for (const p of [A, B, C]) await p.ctx.close();
console.log(failures ? `\n${failures} FAILED (${((Date.now() - t0) / 1000).toFixed(0)}s)` : `\nall end-to-end tests passed (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
process.exit(failures ? 1 : 0);
