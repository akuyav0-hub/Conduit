# Conduit

Private peer-to-peer file transfer for you and the friends you approve. It runs in any modern
browser and sends files straight from one device to the other, with no server in between.

## What it does

- **Sends anything, any size, including whole folders.** Use **Send** for files or **Folder** for
  a folder with all its subfolders, or drag either onto the window. The sender streams from disk
  and the receiver writes straight to disk, so size is limited by free disk space, not memory.
- **Folders arrive as folders.** A received folder shows up as one item in the Inbox. **Save
  folder** writes it whole, subfolders and all, into a folder you pick (Chrome or Edge on a
  computer). **Download .zip** works in every browser, phones included, and handles folders over
  4 GB. If you set **Receiving files** to a folder under **You**, folders land there directly.
- **Friends only.** You add someone with an invite link or QR code, then approve them. Strangers'
  connection attempts are ignored, and they can't see whether you're online.
- **Handles the details for you.** Shows who's online. Queues sends for offline friends and starts
  them the moment they come back. Resumes automatically from the exact byte after a connection
  drop. Lets you accept each transfer or always accept from a friend you trust. Has an Inbox to
  save, share and preview files. Installs as an app, and on Android it appears in the share sheet.
- **Fast.** There's no upload-then-download: data goes over one direct encrypted path, so speed is
  set by the slower side's network.

## Put it online

You need a free Cloudflare account and Node.js 22.12 or newer (the LTS version from nodejs.org).

**Double-click `Deploy.cmd`** on Windows or **`Deploy.command`** on a Mac. You can also run
`npm run ship` instead.

- **First run:** it installs the deploy tools and opens a browser window so you can sign in to
  Cloudflare (once). Then it publishes Conduit, opens it, and prints a QR code you can scan to open
  it on your phone.
- **Every run after that:** it publishes your changes in a few seconds.

Your address looks like `https://conduit.<your-subdomain>.workers.dev`. To change it, edit
`name` in `wrangler.jsonc` and deploy again. If Windows asks whether to run `Deploy.cmd` (because
it came from a download), choose Run. On a Mac, right-click `Deploy.command` and choose Open the
first time.

### Optional: turn on the relay for strict networks

Some networks (corporate firewalls, some mobile carriers) won't allow a direct connection. If a
friend shows as online but transfers say "No network path", turn on Cloudflare's TURN relay. The
first 1,000 GB each month are free, then it's $0.05 per GB. Relayed data stays end-to-end
encrypted, so the relay can't read it.

1. In the Cloudflare dashboard, open Realtime (`dash.cloudflare.com/?to=/:account/calls`) and
   create a TURN key. Copy its **key ID** and **API token**.
2. Store them as secrets (each command asks you to paste the value), then run Deploy again:
   ```bash
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```

Relay credentials are only given to devices that have at least one approved friend, so strangers
can't use up your relay allowance. `https://<your address>/api/health` shows `"turn": true` once
it's on.

## How the security works

- **Your identity is a key.** On first launch each browser creates a P-256 key pair. The private
  key is non-extractable: even Conduit's own code can't read it, only sign with it. Your device ID
  is a hash of your public key, so nobody can pose as you without your key.
- **The hub only introduces devices.** The Worker + Durable Object checks each device's signature
  when it connects and passes short connection messages between friends. Files, file names and
  file contents never pass through it.
- **Everything the hub passes along is signed.** Every message is signed by the sender's device
  and checked against the key you stored when you added them. Messages from anyone else are
  dropped. The WebRTC offer and answer are signed too, and they carry the encryption certificates'
  fingerprints, so the hub can't slip itself into the middle of the encrypted connection.
- **The invite secret never reaches the server.** An invite link holds your public key and a random
  secret, inside the part of the URL after `#`, which browsers don't send to servers. The person
  joining proves they have the secret with an HMAC tied to their own key. You still approve every
  request. Invites are either single-use for 24 hours, or for a group of up to 20 people for 7 days.
- **Safety codes.** Each pair of friends shares a 16-digit code made from both keys. If it matches
  on both screens, nobody tampered with the invite.
- **Presence is mutual.** You only see someone online if you both have each other as friends.
- **No third-party code.** Strict Content-Security-Policy; fonts and the QR encoder are bundled.

What the hub *can* see: which device IDs connect to each other and when, and the display name in
a friend request.

## Good to know

- If a friend's computer goes to sleep or drops off the internet, Conduit shows them offline
  within about three minutes. Anything you send meanwhile waits and starts when they're back.
- VPNs, including Opera's built-in VPN, can block the direct connection between two computers.
  If a transfer says "No network path", switch the VPN off on both ends, or turn on the relay.
- Both people need Conduit open during a transfer. Network drops resume on their own. If either
  side closes the page mid-transfer, send it again.
- Phones pause background tabs. Keep Conduit on screen while a transfer runs; it keeps the screen
  awake for you. On iPhone, add it to the Home Screen to get notifications.
- Received files land in the **Inbox** (the browser's private storage) until you save them. In
  Chrome or Edge on a computer you can choose **Save straight into a folder** under **You**. That
  path is best for very large files, because there's no second copy to save out afterwards.
- When you pick a folder, the browser asks for permission to view its files (or, in some
  browsers, whether to "upload" them). That's Chrome's
  standard wording for picking a folder: the files only go to the friend you chose. Empty
  subfolders aren't sent, only folders that contain files.
- Your identity lives in this browser. Clearing the site's data creates a new identity, and
  friends will need to add you again. Conduit works in one tab at a time.
- On a small 2-core cloud test machine, Conduit moved 300 MB at about 18 MB/s. Raw WebRTC on the
  same machine peaks at about 24 MB/s, so the app runs close to the browser's own ceiling.

## Develop and test

```bash
npm run dev                 # http://localhost:8787 — use two browsers or profiles as two people
npm run test:hub            # signaling hub protocol tests (with the dev server running)
npm i -D playwright && npx playwright install chromium
npm run test:e2e            # two real browsers: invites, 300 MB + 700 MB transfers with SHA-256
                            # checks, a forced mid-transfer drop + resume, folders (save whole,
                            # .zip incl. ZIP64), cancel, decline, offline queueing, friend
                            # removal, strangers ignored, a 31-minute clock error, a lost
                            # approval message, and browsers that won't pick folders
npm run test:liveness       # with `npx wrangler dev --var STALE_MS:4000 --var SWEEP_MS:1500`:
                            # silent connections are dropped and friends are told
# On a bare Linux server, run the browser tests with LANG=C.UTF-8 so Chrome can read
# non-English file names.
```

## Project layout

```
Deploy.cmd / .command  Double-click deploy (runs scripts/deploy.mjs)
src/worker.js          Hub: auth, signed-message relay, mutual presence, offline mailbox, TURN
public/index.html      App shell
public/app.css         Visual language: airfield signage (black = where, yellow = go, red = decide)
public/app.js          App controller: friends, invites, prompts, views
public/lib/identity.js Keys, signatures, invite codes, safety codes
public/lib/signal.js   Hub connection and message verification
public/lib/peer.js     One WebRTC link per friend (perfect negotiation + session recovery)
public/lib/transfer.js Transfer engine: chunking, flow control, resume
public/lib/sinks.js    Where incoming bytes go: folder, inbox (OPFS) or memory
public/lib/zip.js      Streaming .zip writer (stored, ZIP64) for downloading received folders
public/opfs-worker.js  Writes inbox files and builds .zip files on disk, off the main thread
public/sw.js           Installable app, offline shell, Android share target
test/                  Hub protocol tests and end-to-end browser tests
```

## Credits

Overpass typeface (SIL Open Font License, `public/fonts/OFL-overpass.txt`) and the uqr QR encoder
(MIT, header in `public/vendor/uqr.mjs`).
