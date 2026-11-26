// Folder end-to-end test: send a folder from the friend row, receive it into the inbox, see it as
// one folder, download it as a .zip, save it whole into a folder, and delete it.

import { createHash } from 'node:crypto';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const { chromium } = await import('playwright').catch(() => import('/opt/npm-tools/node_modules/playwright/index.mjs'));
const CHROME = existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOTS || '/tmp/conduit-shots';
mkdirSync(SHOTS, { recursive: true });
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// The folder to send.
const tree = '/tmp/conduit-test/Trip photos';
rmSync(tree, { recursive: true, force: true });
const contents = {
  'notes.txt': Buffer.from('packing list\n'),
  'café ☕ notes.txt': Buffer.from('unicode name\n'),
  'empty.txt': Buffer.alloc(0),
  'day 1/beach.jpg': Buffer.alloc(3_000_000, 7),
  'day 2/hike.jpg': Buffer.alloc(5_000_000, 9),
  'day 2/raw/IMG_0001.dng': Buffer.from(Array.from({ length: 9_000_000 }, (_, i) => (i * 31) & 255)),
};
for (const [p, data] of Object.entries(contents)) {
  mkdirSync(join(tree, p, '..'), { recursive: true });
  writeFileSync(join(tree, p), data);
}
const expected = Object.fromEntries(Object.entries(contents).map(([p, d]) => [p, sha(d)]));

async function profile(name, viewport, mobile = false) {
  const dir = `/tmp/conduit-profile3-${name}`;
  rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME, headless: true, viewport, isMobile: mobile, hasTouch: mobile, acceptDownloads: true,
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
  await page.waitForFunction(() => window.conduit?.signal?.state === 'online', null, { timeout: 15000 });
}
// Reads a folder tree out of the receiver's browser storage: { 'path/in/folder': sha256 }
const readTree = (page, dirName) => page.evaluate(async (d) => {
  let dir = await navigator.storage.getDirectory();
  for (const part of d.split('/')) dir = await dir.getDirectoryHandle(part);
  const out = {};
  async function walk(handle, prefix) {
    for await (const [name, h] of handle.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (h.kind === 'directory') await walk(h, path);
      else out[path] = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await (await h.getFile()).arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
  }
  await walk(dir, '');
  return out;
}, dirName);
const sameTree = (got) => JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(expected).sort());

const A = await profile('alice', { width: 390, height: 844 }, true);
const B = await profile('bob', { width: 1180, height: 860 });
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
const bobId = await B.page.evaluate(() => window.conduit.state.me.id);
await A.page.waitForFunction((id) => window.conduit.state.online.has(id), bobId, { timeout: 15000 });

console.log('send a folder from the friend row (phone layout)');
await A.page.screenshot({ path: `${SHOTS}/20-alice-phone-row.png` });
// This test drives the classic folder input; e2e4 covers the modern folder picker.
await A.page.evaluate(() => { window.showDirectoryPicker = undefined; });
const [chooser] = await Promise.all([A.page.waitForEvent('filechooser'), A.page.getByRole('button', { name: 'Send a folder to Bob' }).click()]);
await chooser.setFiles(tree);
await A.page.locator('dialog').getByRole('button', { name: /^Send to / }).click();
await B.page.waitForSelector('.decision >> text=Alice wants to send you the Trip photos folder', { timeout: 20000 });
ok(true, 'prompt reads “Alice wants to send you the Trip photos folder”');
ok((await B.page.textContent('.decision')).includes('6 files, 16.2 MB'), 'prompt shows the file count and size');
await B.page.screenshot({ path: `${SHOTS}/21-bob-folder-prompt.png` });
await B.page.getByRole('button', { name: 'Accept' }).click();
await A.page.waitForFunction(() => [...window.conduit.transfers.out.values()].every((b) => b.status === 'done'), null, { timeout: 60000 });
const rowTitle = (await A.page.textContent('.xfer .xfer-title')).trim();
ok(rowTitle === 'Trip photos folder, 6 files', `transfer row reads “${rowTitle}”`);

console.log('inbox shows it as one folder');
await B.page.waitForFunction(() => window.conduit.state.inbox.length === 6, null, { timeout: 20000 });
await B.page.click('[data-view="inbox"]');
await B.page.waitForTimeout(400);
const items = await B.page.locator('#view-inbox .inbox-list > .item').count();
ok(items === 1, `one inbox item instead of six (${items})`);
ok((await B.page.textContent('#view-inbox .item')).includes('Folder, 6 files'), 'labelled as a folder of 6 files');
await B.page.getByRole('button', { name: 'Show files' }).click();
const subRows = await B.page.locator('.subfiles li').count();
ok(subRows === 6, `Show files lists all 6 with their paths inside the folder (${subRows})`);
await B.page.screenshot({ path: `${SHOTS}/22-bob-inbox-folder.png` });

console.log('download as .zip');
const [download] = await Promise.all([B.page.waitForEvent('download'), B.page.getByRole('button', { name: 'Download .zip' }).click()]);
ok(download.suggestedFilename() === 'Trip photos.zip', `download is named “${download.suggestedFilename()}”`);
await download.saveAs('/tmp/bob-trip.zip');
const py = (zipPath) => JSON.parse(execFileSync('python3', ['-c', `
import zipfile, hashlib, json, sys
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad": z.testzip(), "files": {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}, "zip64": any(i.extra for i in z.infolist())}))
`, zipPath]).toString());
const z1 = py('/tmp/bob-trip.zip');
ok(z1.bad === null, 'every checksum in the .zip verifies');
ok(JSON.stringify(Object.entries(z1.files).sort()) === JSON.stringify(Object.entries(expected).sort()), 'the .zip holds exactly the folder’s files with their subfolders, contents identical');
ok(execFileSync('unzip', ['-t', '/tmp/bob-trip.zip']).toString().includes('No errors detected'), 'standard unzip tool reads it cleanly');

console.log('ZIP64 path through the real browser worker');
const b64 = await B.page.evaluate(async () => {
  const { zipInbox } = await import('/lib/sinks.js');
  const recs = window.conduit.state.inbox;
  const entries = recs.map((r) => ({ src: r.opfs, path: [...r.path.split('/').slice(1), r.name].join('/'), size: r.size }));
  const file = await zipInbox('zip-forced64', entries, null, { forceZip64: true });
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
});
writeFileSync('/tmp/bob-zip64.zip', Buffer.from(b64, 'base64'));
const z2 = py('/tmp/bob-zip64.zip');
ok(z2.bad === null && z2.zip64 && JSON.stringify(Object.entries(z2.files).sort()) === JSON.stringify(Object.entries(expected).sort()), 'ZIP64 archive (used above 4 GB) verifies and matches');

console.log('save the whole folder (Chrome/Edge on a computer)');
// Stand-in for the folder picker, which needs a real click: a directory from the same API.
await B.page.evaluate(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Downloads', { create: true }); });
await B.page.getByRole('button', { name: 'Save folder' }).click();
await B.page.waitForSelector('.toast >> text=Saved “Trip photos” into Downloads', { timeout: 20000 }).catch(async (e) => {
  console.log('  toasts:', await B.page.$$eval('.toast', (els) => els.map((x) => x.textContent)));
  console.log('  jobs:', await B.page.evaluate(() => [...window.conduit.state.jobs.entries()]));
  throw e;
});
ok(sameTree(await readTree(B.page, 'Downloads/Trip photos')), 'saved as Downloads/Trip photos with every subfolder and file intact');
await B.page.getByRole('button', { name: 'Save folder' }).click();
await B.page.waitForSelector('.toast >> text=Saved “Trip photos (1)” into Downloads', { timeout: 20000 });
ok(true, 'saving again makes “Trip photos (1)” instead of overwriting');

console.log('delete the folder');
await B.page.getByRole('button', { name: 'Delete', exact: true }).click();
await B.page.locator('dialog').getByRole('button', { name: 'Delete folder' }).click();
await B.page.waitForFunction(() => window.conduit.state.inbox.length === 0, null, { timeout: 10000 });
const left = await B.page.evaluate(async () => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('inbox');
  const names = [];
  for await (const n of dir.keys()) names.push(n);
  return names;
});
ok(left.filter((n) => !n.startsWith('zip-forced64')).length === 0, `inbox storage is empty again, including the temporary .zip (${left.length} left, test file only)`);

await A.ctx.close();
await B.ctx.close();
console.log(failures ? `\n${failures} FAILED` : '\nall folder tests passed');
process.exit(failures ? 1 : 0);
