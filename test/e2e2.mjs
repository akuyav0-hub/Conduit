// Second end-to-end pass: folder sends with nested paths into a save folder, receiver cancel,
// decline, sending to an offline friend (auto-starts when they return), and removing a friend.

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
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };
const hex = (buf) => createHash('sha256').update(buf).digest('hex');

async function profile(name, viewport) {
  const dir = `/tmp/conduit-profile2-${name}`;
  rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME, headless: true, viewport,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name} pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [${name} console] ${m.text()}`); });
  return { ctx, page, dir };
}
async function onboard(page, name) {
  await page.waitForSelector('#first-name');
  await page.fill('#first-name', name);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => window.conduit?.signal?.state === 'online', null, { timeout: 15000 });
}
const outs = (page) => page.evaluate(() => [...window.conduit.transfers.out.values()].map((b) => ({ status: b.status, note: b.note, acked: b.acked })));

// Build a nested folder to send.
const tree = '/tmp/conduit-test/Trip photos';
rmSync(tree, { recursive: true, force: true });
mkdirSync(`${tree}/day 1`, { recursive: true });
mkdirSync(`${tree}/day 2/raw`, { recursive: true });
const contents = {
  'notes.txt': Buffer.from('packing list\n'),
  'day 1/beach.jpg': Buffer.alloc(3_000_000, 7),
  'day 2/hike.jpg': Buffer.alloc(5_000_000, 9),
  'day 2/raw/IMG_0001.dng': Buffer.from(Array.from({ length: 9_000_000 }, (_, i) => (i * 31) & 255)),
};
for (const [p, data] of Object.entries(contents)) writeFileSync(`${tree}/${p}`, data);

const A = await profile('alice', { width: 1280, height: 860 });
const B = await profile('bob', { width: 1100, height: 800 });
await A.page.goto(BASE);
await onboard(A.page, 'Alice');
await A.page.click('#add-friend');
await A.page.getByText('A group').click();
await A.page.getByRole('button', { name: 'Create invite' }).click();
const link = (await A.page.textContent('#invite-link')).trim();
await A.page.keyboard.press('Escape');
await B.page.goto(link);
await onboard(B.page, 'Bob');
await B.page.getByRole('button', { name: 'Send friend request' }).click();
await A.page.getByRole('button', { name: 'Approve' }).click();
const aliceId = await A.page.evaluate(() => window.conduit.state.me.id);
const bobId = await B.page.evaluate(() => window.conduit.state.me.id);
await A.page.waitForFunction((id) => window.conduit.state.online.has(id), bobId, { timeout: 15000 });
const inv = await A.page.evaluate(() => [...window.conduit.state.invites.values()][0]);
ok(inv.max === 20 && inv.uses === 1, 'group invite stays usable after the first person (1 of 20 used)');

console.log('folder send into a chosen save folder');
// Stand-in for the folder picker (which needs a real click): a directory handle from the same API.
await B.page.evaluate(async () => {
  const s = window.conduit.state;
  s.folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder', { create: true });
  s.settings.save = 'folder';
});
await A.page.locator('.friend-open').first().click();
// This test drives the classic folder input; e2e4 covers the modern folder picker.
await A.page.evaluate(() => { window.showDirectoryPicker = undefined; });
const [chooser] = await Promise.all([A.page.waitForEvent('filechooser'), A.page.locator('dialog').getByRole('button', { name: 'Send a folder' }).click()]);
await chooser.setFiles(tree);
await A.page.locator('dialog').getByRole('button', { name: /^Send to / }).click();
await B.page.waitForSelector('.decision >> text=Alice wants to send you the Trip photos folder', { timeout: 20000 });
await B.page.getByRole('button', { name: 'Accept' }).click();
await A.page.waitForFunction(() => [...window.conduit.transfers.out.values()].every((b) => b.status === 'done'), null, { timeout: 60000 });
const saved = await B.page.evaluate(async () => {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
  const out = {};
  async function walk(dir, prefix) {
    for await (const [name, handle] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') await walk(handle, path);
      else out[path] = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await handle.getFile()).arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
  }
  await walk(root, '');
  return out;
});
for (const [p, data] of Object.entries(contents)) {
  ok(saved[`Trip photos/${p}`] === hex(data), `saved with its folder structure: Trip photos/${p}`);
}
const kinds = await B.page.evaluate(() => window.conduit.state.inbox.map((r) => r.kind));
ok(kinds.length === 4 && kinds.every((k) => k === 'folder'), 'inbox lists them as saved to your folder');

console.log('receiver cancels mid-transfer');
await B.page.evaluate(() => { window.conduit.state.settings.save = 'inbox'; });
const [c2] = await Promise.all([A.page.waitForEvent('filechooser'), A.page.getByRole('button', { name: 'Send files to Bob' }).click()]);
await c2.setFiles(`${DIR}/b.bin`);
await A.page.locator('dialog').getByRole('button', { name: /^Send to / }).click();
await B.page.getByRole('button', { name: 'Accept' }).click();
await B.page.waitForFunction(() => [...window.conduit.transfers.in.values()].some((b) => b.status === 'receiving' && b.written > 60e6), null, { timeout: 60000 });
const tid = await B.page.evaluate(() => [...window.conduit.transfers.in.values()].find((b) => b.status === 'receiving').tid);
await B.page.locator('.xfer.receiving').getByRole('button', { name: 'Cancel' }).click();
await A.page.waitForFunction(() => [...window.conduit.transfers.out.values()].some((b) => b.status === 'canceled'), null, { timeout: 10000 });
const note = (await outs(A.page)).find((b) => b.status === 'canceled').note;
ok(/Canceled by Bob/.test(note), `sender sees it: “${note}”`);
await B.page.waitForTimeout(800);
const leftovers = await B.page.evaluate(async (t) => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('inbox');
  const names = [];
  for await (const n of dir.keys()) if (n.startsWith(t)) names.push(n);
  return names;
}, tid);
ok(leftovers.length === 0, 'the partial file is deleted from the receiver');

console.log('decline');
const [c3] = await Promise.all([A.page.waitForEvent('filechooser'), A.page.getByRole('button', { name: 'Send files to Bob' }).click()]);
await c3.setFiles(`${DIR}/tiny.txt`);
await A.page.locator('dialog').getByRole('button', { name: /^Send to / }).click();
await B.page.getByRole('button', { name: 'Decline' }).click();
await A.page.waitForFunction(() => [...window.conduit.transfers.out.values()].some((b) => b.status === 'declined'), null, { timeout: 10000 });
ok(true, 'sender sees the decline');

console.log('send to an offline friend');
await B.ctx.close();
await A.page.waitForFunction((id) => !window.conduit.state.online.has(id), bobId, { timeout: 15000 });
const [c4] = await Promise.all([A.page.waitForEvent('filechooser'), A.page.getByRole('button', { name: 'Send files to Bob' }).click()]);
await c4.setFiles(`${DIR}/a.bin`);
await A.page.locator('dialog').getByRole('button', { name: /^Send to / }).click();
await A.page.waitForTimeout(500);
const waiting = (await outs(A.page)).find((b) => b.status === 'queued');
ok(waiting && /Waiting for Bob to come online/.test(waiting.note), `queued while Bob is away: “${waiting?.note}”`);
const B2ctx = await chromium.launchPersistentContext(B.dir, {
  executablePath: CHROME, headless: true, viewport: { width: 1100, height: 800 },
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'],
});
const B2 = B2ctx.pages()[0] || await B2ctx.newPage();
await B2.goto(BASE);
await B2.waitForSelector('.decision >> text=Alice wants to send you a file', { timeout: 30000 });
ok(true, 'the moment Bob reopens Conduit, the offer is waiting for him');
await B2.getByRole('button', { name: 'Accept' }).click();
await A.page.waitForFunction(() => [...window.conduit.transfers.out.values()].filter((b) => b.status === 'done').length >= 2, null, { timeout: 120000 });
ok(true, 'delivered after he came back');

console.log('remove friend');
await A.page.locator('.friend-open').first().click();
await A.page.getByRole('button', { name: 'Remove friend' }).click();
await A.page.locator('dialog').getByRole('button', { name: 'Remove friend' }).last().click();
await B2.waitForFunction((id) => !window.conduit.state.friends.has(id), aliceId, { timeout: 15000 });
ok(true, 'Bob is told and Alice disappears from his list');
await B2.evaluate((id) => window.conduit.signal.send(id, 'sdp', { sid: 'abcdefgh', rsid: null, d: { type: 'offer', sdp: 'v=0' } }), aliceId);
await A.page.waitForTimeout(1200);
const dropped = await A.page.evaluate(() => window.conduit.state.log.slice(-5).some((l) => /ignored a message from unknown device/.test(l.msg)));
ok(dropped, 'after removal, Bob can no longer reach Alice');

await A.ctx.close();
await B2ctx.close();
console.log(failures ? `\n${failures} FAILED` : '\nall second-pass tests passed');
process.exit(failures ? 1 : 0);
