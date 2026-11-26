#!/usr/bin/env node
// One-step deploy for Conduit.
// First run: installs the tools, has you sign in to Cloudflare once, then publishes.
// Every run after that: publishes in seconds, opens the app, and shows a QR code for your phone.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderUnicodeCompact } from '../public/vendor/uqr.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const win = process.platform === 'win32';

const step = (s) => console.log(`\n» ${s}`);
const stop = (s) => { console.error(`\n✖ ${s}\n`); process.exit(1); };

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  stop(`Deploying needs Node.js 22.12 or newer, and this computer has ${process.version}.\n  Install the LTS version from https://nodejs.org, then run Deploy again.`);
}

// Runs a command with its output shown live; with capture, also returns what it printed.
function run(cmd, args, { capture = false, shell = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit', shell });
    let out = '';
    if (capture) {
      child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
      child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    }
    child.on('error', (e) => resolve({ code: 1, out: String(e) }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

function openInBrowser(url) {
  const [cmd, args] = win ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* no browser to open; the address is printed above */ }
}

const wranglerJs = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const wrangler = (args, capture = false) => run(process.execPath, [wranglerJs, ...args], { capture });

if (!existsSync(wranglerJs)) {
  step('Installing the deploy tools (first run only, about a minute)…');
  const r = await run('npm', ['install', '--no-audit', '--no-fund'], { shell: win });
  if (r.code !== 0 || !existsSync(wranglerJs)) stop('Installing failed. Check your internet connection and run Deploy again.');
}

step('Checking your Cloudflare sign-in…');
const who = await wrangler(['whoami'], true);
// whoami exits successfully even when signed out, so read what it says.
if (who.code !== 0 || /not authenticated|not logged in/i.test(who.out)) {
  step('Sign in to Cloudflare in the browser window that opens. You only do this once.');
  const login = await wrangler(['login']);
  if (login.code !== 0) stop('The Cloudflare sign-in didn’t finish. Run Deploy again to retry.');
}

step('Publishing Conduit…');
const deploy = await wrangler(['deploy'], true);
if (deploy.code !== 0) stop('Publishing failed. The message above says why.');

const url = deploy.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
if (!url) {
  console.log('\n✔ Published. Your address is listed in the Cloudflare dashboard under Workers.\n');
  process.exit(0);
}
console.log(`\n✔ Conduit is live at ${url}\n`);
console.log('  Scan this with your phone camera to open it there:\n');
console.log(renderUnicodeCompact(url, { border: 2 }).split('\n').map((l) => `    ${l}`).join('\n'));
console.log('\n  Changed something? Run Deploy again. Updates take a few seconds.\n');
openInBrowser(url);
