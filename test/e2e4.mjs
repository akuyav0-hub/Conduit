// Robustness test: a friend whose computer clock is 31 minutes off, a lost approval message,
// sending a folder through the modern folder picker, and the fallback when a browser hands back
// loose files instead of a folder.

import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';

const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.mjs'));
const CHROME = existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOTS || '/tmp/conduit-shots';
mkdirSync(SHOTS, { recursive: true });
mkdirSync('/tmp/conduit-test', { recursive: true });
writeFileSync('/tmp/conduit-test/tiny.txt', 'hello from conduit\n');
writeFileSync('/tmp/conduit-test/song.mp3', Buffer.alloc(2_500_000, 3));
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };

async function profile(name, { skewMinutes = 0 } = {}) {
  const dir = `/tmp/conduit-profile4-${name}`;
  rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME, headless: true, viewport: { width: 1180, height: 820 },
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'],
  });
  if (skewMinutes) {
    await ctx.addInitScript((m) => { const real = Date.now; Date.now = () => real() + m * 60000; }, skewMinutes);
  }
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name} pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [${name} console] ${m.text()}`); });
  return { ctx, page };
}
async function onboard(page, name) {
  await page.waitForSelector('#first-name');
  await page.fill('#first-name', name);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => window.conduit?.signal?.state === 'online', null, { timeout: 15000 });
}
const allDone = (page, n) => page.waitForFunction((count) => {
  const outs = [...window.conduit.transfers.out.values()];
  return outs.length >= count && outs.every((b) => b.status === 'done');
}, n, { timeout: 60000 });
const logHas = (page, re) => page.evaluate((src) => window.conduit.state.log.some((l) => new RegExp(src).test(l.msg)), re.source);

const A = await profile('alice');
const B = await profile('bob', { skewMinutes: 31 });

console.log('friend whose clock is 31 minutes fast');
await A.page.goto(BASE);
await onboard(A.page, 'Alice');
await A.page.click('#add-friend');
await A.page.getByRole('button', { name: 'Create invite' }).click();
const link = (await A.page.textContent('#invite-link')).trim();
await A.page.keyboard.press('Escape');
await B.page.goto(link);
await onboard(B.page, 'Bob');
await B.page.getByRole('button', { name: 'Send friend request' }).click();
await A.page.getByRole('button', { name: 'Approve' }).click();
const aliceId = await A.page.evaluate(() => window.conduit.state.me.id);
const bobId = await B.page.evaluate(() => window.conduit.state.me.id);
await B.page.waitForFunction((id) => window.conduit.state.friends.get(id)?.status === 'friend', aliceId, { timeout: 15000 });
ok(true, 'friend request and approval still work');
ok(await logHas(B.page, /clock is 31 min fast/), 'Bob’s app notices its clock is off and uses the server’s time');
await A.page.waitForFunction((id) => window.conduit.state.online.has(id), bobId, { timeout: 15000 });
const [c1] = await Promise.all([A.page.waitForEvent('filechooser'), A.page.getByRole('button', { name: 'Send files to Bob' }).click()]);
await c1.setFiles('/tmp/conduit-test/song.mp3');
await A.page.locator('dialog').getByRole('button', { name: /^Send to / }).click();
await B.page.getByRole('button', { name: 'Accept' }).click();
await allDone(A.page, 1);
ok(true, 'files go through despite the 31-minute clock difference');

console.log('lost approval message');
// Make Bob's app forget that Alice approved him, and drop the open connection.
await B.page.evaluate((id) => { window.conduit.state.friends.get(id).status = 'pending-out'; }, aliceId);
await A.page.evaluate((id) => window.conduit.links.get(id).close('test'), bobId);
await B.page.waitForTimeout(500);
const [c2] = await Promise.all([A.page.waitForEvent('filechooser'), A.page.getByRole('button', { name: 'Send files to Bob' }).click()]);
await c2.setFiles('/tmp/conduit-test/tiny.txt');
await A.page.locator('dialog').getByRole('button', { name: /^Send to / }).click();
await B.page.getByRole('button', { name: 'Accept' }).click({ timeout: 20000 });
await allDone(A.page, 2);
ok(await logHas(B.page, /they've approved you/), 'Bob’s app treats Alice’s signed call as her approval');
ok(await B.page.evaluate((id) => window.conduit.state.friends.get(id).status === 'friend', aliceId), 'and the transfer goes through');

console.log('send a folder with the modern folder picker');
await A.page.evaluate(async () => {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('Holiday', { create: true });
  const put = async (dir, name, text) => {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(text);
    await w.close();
  };
  await put(root, 'itinerary.txt', 'day one: beach\n');
  await put(root, 'Thumbs.db', 'windows clutter');
  const pics = await root.getDirectoryHandle('pics', { create: true });
  await put(pics, 'sunset.jpg', 'x'.repeat(50000));
  await put(await pics.getDirectoryHandle('raw', { create: true }), 'IMG_2.dng', 'y'.repeat(90000));
  // Stand-in for the folder picker dialog: hands back the folder above.
  window.showDirectoryPicker = async () => root;
});
await A.page.getByRole('button', { name: 'Send a folder to Bob' }).click();
await A.page.waitForSelector('#review-title >> text=Holiday');
await A.page.screenshot({ path: `${SHOTS}/40-review.png` });
await A.page.locator('dialog').getByRole('button', { name: /^Send to / }).click();
await B.page.waitForSelector('.decision >> text=Alice wants to send you the Holiday folder', { timeout: 20000 });
ok((await B.page.textContent('.decision')).includes('3 files'), 'prompt shows 3 files (the Windows Thumbs.db clutter is skipped)');
await B.page.getByRole('button', { name: 'Accept' }).click();
await allDone(A.page, 3);
const holiday = await B.page.evaluate(() => window.conduit.state.inbox.filter((r) => r.path.startsWith('Holiday')).map((r) => `${r.path}/${r.name}`).sort());
ok(JSON.stringify(holiday) === JSON.stringify(['Holiday/itinerary.txt', 'Holiday/pics/raw/IMG_2.dng', 'Holiday/pics/sunset.jpg']), `arrives with its subfolders: ${holiday.join(', ')}`);

console.log('browser hands back loose files instead of a folder');
await A.page.evaluate(() => {
  window.showDirectoryPicker = async () => { throw new DOMException('blocked by the browser', 'SecurityError'); };
  document.getElementById('folder-input').removeAttribute('webkitdirectory');
});
const [c3] = await Promise.all([A.page.waitForEvent('filechooser'), A.page.getByRole('button', { name: 'Send a folder to Bob' }).click()]);
await c3.setFiles(['/tmp/conduit-test/tiny.txt', '/tmp/conduit-test/song.mp3']);
await A.page.waitForSelector('dialog >> text=Send these as one folder?');
await A.page.screenshot({ path: `${SHOTS}/30-alice-name-folder.png` });
await A.page.fill('#folder-name', 'Phone pics');
await A.page.getByRole('button', { name: 'Send as one folder' }).click();
await B.page.waitForSelector('.decision >> text=Alice wants to send you the Phone pics folder', { timeout: 20000 });
ok(true, 'falls back to the classic picker, then offers to send the files as one named folder');
await B.page.getByRole('button', { name: 'Accept' }).click();
await allDone(A.page, 4);
const pics = await B.page.evaluate(() => window.conduit.state.inbox.filter((r) => r.path === 'Phone pics').length);
ok(pics === 2, 'Bob receives the Phone pics folder with both files');

await A.page.screenshot({ path: `${SHOTS}/31-alice-after.png` });
await A.ctx.close();
await B.ctx.close();
console.log(failures ? `\n${failures} FAILED` : '\nall robustness tests passed');
process.exit(failures ? 1 : 0);
