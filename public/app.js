// Conduit — app controller: state, friends, prompts, rendering.

import { db, wipeEverything } from './lib/db.js';
import {
  loadIdentity, safetyCode, inviteProof, newInviteToken, encodeInvite, decodeInvite, extractInviteCode,
} from './lib/identity.js';
import { Signal } from './lib/signal.js';
import { PeerLink } from './lib/peer.js';
import { Transfers, isFinal } from './lib/transfer.js';
import { inboxFile, inboxRemove, inboxNames, inboxUsable, zipInbox } from './lib/sinks.js';
import { h, icon, openSheet, sheetHead, toast, confirmSheet, qrSvg } from './lib/ui.js';
import { fmtBytes, fmtSpeed, fmtDuration, fmtAgo, randomId } from './lib/util.js';

const VERSION = '1.5';
const $ = (id) => document.getElementById(id);
const RISKY = /\.(exe|msi|msix|bat|cmd|com|scr|pif|ps1|vbs|vbe|js|jse|wsf|hta|jar|apk|appx|dmg|pkg|app|sh|run|lnk|reg|iso|img)$/i;
const INVITE = {
  one: { ttl: 24 * 3600e3, max: 1, label: 'One person', note: 'Works once, for 24 hours.' },
  group: { ttl: 7 * 24 * 3600e3, max: 20, label: 'A group', note: 'Works for up to 20 people, for 7 days.' },
};
const LIVE = new Set(['sending', 'receiving']);
const CAN_PICK_FOLDER = 'webkitdirectory' in HTMLInputElement.prototype;
const CAN_SAVE_FOLDER = 'showDirectoryPicker' in window;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const JUNK = /^(thumbs\.db|desktop\.ini|\.ds_store)$/i; // OS clutter inside folders, never worth sending
const pct = (n, total) => Math.min(100, Math.floor((n / Math.max(total, 1)) * 100));

const S = {
  me: null,
  name: '',
  settings: { save: 'inbox', notify: false },
  friends: new Map(),
  online: new Set(),
  away: new Set(),
  invites: new Map(),
  requests: new Map(),
  history: [],
  inbox: [],
  mem: new Map(),
  thumbs: new Map(),
  folder: null,
  folderPerm: 'prompt',
  view: 'home',
  links: new Map(),
  log: [],
  unseen: 0,
  friendSheet: null,
  decisionsKey: '',
  expanded: new Set(),
  jobs: new Map(),
  zips: new Map(),
};

let signal;
let transfers;

// ───────────────────────────── hosts for the engine ─────────────────────────────

const nameOf = (id) => {
  const f = S.friends.get(id);
  return f ? f.nick || f.name || 'Friend' : 'Unknown device';
};

function log(msg) {
  const line = { t: new Date(), msg: String(msg) };
  S.log.push(line);
  if (S.log.length > 600) S.log.shift();
  if (!$('log').hidden) appendLogLine(line);
}

const linkHost = { get me() { return S.me; }, get signal() { return signal; }, log, nameOf };

const engineHost = {
  link: (id) => link(id),
  isOnline: (id) => (S.online.has(id) && !S.away.has(id)) || !!S.links.get(id)?.isOpen,
  isAway: (id) => S.online.has(id) && S.away.has(id),
  nameOf,
  log,
  decide: (b) => decideIncoming(b),
  sinkMode: (b, gesture) => sinkMode(b, gesture),
  received: (b, f, r) => addReceived(b, f, r),
  record: (b) => recordHistory(b),
  get folder() { return S.folder; },
};

function link(id) {
  let l = S.links.get(id);
  if (!l) {
    l = new PeerLink(linkHost, id);
    l.on('open', () => transfers.onLinkOpen(id));
    l.on('down', () => transfers.onLinkDown(id));
    l.on('ctrl', (m) => transfers.onCtrl(id, m, l));
    l.on('datachannel', (dc) => transfers.onDataChannel(id, dc));
    l.on('state', () => { renderFriends(); refreshFriendSheet(id); });
    S.links.set(id, l);
  }
  return l;
}

// ───────────────────────────── boot ─────────────────────────────

boot().catch((e) => {
  console.error(e);
  gate('Conduit couldn’t start', `${e.message || e}. Try reloading the page.`);
});

async function boot() {
  if (!window.isSecureContext || !window.RTCPeerConnection || !window.crypto?.subtle || !window.indexedDB) {
    gate('This browser can’t run Conduit', 'Open it in a current version of Chrome, Edge, Firefox or Safari, over an https:// address.');
    return;
  }
  S.me = await loadIdentity();
  const [profile, settings, folder, friends, invites, requests, history, inbox] = await Promise.all([
    db.get('kv', 'profile'), db.get('kv', 'settings'), db.get('kv', 'folder'),
    db.all('friends'), db.all('invites'), db.all('requests'), db.all('history'), db.all('inbox'),
  ]);
  S.name = profile?.name || '';
  Object.assign(S.settings, settings || {});
  S.folder = folder || null;
  for (const f of friends) S.friends.set(f.id, f);
  for (const i of invites) S.invites.set(i.token, i);
  for (const r of requests) S.requests.set(r.id, r);
  S.history = history.sort((a, b) => b.created - a.created);
  S.inbox = inbox.sort((a, b) => b.at - a.at);
  await tidyStorage();

  const inviteCode = extractInviteCode(location.hash);
  const shared = new URLSearchParams(location.search).has('shared');
  if (inviteCode || shared) window.history.replaceState(null, '', location.pathname);
  if (!shared) caches?.delete('conduit-share').catch(() => {});

  if (!S.name) await askName(inviteCode);
  start();
  if (inviteCode) openInvite(inviteCode);
  if (shared) openShared();
}

function gate(title, text, extra) {
  const root = $('gate-root');
  $('app').hidden = true;
  root.replaceChildren(h('div', { class: 'gate' },
    h('div', { class: 'plate' }, h('span', { class: 'plate-text' }, 'Conduit')),
    h('h1', { class: 'sheet-title' }, title),
    text ? h('p', {}, text) : null,
    extra || null));
}

function askName(fromInvite) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', id: 'first-name', maxlength: 32, autocomplete: 'nickname', placeholder: 'e.g. OJ', required: true });
    const form = h('form', { class: 'field', onsubmit: async (e) => {
      e.preventDefault();
      const name = cleanName(input.value);
      if (!name) { input.focus(); return; }
      S.name = name;
      await db.put('kv', { name }, 'profile');
      $('gate-root').replaceChildren();
      resolve();
    } },
      h('label', { for: 'first-name' }, 'Your name, as friends will see it'),
      input,
      h('button', { class: 'btn go', type: 'submit' }, 'Continue'));
    gate(fromInvite ? 'Someone invited you' : 'Send files straight to your friends',
      'Files go directly from your device to theirs. Nothing is uploaded to a server, and only friends you approve can reach you.',
      form);
    setTimeout(() => input.focus(), 50);
  });
}

function start() {
  $('gate-root').replaceChildren();
  $('app').hidden = false;

  signal = new Signal(S.me, (id) => S.friends.get(id) || null);
  transfers = new Transfers(engineHost);

  signal.on('state', (s) => {
    if (s !== 'online') S.online.clear();
    renderHub();
    renderFriends();
  });
  signal.on('presence-list', (ids, away) => {
    S.online = new Set(ids);
    S.away = new Set(away);
    renderFriends();
    for (const id of ids) transfers.kick(id);
  });
  signal.on('presence', onPresence);
  signal.on('message', (m) => onMessage(m).catch((e) => log(`message error: ${e.message}`)));
  signal.on('log', log);
  signal.on('replaced', () => {
    gate('Conduit is open in another tab', 'Only one tab can be connected at a time.',
      h('button', { class: 'btn go', onclick: () => location.reload() }, 'Use it here'));
  });
  transfers.on('update', onTransferUpdate);

  updateWatch();
  signal.start();
  wireStatic();
  renderAll();
  registerServiceWorker();
  setInterval(closeIdleLinks, 30e3);
  setInterval(() => { renderFriends(); renderActivity(); }, 60e3);
  log(`Conduit ${VERSION} on this device: ${S.me.id}`);
}

async function tidyStorage() {
  // Transfers that were running when the page closed can't resume (the files aren't open anymore).
  for (const rec of S.history) {
    if (!['done', 'declined', 'canceled', 'failed'].includes(rec.status)) {
      rec.status = 'failed';
      rec.note = 'Stopped when the page was closed';
      db.put('history', rec).catch(() => {});
    }
  }
  for (const rec of S.history.slice(150)) db.del('history', rec.tid).catch(() => {});
  S.history = S.history.slice(0, 150);
  for (const rec of S.inbox) {
    if (rec.kind === 'memory') { rec.kind = 'gone'; db.put('inbox', rec).catch(() => {}); }
  }
  // Partial files from interrupted receives.
  const keep = new Set(S.inbox.filter((r) => r.opfs).map((r) => r.opfs));
  for (const name of await inboxNames()) if (!keep.has(name)) inboxRemove(name);
  if (S.folder) {
    try { S.folderPerm = await S.folder.queryPermission({ mode: 'readwrite' }); } catch { S.folderPerm = 'prompt'; }
  }
}

// ───────────────────────────── presence & messages ─────────────────────────────

function updateWatch() { signal.setWatch([...S.friends.keys()]); }

function onPresence(id, online, away) {
  const f = S.friends.get(id);
  if (online && away) S.away.add(id); else S.away.delete(id);
  if (online) S.online.add(id);
  else {
    S.online.delete(id);
    if (f) { f.lastSeen = Date.now(); saveFriend(f); }
  }
  renderFriends();
  refreshFriendSheet(id);
  transfers.kick(id); // starts waiting sends, or updates what they're waiting for
}

async function onMessage(msg) {
  const f = S.friends.get(msg.from);
  switch (msg.type) {
    case 'friend-request': return onFriendRequest(msg);
    case 'friend-accept':
      if (f?.status === 'pending-out') {
        f.status = 'friend';
        f.name = cleanName(msg.body?.n) || f.name;
        delete f.token;
        await saveFriend(f);
        signal.refreshIce();
        renderAll();
        toast(`${f.name} approved you. You can send files now.`);
        notify('Friend approved', `${f.name} approved your request`);
      }
      return undefined;
    case 'friend-decline':
      if (f?.status === 'pending-out') {
        await dropFriend(f.id);
        toast(`${f.name} declined your friend request`);
      }
      return undefined;
    case 'friend-remove':
      if (f) {
        const name = nameOf(f.id);
        await dropFriend(f.id);
        toast(`${name} removed you as a friend`);
      }
      return undefined;
    case 'profile':
      if (f?.status === 'friend' && typeof msg.body?.n === 'string') {
        f.name = cleanName(msg.body.n) || f.name;
        await saveFriend(f);
        renderFriends();
      }
      return undefined;
    case 'sdp': case 'ice': case 'bye':
      if (f?.status === 'pending-out' && msg.type === 'sdp') {
        // Their app only ever calls approved friends, so a signed call from them is their approval
        // (covers an approval message that got lost on the way).
        f.status = 'friend';
        delete f.token;
        await saveFriend(f);
        updateWatch();
        signal.refreshIce();
        renderAll();
        log(`${f.name} is calling, so they've approved you`);
        toast(`${f.name} approved you. You can send files now.`);
      }
      if (f?.status === 'friend') link(f.id).onSignal(msg.type, msg.body);
      else log(`ignored a connection attempt from ${f ? nameOf(f.id) : 'a device that isn’t your friend'}`);
      return undefined;
    default:
      log(`ignored unknown message type "${msg.type}"`);
      return undefined;
  }
}

// ───────────────────────────── friends & invites ─────────────────────────────

function cleanName(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);
}

async function saveFriend(f) { await db.put('friends', f); }

async function dropFriend(id) {
  S.friends.delete(id);
  await db.del('friends', id);
  for (const b of transfers.all()) if (b.peer === id && !isFinal(b)) transfers.cancel(b.tid, 'Friend removed');
  S.links.get(id)?.close('friend removed');
  S.links.delete(id);
  updateWatch();
  if (S.friendSheet?.id === id) S.friendSheet.sheet.close();
  renderAll();
}

async function createInvite(kind, label) {
  const k = INVITE[kind] || INVITE.one;
  const inv = { token: newInviteToken(), label: cleanName(label), kind, created: Date.now(), exp: Date.now() + k.ttl, max: k.max, uses: 0 };
  S.invites.set(inv.token, inv);
  await db.put('invites', inv);
  renderYou();
  return inv;
}

const inviteLink = (inv) => `${location.origin}/#join=${encodeInvite({ pub: S.me.pub, token: inv.token, name: S.name })}`;
const inviteLive = (inv) => inv.exp > Date.now() && inv.uses < inv.max;

async function matchInvite(k, proof) {
  if (typeof k !== 'string' || typeof proof !== 'string') return null;
  for (const inv of S.invites.values()) {
    if (!inviteLive(inv)) continue;
    if ((await inviteProof(inv.token, k, S.me.id)) === proof) return inv;
  }
  return null;
}

async function onFriendRequest(msg) {
  const { k, n, p } = msg.body || {};
  const name = cleanName(n) || 'Someone';
  const existing = S.friends.get(msg.from);
  if (existing?.status === 'friend') { sendAccept(existing.id); return; }
  const inv = await matchInvite(k, p);
  if (!inv) {
    log(`ignored a friend request from "${name}": it didn't come with a valid invite of yours`);
    return;
  }
  if (existing?.status === 'pending-out') {
    // You both invited each other. Their request with your invite is their approval.
    existing.status = 'friend';
    existing.name = name;
    await saveFriend(existing);
    await useInvite(inv);
    sendAccept(existing.id);
    renderAll();
    toast(`You and ${name} are connected`);
    return;
  }
  if (S.requests.has(msg.from)) return;
  const req = { id: msg.from, pub: k, name, token: inv.token, label: inv.label, at: Date.now() };
  S.requests.set(req.id, req);
  await db.put('requests', req);
  renderDecisions();
  notify('Friend request', `${name} wants to connect`);
}

async function useInvite(inv) {
  inv.uses++;
  await db.put('invites', inv);
  renderYou();
}

function sendAccept(id) {
  signal.send(id, 'friend-accept', { n: S.name }, { queue: true });
}

async function approveRequest(id) {
  const req = S.requests.get(id);
  if (!req) return;
  const f = {
    id: req.id, pub: req.pub, name: req.name, nick: '', status: 'friend',
    verified: false, autoAccept: false, addedAt: Date.now(), lastSeen: 0,
  };
  S.friends.set(f.id, f);
  await saveFriend(f);
  S.requests.delete(id);
  await db.del('requests', id);
  const inv = S.invites.get(req.token);
  if (inv) await useInvite(inv);
  sendAccept(f.id);
  updateWatch();
  signal.refreshIce();
  renderAll();
  toast(`You and ${f.name} are connected`);
}

async function declineRequest(id) {
  if (!S.requests.has(id)) return;
  S.requests.delete(id);
  await db.del('requests', id);
  signal.send(id, 'friend-decline', {}, { queue: true });
  renderDecisions();
}

async function openInvite(code) {
  let inv;
  try { inv = await decodeInvite(code); } catch {
    toast('That invite link is damaged or incomplete. Ask for a new one.', { bad: true });
    return;
  }
  if (inv.id === S.me.id) { toast('That’s your own invite. Send it to a friend.'); return; }
  const existing = S.friends.get(inv.id);
  if (existing?.status === 'friend') { toast(`You’re already connected with ${nameOf(inv.id)}`); return; }
  const code16 = await safetyCode(S.me.pub, inv.pub);
  openSheet((sheet) => [
    sheetHead(inv.name, sheet, { plate: true }),
    h('h2', { class: 'sheet-title' }, `Add ${inv.name} as a friend?`),
    h('p', { class: 'lede' }, `Only use invites that came straight from ${inv.name}. Once they approve you, you can send files to each other.`),
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Safety code'),
      h('p', { class: 'code' }, code16),
      h('p', { class: 'lede' }, 'You’ll both see this code. If it matches on their screen, nobody is in the middle.')),
    h('div', { class: 'row' },
      h('button', { class: 'btn go', onclick: async (e) => { e.currentTarget.disabled = true; await sendFriendRequest(inv); sheet.close(); } }, 'Send friend request'),
      h('button', { class: 'btn quiet', onclick: () => sheet.close() }, 'Not now')),
  ], { label: `Add ${inv.name}` });
}

async function sendFriendRequest(inv) {
  const f = {
    id: inv.id, pub: inv.pub, name: inv.name, nick: '', status: 'pending-out', token: inv.token,
    verified: false, autoAccept: false, addedAt: Date.now(), lastSeen: 0,
  };
  S.friends.set(f.id, f);
  await saveFriend(f);
  updateWatch();
  renderFriends();
  const r = await resendRequest(f);
  if (r.t === 'err') toast(`Couldn’t deliver the request (${r.e})`, { bad: true });
  else toast(r.t === 'sent' ? `Request sent to ${inv.name}` : `Your request will reach ${inv.name} when they’re online`);
}

async function resendRequest(f) {
  const p = await inviteProof(f.token, S.me.pub, f.id);
  return signal.send(f.id, 'friend-request', { k: S.me.pub, n: S.name, p }, { queue: true });
}

async function removeFriend(id) {
  const f = S.friends.get(id);
  if (!f) return;
  const pending = f.status === 'pending-out';
  const ok = await confirmSheet({
    title: pending ? `Cancel your request to ${nameOf(id)}?` : `Remove ${nameOf(id)}?`,
    body: pending ? 'You can ask again later with a new invite.' : 'They won’t be able to send you files or see when you’re online. To reconnect, one of you will need a new invite.',
    yes: pending ? 'Cancel request' : 'Remove friend',
    danger: true,
  });
  if (!ok) return;
  if (!pending) signal.send(id, 'friend-remove', {}, { queue: true });
  await dropFriend(id);
}

async function revokeInvite(token) {
  S.invites.delete(token);
  await db.del('invites', token);
  renderYou();
}

// ───────────────────────────── receiving ─────────────────────────────

function decideIncoming(b) {
  const f = S.friends.get(b.peer);
  if (f?.autoAccept) {
    transfers.accept(b.tid, { gesture: false });
    toast(`Receiving ${titleOf(b)} from ${nameOf(b.peer)}`);
    return;
  }
  renderDecisions();
  notify('Incoming files', `${nameOf(b.peer)} wants to send you ${titleOf(b)} (${fmtBytes(b.total)})`);
}

async function sinkMode(b, gesture) {
  if (S.settings.save === 'folder' && S.folder) {
    try {
      let perm = await S.folder.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted' && gesture) perm = await S.folder.requestPermission({ mode: 'readwrite' });
      S.folderPerm = perm;
      if (perm === 'granted') return 'folder';
      log('no permission for your save folder, so this transfer goes to the Inbox');
      toast('Conduit needs permission to use your save folder, so these files went to the Inbox. You can allow it under You.');
    } catch (e) {
      log(`save folder unavailable: ${e.message}`);
    }
  }
  if (await inboxUsable()) {
    navigator.storage?.persist?.().catch(() => {});
    return 'inbox';
  }
  return 'memory';
}

async function addReceived(b, f, r) {
  const rec = {
    key: `${b.tid}:${f.i}`, tid: b.tid, from: b.peer, fromName: nameOf(b.peer),
    name: f.name, path: f.path, size: f.size, type: f.type, at: Date.now(),
    kind: r.kind, opfs: r.opfs || null, savedAs: r.savedAs || null,
  };
  if (r.kind === 'memory') S.mem.set(rec.key, r.blob);
  S.inbox.unshift(rec);
  await db.put('inbox', rec);
  if (S.view !== 'inbox') S.unseen++;
  renderBadge();
  renderInboxSoon();
}

let inboxTimer = null;
function renderInboxSoon() {
  if (inboxTimer) return;
  inboxTimer = setTimeout(() => { inboxTimer = null; renderInbox(); }, 150);
}

function recordHistory(b) {
  const rec = {
    tid: b.tid, dir: b.dir, peer: b.peer, peerName: nameOf(b.peer), title: titleOf(b),
    count: b.files.length, total: b.total, status: b.status, note: b.note,
    created: b.created, finished: b.finished || 0,
  };
  const i = S.history.findIndex((x) => x.tid === b.tid);
  if (i >= 0) S.history[i] = rec; else S.history.unshift(rec);
  db.put('history', rec).catch(() => {});
}

// Folders travel as their files plus each file's folder path; these read the shape back out.
function describe(files) {
  const roots = [];
  const seen = new Set();
  let loose = 0;
  for (const f of files) {
    const root = f.path ? f.path.split('/')[0] : '';
    if (!root) loose++;
    else if (!seen.has(root)) { seen.add(root); roots.push(root); }
  }
  return { roots, loose, count: files.length };
}

function titleOf(b) {
  const { roots, loose, count } = describe(b.files);
  if (!roots.length) return count === 1 ? b.files[0].name : `${b.files[0].name} and ${count - 1} more`;
  const folders = roots.length === 1 ? `${roots[0]} folder` : plural(roots.length, 'folder');
  return loose ? `${folders} and ${plural(loose, 'file')}` : `${folders}, ${plural(count, 'file')}`;
}

function onTransferUpdate(b) {
  if (b._status !== b.status) {
    b._status = b.status;
    if (LIVE.has(b.status) || isFinal(b)) recordHistory(b);
    renderDecisions();
    renderActivity();
    refreshFriendSheet(b.peer);
    syncWakeLock();
  } else {
    updateRow(b);
  }
  updateTitle();
}

// ───────────────────────────── sending ─────────────────────────────

let pickTarget = null;

let classicFolderPicker = false;

function pickFiles(id, folder = false) {
  pickTarget = id;
  if (folder && CAN_SAVE_FOLDER && !classicFolderPicker) { pickFolderToSend(id); return; }
  const input = folder ? $('folder-input') : $('file-input');
  input.value = '';
  input.click();
}

// Chrome, Edge and Opera on a computer: the modern folder picker, which reads the folder directly.
async function pickFolderToSend(id) {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'conduit-send', mode: 'read' });
  } catch (e) {
    if (e.name === 'AbortError') return;
    log(`the modern folder picker was blocked (${e.message}); using the classic one`);
    classicFolderPicker = true;
    pickFiles(id, true);
    return;
  }
  const items = [];
  const reading = setTimeout(() => toast(`Reading “${dir.name}”…`), 400);
  try {
    await readFolder(dir, dir.name, items);
  } catch (e) {
    clearTimeout(reading);
    toast(`Couldn’t read ${dir.name}: ${e.message}`, { bad: true });
    return;
  }
  clearTimeout(reading);
  if (!items.length) { toast(`${dir.name} has no files to send`); return; }
  reviewSend(id, items, true);
}

async function readFolder(handle, path, out) {
  for await (const [name, child] of handle.entries()) {
    if (child.kind === 'directory') await readFolder(child, `${path}/${name}`, out);
    else if (!JUNK.test(name)) out.push({ file: await child.getFile(), dir: path });
  }
}

function onPicked(e) {
  const input = e.target;
  const files = [...input.files];
  input.value = '';
  if (!files.length || !pickTarget) return;
  if (input.id === 'folder-input') {
    // Some browsers ignore "pick a folder" and hand back loose files instead.
    if (files.every((f) => !f.webkitRelativePath)) { askFolderName(pickTarget, files); return; }
    reviewSend(pickTarget, files.filter((f) => !JUNK.test(f.name))
      .map((file) => ({ file, dir: file.webkitRelativePath.split('/').slice(0, -1).join('/') })), true);
    return;
  }
  reviewSend(pickTarget, files.map((file) => ({ file, dir: '' })), false);
}

function askFolderName(id, files) {
  const input = h('input', { class: 'input', id: 'folder-name', maxlength: 64, value: 'Shared folder', autocomplete: 'off' });
  openSheet((sheet) => [
    sheetHead('Send these as one folder?', sheet),
    h('p', { class: 'lede' }, `This browser picked ${plural(files.length, 'file')} instead of a whole folder. ${nameOf(id)} can receive them together as one folder.`),
    h('div', { class: 'field' }, h('label', { for: 'folder-name' }, 'Folder name'), input),
    h('div', { class: 'row' },
      h('button', { class: 'btn go', onclick: () => {
        const name = cleanName(input.value) || 'Shared folder';
        sheet.close();
        sendTo(id, files.map((file) => ({ file, dir: name })));
      } }, icon('folder'), 'Send as one folder'),
      h('button', { class: 'btn quiet', onclick: () => { sheet.close(); sendTo(id, files.map((file) => ({ file, dir: '' }))); } }, 'Send as separate files')),
    h('p', { class: 'lede' }, 'Tip: you can also drag a folder from File Explorer onto the Conduit window and drop it on a friend.'),
  ], { label: 'Send as one folder' });
  setTimeout(() => input.select(), 50);
}

// Shows exactly what's about to go, so nothing is sent by surprise.
function reviewRows(items) {
  const roots = new Set(items.map((it) => it.dir.split('/')[0]).filter(Boolean));
  const single = roots.size === 1 && items.every((it) => it.dir);
  const rows = new Map();
  for (const it of items) {
    const parts = it.dir ? it.dir.split('/') : [];
    const rel = single ? parts.slice(1) : parts;
    const key = rel.length ? `d:${rel[0]}` : `f:${rows.size}`;
    let r = rows.get(key);
    if (!r) { r = rel.length ? { folder: true, name: rel[0], count: 0, size: 0 } : { folder: false, name: it.file.name, count: 1, size: 0 }; rows.set(key, r); }
    if (r.folder) r.count++;
    r.size += it.file.size;
  }
  const list = [...rows.values()].sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1));
  return { root: single ? [...roots][0] : null, list };
}

function reviewSend(id, items, folder) {
  if (!items.length || !S.friends.has(id)) return;
  const who = nameOf(id);
  const total = items.reduce((n, it) => n + it.file.size, 0);
  const { root, list } = reviewRows(items);
  const shown = list.slice(0, 12);
  const title = root || (items.length === 1 ? items[0].file.name : titleOf({ files: items.map((it) => ({ name: it.file.name, path: it.dir })) }));
  openSheet((sheet) => [
    sheetHead(`Send to ${who}`, sheet, { plate: true }),
    h('div', { class: 'review-head' },
      h('div', { class: 'thumb folder', 'aria-hidden': 'true' }, icon(root ? 'folder' : 'out')),
      h('div', {},
        h('p', { class: 'sheet-title', id: 'review-title' }, title),
        h('p', { class: 'lede' }, `${root ? 'Folder, ' : ''}${plural(items.length, 'file')}, ${fmtBytes(total)}`))),
    list.length > 1 || root ? h('ul', { class: 'subfiles review' },
      shown.map((r) => h('li', {},
        h('span', { class: 'subfile-name' }, r.folder ? `${r.name}/` : r.name),
        h('span', { class: 'subfile-size' }, r.folder ? `${plural(r.count, 'file')}, ${fmtBytes(r.size)}` : fmtBytes(r.size)),
        h('span'))),
      list.length > shown.length ? h('li', { class: 'subfile-more' }, `and ${list.length - shown.length} more`) : null) : null,
    engineHost.isOnline(id) ? null : h('p', { class: 'lede' }, `${who} isn’t online right now. It will start as soon as they open Conduit.`),
    h('div', { class: 'row' },
      h('button', { class: 'btn go', onclick: () => { sheet.close(); sendTo(id, items); } }, icon('out'), `Send to ${who}`),
      folder !== null ? h('button', { class: 'btn quiet', onclick: () => { sheet.close(); pickFiles(id, folder); } }, folder ? 'Pick a different folder' : 'Pick different files') : null,
      h('button', { class: 'btn quiet', onclick: () => sheet.close() }, 'Cancel')),
  ], { label: `Send to ${who}` });
}

function sendTo(id, items) {
  const f = S.friends.get(id);
  if (!f || f.status !== 'friend' || !items.length) return;
  transfers.send(id, items);
  if (S.friendSheet?.id === id) S.friendSheet.sheet.close();
  showView('home');
}

function captureDrop(dt) {
  const entries = [...(dt.items || [])].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  return { entries, files: [...(dt.files || [])] };
}

async function expandDrop({ entries, files }) {
  if (!entries.length) return files.map((file) => ({ file, dir: '' }));
  const out = [];
  const walk = async (entry, dir) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      if (dir && JUNK.test(file.name)) return;
      out.push({ file, dir });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const sub = dir ? `${dir}/${entry.name}` : entry.name;
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, sub);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

function sendableFriends() {
  return [...S.friends.values()].filter((f) => f.status === 'friend').sort(byPresenceThenName);
}

function chooseFriendSheet(items) {
  const friends = sendableFriends();
  if (!friends.length) { toast('Add a friend first, then you can send them files'); return; }
  const total = items.reduce((s, it) => s + it.file.size, 0);
  openSheet((sheet) => [
    sheetHead('Send to…', sheet),
    h('p', { class: 'lede' }, `${items.length === 1 ? items[0].file.name : `${items.length} files`}, ${fmtBytes(total)}`),
    h('div', { class: 'drop-targets' }, friends.map((f) => h('button', {
      class: engineHost.isOnline(f.id) ? 'plate drop-target' : 'plate drop-target offline',
      onclick: () => { sheet.close(); sendTo(f.id, items); },
    }, h('span', { class: 'plate-text' }, nameOf(f.id))))),
  ], { label: 'Choose a friend' });
}

async function openShared() {
  try {
    const cache = await caches.open('conduit-share');
    const keys = await cache.keys();
    const items = [];
    for (const req of keys) {
      const res = await cache.match(req);
      const name = decodeURIComponent(res.headers.get('x-name') || 'shared-file');
      const blob = await res.blob();
      items.push({ file: new File([blob], name, { type: res.headers.get('content-type') || '' }), dir: '' });
    }
    if (items.length) chooseFriendSheet(items);
  } catch (e) {
    log(`couldn't read shared files: ${e.message}`);
  }
}

// ───────────────────────────── rendering ─────────────────────────────

function renderAll() {
  $('me-name').textContent = S.name;
  renderHub();
  renderDecisions();
  renderFriends();
  renderActivity();
  renderInbox();
  renderYou();
  renderBadge();
  updateTitle();
}

function renderHub() {
  const s = signal?.state || 'offline';
  const dot = $('hub-status').querySelector('.dot');
  dot.className = s === 'online' ? 'dot on' : s === 'connecting' ? 'dot wait' : 'dot';
  $('hub-text').textContent = s === 'online' ? 'Online' : s === 'connecting' ? 'Connecting…' : 'Offline, retrying';
}

function byPresenceThenName(a, b) {
  const rank = (f) => (f.status === 'pending-out' ? 3 : engineHost.isOnline(f.id) ? 0 : engineHost.isAway(f.id) ? 1 : 2);
  return rank(a) - rank(b) || nameOf(a.id).localeCompare(nameOf(b.id));
}

function friendStatus(f) {
  const l = S.links.get(f.id);
  if (f.status === 'pending-out') return `Waiting for ${nameOf(f.id)} to approve you`;
  if (l?.isOpen) return l.route === 'relay' ? 'Connected through a relay' : 'Connected directly';
  if (engineHost.isOnline(f.id)) return 'Online';
  if (engineHost.isAway(f.id)) return 'Conduit is in the background on their phone';
  return f.lastSeen ? `Last seen ${fmtAgo(f.lastSeen)}` : 'Offline';
}

function renderFriends() {
  const list = $('friend-list');
  if (!list) return;
  const friends = [...S.friends.values()].sort(byPresenceThenName);
  if (!friends.length) {
    list.replaceChildren(h('li', { class: 'empty' },
      h('p', {}, 'No friends yet. Make an invite and send it to someone. Once you approve them, you can trade files.'),
      h('button', { class: 'btn go', onclick: openAddFriend }, icon('plus'), 'Invite a friend')));
    return;
  }
  list.replaceChildren(...friends.map((f) => {
    const online = engineHost.isOnline(f.id);
    const pending = f.status === 'pending-out';
    return h('li', { class: 'friend', dataset: { id: f.id } },
      h('span', { class: online ? 'dot on' : pending || engineHost.isAway(f.id) ? 'dot wait' : 'dot', 'aria-hidden': 'true' }),
      h('button', { class: 'friend-open', onclick: () => openFriend(f.id), 'aria-label': `${nameOf(f.id)}: ${friendStatus(f)}` },
        h('span', { class: 'friend-name' }, nameOf(f.id)),
        h('span', { class: 'friend-sub' },
          h('span', {}, friendStatus(f)),
          f.verified ? h('span', { class: 'tag checked' }, 'Code checked') : null,
          f.autoAccept ? h('span', {}, 'Auto-accepts') : null)),
      pending ? null : h('div', { class: 'friend-actions' },
        h('button', { class: 'btn go small', onclick: () => pickFiles(f.id), 'aria-label': `Send files to ${nameOf(f.id)}` }, icon('out'), 'Send'),
        CAN_PICK_FOLDER ? h('button', { class: 'btn quiet small', onclick: () => pickFiles(f.id, true), 'aria-label': `Send a folder to ${nameOf(f.id)}` }, icon('folder'), 'Folder') : null));
  }));
}

function renderDecisions() {
  const box = $('decisions');
  const pendingIn = transfers ? [...transfers.in.values()].filter((b) => b.status === 'pending') : [];
  const key = [...S.requests.keys(), ...pendingIn.map((b) => b.tid)].join(',');
  if (key === S.decisionsKey) return;
  S.decisionsKey = key;
  const items = [
    ...[...S.requests.values()].map(requestDecision),
    ...pendingIn.map(offerDecision),
  ];
  box.replaceChildren(...items);
  box.hidden = !items.length;
  updateTitle();
}

const holdShort = () => h('div', { class: 'hold-short', 'aria-hidden': 'true' });

function requestDecision(req) {
  const code = h('p', { class: 'decision-meta' }, 'Safety code …');
  safetyCode(S.me.pub, req.pub).then((c) => { code.textContent = `Safety code ${c}`; });
  return h('section', { class: 'decision', 'aria-label': `Friend request from ${req.name}` },
    holdShort(),
    h('div', { class: 'decision-body' },
      h('p', { class: 'decision-title' }, `${req.name} wants to connect`),
      h('p', { class: 'decision-meta' }, req.label ? `Used your invite for ${req.label}, ${fmtAgo(req.at)}.` : `Used one of your invites, ${fmtAgo(req.at)}.`),
      code,
      h('div', { class: 'decision-actions' },
        h('button', { class: 'btn stop', onclick: () => approveRequest(req.id) }, icon('check'), 'Approve'),
        h('button', { class: 'btn quiet', onclick: () => declineRequest(req.id) }, 'Decline'))));
}

function offerDecision(b) {
  const name = nameOf(b.peer);
  const names = b.files.slice(0, 2).map((f) => f.name);
  const more = b.files.length - names.length;
  const shape = describe(b.files);
  const what = !shape.roots.length
    ? (b.files.length === 1 ? 'a file' : plural(b.files.length, 'file'))
    : `${shape.roots.length === 1 ? `the ${shape.roots[0]} folder` : plural(shape.roots.length, 'folder')}${shape.loose ? ` and ${plural(shape.loose, 'file')}` : ''}`;
  const detail = shape.roots.length
    ? `${plural(b.files.length, 'file')}, ${fmtBytes(b.total)}`
    : `${fmtBytes(b.total)}: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  const risky = b.files.filter((f) => RISKY.test(f.name));
  const always = h('input', { type: 'checkbox' });
  const warn = h('p', { class: 'decision-warn', hidden: true });
  storageWarning(b).then((text) => { if (text) { warn.textContent = text; warn.hidden = false; } });
  return h('section', { class: 'decision', 'aria-label': `Incoming files from ${name}` },
    holdShort(),
    h('div', { class: 'decision-body' },
      h('p', { class: 'decision-title' }, `${name} wants to send you ${what}`),
      h('p', { class: 'decision-meta' }, detail),
      risky.length ? h('p', { class: 'decision-warn' }, `Includes ${risky.length === 1 ? 'a program' : `${risky.length} programs`} (${risky[0].name}). Only open it if you expected it from ${name}.`) : null,
      warn,
      h('div', { class: 'decision-actions' },
        h('button', { class: 'btn stop', onclick: () => {
          if (always.checked) {
            const f = S.friends.get(b.peer);
            if (f) { f.autoAccept = true; saveFriend(f); renderFriends(); }
          }
          transfers.accept(b.tid, { gesture: true });
        } }, icon('in'), 'Accept'),
        h('button', { class: 'btn quiet', onclick: () => transfers.decline(b.tid) }, 'Decline'),
        h('label', { class: 'check' }, always, `Always accept from ${name}`))));
}

async function storageWarning(b) {
  if (S.settings.save === 'folder' && S.folder) return '';
  try {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    const free = quota - usage;
    if (quota && b.total > free) {
      return `This needs ${fmtBytes(b.total)}, but the browser only has ${fmtBytes(free)} free for Conduit. ${'showDirectoryPicker' in window ? 'Under You, switch Receiving files to a folder, or free up space.' : 'Free up space on this device first.'}`;
    }
  } catch { /* estimate unsupported */ }
  return '';
}

// Transfers list: live transfers keep their row elements so progress updates are cheap.
const rows = new Map();

function activityItems() {
  const live = transfers ? transfers.all().filter((b) => !b.cleared && b.status !== 'collecting' && !(b.dir === 'in' && b.status === 'pending')) : [];
  const liveIds = new Set(live.map((b) => b.tid));
  const past = S.history.filter((r) => !liveIds.has(r.tid) && !r.cleared);
  const active = live.filter((b) => !isFinal(b)).sort((a, b) => b.created - a.created);
  const finished = [...live.filter((b) => isFinal(b)), ...past].sort((a, b) => (b.finished || b.created) - (a.finished || a.created));
  return [...active, ...finished].slice(0, 40);
}

function renderActivity() {
  const list = $('activity');
  if (!list || !transfers) return;
  const items = activityItems();
  $('clear-finished').hidden = !items.some((b) => isFinal(b));
  if (!items.length) {
    rows.clear();
    list.replaceChildren(h('li', { class: 'empty' }, S.friends.size
      ? 'Nothing moving yet. Use Send or Folder next to a friend, or drop files and folders onto this window.'
      : 'Transfers show up here once you’ve added a friend.'));
    return;
  }
  const keep = new Set();
  const els = items.map((b) => {
    keep.add(b.tid);
    let row = rows.get(b.tid);
    if (!row) { row = buildRow(b); rows.set(b.tid, row); }
    fillRow(row, b);
    return row.el;
  });
  for (const tid of rows.keys()) if (!keep.has(tid)) rows.delete(tid);
  list.replaceChildren(...els);
}

function buildRow(b) {
  const row = {
    el: h('li', { class: 'xfer' }),
    dir: h('span', { class: b.dir === 'in' ? 'xfer-dir in' : 'xfer-dir' }, icon(b.dir === 'in' ? 'in' : 'out')),
    title: h('span', { class: 'xfer-title' }),
    action: h('span'),
    meta: h('div', { class: 'xfer-meta' }),
    fill: h('div', { class: 'lane-fill' }),
    note: h('div', { class: 'xfer-note' }),
  };
  row.lane = h('div', { class: 'lane', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, row.fill);
  row.el.append(h('div', { class: 'xfer-top' }, row.dir, row.title, row.action), row.meta, row.lane, row.note);
  return row;
}

function fillRow(row, b) {
  const live = !!b.files;
  const done = !live ? (b.status === 'done' ? b.total : 0) : b.dir === 'out' ? b.acked : b.written;
  const pct = b.total ? (done / b.total) * 100 : b.status === 'done' ? 100 : 0;
  const moving = LIVE.has(b.status);
  row.el.className = `xfer ${b.status}${moving ? ' moving' : ''}`;
  row.title.textContent = live ? titleOf(b) : b.title;
  row.title.title = row.title.textContent;
  row.fill.style.setProperty('--p', `${pct.toFixed(2)}%`);
  row.lane.setAttribute('aria-valuenow', pct.toFixed(0));
  row.lane.setAttribute('aria-label', `${row.title.textContent}: ${pct.toFixed(0)}%`);
  row.note.textContent = b.note || '';

  const who = live ? nameOf(b.peer) : b.peerName || nameOf(b.peer);
  const meta = [h('span', {}, b.dir === 'in' ? 'from ' : 'to ', h('b', {}, who))];
  meta.push(h('span', {}, moving || (live && !isFinal(b)) ? `${fmtBytes(done)} of ${fmtBytes(b.total)}` : fmtBytes(b.total)));
  if (moving && live) {
    const rate = b.speed.rate();
    meta.push(h('span', {}, fmtSpeed(rate)));
    if (rate > 0) meta.push(h('span', {}, `${fmtDuration((b.total - done) / rate)} left`));
    const l = S.links.get(b.peer);
    if (l?.route) meta.push(h('span', { class: l.route === 'relay' ? 'route relay' : 'route' }, l.route === 'relay' ? 'Relay' : 'Direct'));
  } else if (isFinal(b)) {
    meta.push(h('span', {}, fmtAgo(b.finished || b.created)));
  }
  row.meta.replaceChildren(...meta);

  let action = null;
  if (live && !isFinal(b)) {
    action = h('button', { class: 'btn quiet small', onclick: () => transfers.cancel(b.tid) }, 'Cancel');
  } else if (live && b.dir === 'out' && ['failed', 'canceled', 'declined'].includes(b.status) && S.friends.get(b.peer)?.status === 'friend') {
    action = h('button', { class: 'btn quiet small', onclick: () => {
      b.cleared = true;
      sendTo(b.peer, b.files.map((f) => ({ file: f.file, dir: f.path })));
    } }, icon('retry'), 'Send again');
  } else if (b.dir === 'in' && b.status === 'done') {
    action = h('button', { class: 'btn quiet small', onclick: () => showView('inbox') }, 'Open inbox');
  }
  row.action.replaceChildren(...(action ? [action] : []));
}

function updateRow(b) {
  const row = rows.get(b.tid);
  if (row) fillRow(row, b);
}

function clearFinished() {
  for (const b of transfers.all()) if (isFinal(b)) b.cleared = true;
  for (const r of S.history) db.del('history', r.tid).catch(() => {});
  S.history = [];
  renderActivity();
}

function updateTitle() {
  const decisions = S.requests.size + (transfers ? [...transfers.in.values()].filter((b) => b.status === 'pending').length : 0);
  const moving = transfers ? transfers.all().filter((b) => LIVE.has(b.status)) : [];
  let title = 'Conduit';
  if (moving.length) {
    const total = moving.reduce((s, b) => s + b.total, 0);
    const done = moving.reduce((s, b) => s + (b.dir === 'out' ? b.acked : b.written), 0);
    title = `Conduit (${Math.floor((done / Math.max(total, 1)) * 100)}%)`;
  }
  if (decisions) title = `(${decisions}) ${title}`;
  document.title = title;
}

function renderBadge() {
  const badge = $('inbox-badge');
  badge.hidden = !S.unseen;
  badge.textContent = S.unseen > 99 ? '99+' : String(S.unseen);
}

// ───────────────────────────── friend sheet ─────────────────────────────

function openFriend(id) {
  if (!S.friends.has(id)) return;
  const sheet = openSheet((s) => friendSheetContent(s, id), {
    label: nameOf(id),
    onClose: () => { if (S.friendSheet?.sheet === sheet) S.friendSheet = null; },
  });
  S.friendSheet = { id, sheet };
}

function refreshFriendSheet(id) {
  if (S.friendSheet?.id === id && S.friends.has(id)) {
    S.friendSheet.sheet.set(friendSheetContent(S.friendSheet.sheet, id));
  }
}

function friendSheetContent(sheet, id) {
  const f = S.friends.get(id);
  const pending = f.status === 'pending-out';
  const code = h('p', { class: 'code' }, '…');
  safetyCode(S.me.pub, f.pub).then((c) => { code.textContent = c; });
  const recent = activityItems().filter((b) => b.peer === id).slice(0, 4);
  const nick = h('input', { class: 'input', id: 'nick', maxlength: 32, value: f.nick || '', placeholder: f.name, autocomplete: 'off' });

  return [
    sheetHead(nameOf(id), sheet, { plate: true }),
    h('p', { class: 'lede' }, friendStatus(f)),
    pending
      ? h('div', { class: 'row' },
        h('button', { class: 'btn quiet', onclick: async () => {
          const r = await resendRequest(f);
          toast(r.t === 'err' ? `Couldn’t resend (${r.e})` : 'Request sent again', { bad: r.t === 'err' });
        } }, 'Send the request again'))
      : h('div', { class: 'row' },
        h('button', { class: 'btn go', onclick: () => pickFiles(id) }, icon('out'), 'Send files'),
        CAN_PICK_FOLDER ? h('button', { class: 'btn quiet', onclick: () => pickFiles(id, true) }, icon('folder'), 'Send a folder') : null),
    pending ? null : h('p', { class: 'lede' }, matchMedia('(pointer: fine)').matches
      ? `Or drag files or whole folders onto this window and drop them on ${nameOf(id)}.`
      : 'Files go straight to their device. Keep Conduit open until the transfer finishes.'),

    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Safety code'),
      code,
      h('p', { class: 'lede' }, `Compare this with ${nameOf(id)} in person or on a call. If it matches, your connection can’t be intercepted.`),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: f.verified, onchange: async (e) => { f.verified = e.target.checked; await saveFriend(f); renderFriends(); } }),
        'We compared it and it matches')),

    pending ? null : h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: f.autoAccept, onchange: async (e) => { f.autoAccept = e.target.checked; await saveFriend(f); renderFriends(); } }),
      `Accept files from ${nameOf(id)} without asking`),

    h('form', { class: 'field', onsubmit: async (e) => {
      e.preventDefault();
      f.nick = cleanName(nick.value);
      await saveFriend(f);
      renderAll();
      refreshFriendSheet(id);
      toast('Name saved');
    } },
      h('label', { for: 'nick' }, 'What you call them (only you see this)'),
      h('div', { class: 'row' }, nick, h('button', { class: 'btn quiet small', type: 'submit' }, 'Save name'))),

    recent.length ? h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Recent transfers'),
      h('ul', { class: 'activity' }, recent.map((b) => {
        const row = buildRow(b);
        fillRow(row, b);
        return row.el;
      }))) : null,

    h('div', { class: 'row' },
      h('button', { class: 'btn danger', onclick: () => removeFriend(id) }, pending ? 'Cancel request' : 'Remove friend')),
  ];
}

// ───────────────────────────── add friend sheet ─────────────────────────────

function openAddFriend() {
  openSheet((sheet) => {
    let tab = 'invite';
    const body = h('div', { class: 'invite-box' });
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const tabBtn = (id, label) => h('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; draw(); } }, label);

    const inviteForm = () => {
      const label = h('input', { class: 'input', id: 'inv-label', maxlength: 32, placeholder: 'e.g. Brad', autocomplete: 'off' });
      const choice = (kind, checked) => h('label', { class: 'choice' },
        h('input', { type: 'radio', name: 'inv-kind', value: kind, checked }),
        h('span', {}, INVITE[kind].label),
        h('small', {}, INVITE[kind].note));
      return [
        h('div', { class: 'field' }, h('label', { for: 'inv-label' }, 'Who is it for? Only you see this.'), label),
        h('div', { class: 'field' }, choice('one', true), choice('group', false)),
        h('button', { class: 'btn go', onclick: async () => {
          const kind = body.querySelector('input[name="inv-kind"]:checked')?.value || 'one';
          const inv = await createInvite(kind, label.value);
          body.replaceChildren(...inviteResult(inv));
        } }, 'Create invite'),
      ];
    };

    const pasteForm = () => {
      const ta = h('textarea', { class: 'input', id: 'inv-paste', placeholder: 'https://…/#join=…', spellcheck: 'false' });
      return [
        h('div', { class: 'field' }, h('label', { for: 'inv-paste' }, 'Paste the invite link you were sent'), ta),
        h('button', { class: 'btn go', onclick: () => {
          const code = extractInviteCode(ta.value);
          if (!code) { toast('That doesn’t look like a Conduit invite link', { bad: true }); return; }
          sheet.close();
          openInvite(code);
        } }, 'Open invite'),
      ];
    };

    const draw = () => {
      tabs.replaceChildren(tabBtn('invite', 'Invite someone'), tabBtn('paste', 'I got an invite'));
      body.replaceChildren(...(tab === 'invite' ? inviteForm() : pasteForm()));
    };
    draw();
    return [sheetHead('Add a friend', sheet), tabs, body];
  }, { label: 'Add a friend' });
}

function inviteResult(inv) {
  const url = inviteLink(inv);
  return [
    h('div', { class: 'qr' }, qrSvg(url)),
    h('p', { class: 'lede' }, `Have them scan this with their phone camera, or send them the link. ${INVITE[inv.kind]?.note || ''} You approve each person who uses it.`),
    h('div', { class: 'linkbox', id: 'invite-link' }, url),
    h('div', { class: 'row' },
      h('button', { class: 'btn go', onclick: () => copyText(url, 'Invite link copied') }, icon('copy'), 'Copy link'),
      navigator.share ? h('button', { class: 'btn quiet', onclick: () => navigator.share({ title: 'Conduit invite', text: `${S.name} invited you to trade files on Conduit`, url }).catch(() => {}) }, icon('share'), 'Share') : null),
  ];
}

async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); } catch { toast('Copy didn’t work. Select the link and copy it by hand.', { bad: true }); }
}

// ───────────────────────────── inbox ─────────────────────────────

function renderInbox() {
  const view = $('view-inbox');
  if (!view) return;
  const usage = h('div', { class: 'storage' });
  navigator.storage?.estimate?.().then(({ usage: u = 0, quota: q = 0 }) => {
    if (!q) return;
    usage.replaceChildren(
      h('div', { class: 'meter' }, h('span', { vars: { '--p': `${Math.min(100, (u / q) * 100).toFixed(1)}%` } })),
      h('span', {}, `Conduit is using ${fmtBytes(u)} of ${fmtBytes(q)} this browser allows`));
  }).catch(() => {});

  const items = S.inbox;
  const list = h('ul', { class: 'inbox-list' }, inboxGroups().map((g) => (g.type === 'folder' ? folderRow(g) : inboxRow(g.rec))));
  view.replaceChildren(
    h('div', { class: 'section-head' },
      h('h2', {}, 'Inbox'),
      items.length && !S.jobs.size ? h('button', { class: 'btn quiet small', onclick: clearInbox }, 'Delete all') : null),
    h('p', { class: 'lede' }, S.settings.save === 'folder' && S.folder
      ? `New files save straight into your “${S.folder.name}” folder. Older files kept in Conduit are listed here.`
      : 'Files you receive are kept here on this device until you save or delete them.'),
    usage,
    items.length ? list : h('p', { class: 'empty' }, 'Nothing here yet. Files friends send you will land here.'));
}

function inboxRow(rec) {
  const isImg = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(rec.type);
  const isMedia = /^(image|video|audio)\//.test(rec.type);
  const ext = (rec.name.split('.').pop() || '').slice(0, 4).toUpperCase();
  const thumb = h('div', { class: 'thumb', 'aria-hidden': 'true' }, ext && ext.length <= 4 && rec.name.includes('.') ? ext : 'FILE');
  if (isImg && rec.kind === 'inbox' && rec.size < 25e6) {
    loadThumb(rec).then((url) => { if (url) thumb.replaceChildren(h('img', { src: url, alt: '' })); });
  }
  const actions = [];
  if (rec.kind === 'inbox' || (rec.kind === 'memory' && S.mem.has(rec.key))) {
    actions.push(h('button', { class: 'btn go small', onclick: () => saveItem(rec) }, icon('save'), 'Save'));
    if (navigator.canShare) actions.push(h('button', { class: 'btn quiet small', onclick: () => shareItem(rec) }, icon('share'), 'Share'));
    if (isMedia) actions.push(h('button', { class: 'btn quiet small', onclick: () => previewItem(rec) }, icon('eye'), 'Preview'));
  }
  actions.push(h('button', { class: 'btn quiet small', onclick: () => deleteItem(rec) }, icon('trash'), rec.kind === 'folder' || rec.kind === 'gone' ? 'Remove' : 'Delete'));

  const where = rec.kind === 'folder' ? `Saved to your folder as ${rec.savedAs}`
    : rec.kind === 'gone' ? 'This was only held in memory and is gone now'
      : rec.kind === 'memory' ? 'Held in memory. Save it before closing Conduit.' : null;
  return h('li', { class: 'item' },
    thumb,
    h('span', { class: 'item-name' }, rec.path ? `${rec.path}/${rec.name}` : rec.name),
    h('span', { class: 'item-meta' }, h('span', {}, fmtBytes(rec.size)), h('span', {}, `from ${rec.fromName || nameOf(rec.from)}`), h('span', {}, fmtAgo(rec.at))),
    where ? h('span', { class: 'item-meta' }, where) : null,
    h('div', { class: 'item-actions' }, actions));
}

// A received folder shows up as one item instead of a pile of loose files.
function inboxGroups() {
  const out = [];
  const folders = new Map();
  for (const rec of S.inbox) {
    const root = rec.path ? rec.path.split('/')[0] : '';
    if (!root) { out.push({ type: 'file', rec }); continue; }
    const key = `${rec.tid}|${root}`;
    let g = folders.get(key);
    if (!g) {
      g = { type: 'folder', key, tid: rec.tid, root, items: [], size: 0, from: rec.from, fromName: rec.fromName, at: rec.at };
      folders.set(key, g);
      out.push(g);
    }
    g.items.push(rec);
    g.size += rec.size;
    if (rec.at > g.at) g.at = rec.at;
  }
  return out;
}

const insideFolder = (r) => [...r.path.split('/').slice(1), r.name].join('/');
const isSaveable = (r) => r.kind === 'inbox' || (r.kind === 'memory' && S.mem.has(r.key));

function folderRow(g) {
  const ready = g.items.filter((r) => r.kind === 'inbox');
  const inFolder = g.items.every((r) => r.kind === 'folder');
  const job = S.jobs.get(g.key);
  const open = S.expanded.has(g.key);
  const actions = [];
  if (ready.length && !job) {
    if (CAN_SAVE_FOLDER) actions.push(h('button', { class: 'btn go small', onclick: () => saveFolder(g) }, icon('folder'), 'Save folder'));
    actions.push(h('button', { class: CAN_SAVE_FOLDER ? 'btn quiet small' : 'btn go small', onclick: () => downloadZip(g) }, icon('save'), 'Download .zip'));
  }
  actions.push(h('button', { class: 'btn quiet small', 'aria-expanded': String(open), onclick: () => {
    if (open) S.expanded.delete(g.key); else S.expanded.add(g.key);
    renderInbox();
  } }, open ? 'Hide files' : 'Show files'));
  if (!job) actions.push(h('button', { class: 'btn quiet small', onclick: () => deleteGroup(g) }, icon('trash'), inFolder ? 'Remove' : 'Delete'));

  const shown = open ? g.items.slice(0, 300) : [];
  return h('li', { class: 'item' },
    h('div', { class: 'thumb folder', 'aria-hidden': 'true' }, icon('folder')),
    h('span', { class: 'item-name' }, g.root),
    h('span', { class: 'item-meta' },
      h('span', {}, `Folder, ${plural(g.items.length, 'file')}`), h('span', {}, fmtBytes(g.size)),
      h('span', {}, `from ${g.fromName || nameOf(g.from)}`), h('span', {}, fmtAgo(g.at))),
    job ? h('span', { class: 'item-meta job', role: 'status' }, job)
      : inFolder ? h('span', { class: 'item-meta' }, `Saved straight into your folder as ${g.items[0].savedAs.split('/')[0]}`) : null,
    h('div', { class: 'item-actions' }, actions),
    open ? h('ul', { class: 'subfiles' },
      shown.map((r) => h('li', {},
        h('span', { class: 'subfile-name' }, insideFolder(r)),
        h('span', { class: 'subfile-size' }, fmtBytes(r.size)),
        isSaveable(r) ? h('button', { class: 'btn quiet small', onclick: () => saveItem(r), 'aria-label': `Save ${r.name}` }, icon('save')) : h('span'))),
      g.items.length > shown.length ? h('li', { class: 'subfile-more' }, `and ${g.items.length - shown.length} more`) : null) : null);
}

function setJob(key, text) { S.jobs.set(key, text); renderInboxSoon(); }
function clearJob(key) { S.jobs.delete(key); renderInbox(); }

async function saveFolder(g) {
  let dest;
  try {
    dest = await window.showDirectoryPicker({ id: 'conduit-save', mode: 'readwrite', startIn: 'downloads' });
  } catch (e) {
    if (e.name !== 'AbortError') toast(`Couldn’t open that folder: ${e.message}`, { bad: true });
    return;
  }
  const items = g.items.filter((r) => r.kind === 'inbox');
  const total = items.reduce((s, r) => s + r.size, 0);
  let done = 0;
  setJob(g.key, 'Saving… 0%');
  try {
    const name = await freeDirName(dest, g.root);
    const top = await dest.getDirectoryHandle(name, { create: true });
    for (const r of items) {
      let dir = top;
      for (const part of r.path.split('/').slice(1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const src = await inboxFile(r.opfs);
      const out = await (await dir.getFileHandle(r.name, { create: true })).createWritable();
      await src.stream().pipeThrough(new TransformStream({
        transform(chunk, ctl) { done += chunk.byteLength; setJob(g.key, `Saving… ${pct(done, total)}%`); ctl.enqueue(chunk); },
      })).pipeTo(out);
    }
    toast(`Saved “${name}” into ${dest.name}`);
  } catch (e) {
    toast(`Couldn’t save the folder: ${e.message}`, { bad: true });
  } finally {
    clearJob(g.key);
  }
}

async function freeDirName(dir, name) {
  for (let n = 0; n < 500; n++) {
    const candidate = n ? `${name} (${n})` : name;
    try {
      await dir.getDirectoryHandle(candidate);
    } catch (e) {
      if (e.name === 'NotFoundError') return candidate;
      if (e.name !== 'TypeMismatchError') throw e;
    }
  }
  return `${name} (${Date.now()})`;
}

async function downloadZip(g) {
  const items = g.items.filter((r) => r.kind === 'inbox');
  if (!items.length) return;
  const total = items.reduce((s, r) => s + r.size, 0);
  try {
    let file = null;
    const cached = S.zips.get(g.key);
    if (cached?.count === items.length) file = await inboxFile(cached.name).catch(() => null);
    if (!file) {
      setJob(g.key, 'Making the .zip… 0%');
      const name = `zip-${randomId(8)}`;
      file = await zipInbox(name, items.map((r) => ({ src: r.opfs, path: insideFolder(r), size: r.size })),
        (n) => setJob(g.key, `Making the .zip… ${pct(n, total)}%`));
      if (cached) inboxRemove(cached.name);
      S.zips.set(g.key, { name, count: items.length });
    }
    downloadBlob(file, `${g.root}.zip`);
  } catch (e) {
    toast(e.name === 'QuotaExceededError' ? 'Not enough free space on this device to build the .zip' : `Couldn’t make the .zip: ${e.message}`, { bad: true });
  } finally {
    clearJob(g.key);
  }
}

async function deleteGroup(g) {
  if (g.items.some((r) => r.kind === 'inbox')) {
    const ok = await confirmSheet({
      title: `Delete the ${g.root} folder?`,
      body: `Its ${plural(g.items.length, 'file')} will be removed from this device. Copies you already saved stay where they are.`,
      yes: 'Delete folder', danger: true,
    });
    if (!ok) return;
  }
  for (const r of g.items) await deleteItem(r, false);
  const z = S.zips.get(g.key);
  if (z) { inboxRemove(z.name); S.zips.delete(g.key); }
  S.expanded.delete(g.key);
  renderInbox();
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60e3);
}

async function loadThumb(rec) {
  if (S.thumbs.has(rec.key)) return S.thumbs.get(rec.key);
  try {
    const file = await inboxFile(rec.opfs);
    const url = URL.createObjectURL(new File([file], rec.name, { type: rec.type }));
    S.thumbs.set(rec.key, url);
    return url;
  } catch { return null; }
}

async function itemFile(rec) {
  if (rec.kind === 'memory') {
    const blob = S.mem.get(rec.key);
    return blob ? new File([blob], rec.name, { type: rec.type }) : null;
  }
  if (rec.kind === 'inbox') {
    const raw = await inboxFile(rec.opfs);
    return new File([raw], rec.name, { type: rec.type || 'application/octet-stream' });
  }
  return null;
}

async function saveItem(rec) {
  try {
    const file = await itemFile(rec);
    if (!file) throw new Error('file is no longer available');
    downloadBlob(file, rec.name);
  } catch (e) {
    toast(`Couldn’t save: ${e.message}`, { bad: true });
  }
}

async function shareItem(rec) {
  try {
    const file = await itemFile(rec);
    if (!file || !navigator.canShare({ files: [file] })) throw new Error('this browser can’t share this file');
    await navigator.share({ files: [file], title: rec.name });
  } catch (e) {
    if (e.name !== 'AbortError') toast(`Couldn’t share: ${e.message}`, { bad: true });
  }
}

async function previewItem(rec) {
  const file = await itemFile(rec).catch(() => null);
  if (!file) { toast('That file is no longer available', { bad: true }); return; }
  const url = URL.createObjectURL(file);
  const kind = rec.type.split('/')[0];
  const media = kind === 'image' ? h('img', { class: 'preview', src: url, alt: rec.name })
    : kind === 'video' ? h('video', { class: 'preview', src: url, controls: true, playsinline: true })
      : h('audio', { src: url, controls: true });
  openSheet((sheet) => [sheetHead(rec.name, sheet), media,
    h('div', { class: 'row' }, h('button', { class: 'btn go', onclick: () => saveItem(rec) }, icon('save'), 'Save'))],
  { label: rec.name, onClose: () => URL.revokeObjectURL(url) });
}

async function deleteItem(rec, render = true) {
  if (rec.kind === 'inbox') await inboxRemove(rec.opfs);
  S.mem.delete(rec.key);
  const url = S.thumbs.get(rec.key);
  if (url) { URL.revokeObjectURL(url); S.thumbs.delete(rec.key); }
  S.inbox = S.inbox.filter((r) => r.key !== rec.key);
  await db.del('inbox', rec.key);
  if (render) renderInbox();
}

async function clearInbox() {
  const ok = await confirmSheet({ title: 'Delete every received file?', body: 'Files kept in Conduit’s inbox on this device will be deleted. Files already saved to a folder are not touched.', yes: 'Delete all', danger: true });
  if (!ok) return;
  for (const rec of [...S.inbox]) await deleteItem(rec, false);
  for (const z of S.zips.values()) inboxRemove(z.name);
  S.zips.clear();
  renderInbox();
}

// ───────────────────────────── you / settings ─────────────────────────────

function renderYou() {
  const view = $('view-you');
  if (!view || !S.me) return;
  const nameInput = h('input', { class: 'input', id: 'my-name', maxlength: 32, value: S.name, autocomplete: 'nickname' });
  const canFolder = 'showDirectoryPicker' in window;
  const invites = [...S.invites.values()].filter(inviteLive).sort((a, b) => b.created - a.created);

  const saveChoice = (value, title, note, disabled = false) => h('label', { class: disabled ? 'choice disabled' : 'choice' },
    h('input', { type: 'radio', name: 'save-mode', value, checked: S.settings.save === value, disabled, onchange: async () => {
      if (value === 'folder' && !S.folder) { await pickFolder(); return; }
      S.settings.save = value;
      await saveSettings();
      renderYou();
      renderInbox();
    } }),
    h('span', {}, title),
    h('small', {}, note));

  view.replaceChildren(
    h('section', { class: 'panel' },
      h('h2', {}, 'Your name'),
      h('form', { class: 'row', onsubmit: async (e) => {
        e.preventDefault();
        const name = cleanName(nameInput.value);
        if (!name || name === S.name) return;
        S.name = name;
        await db.put('kv', { name }, 'profile');
        $('me-name').textContent = name;
        for (const f of S.friends.values()) if (f.status === 'friend') signal.send(f.id, 'profile', { n: name }, { queue: true });
        toast('Name updated for your friends');
      } }, nameInput, h('button', { class: 'btn quiet', type: 'submit' }, 'Save'))),

    h('section', { class: 'panel' },
      h('h2', {}, 'Receiving files'),
      saveChoice('inbox', 'Keep them in Conduit’s inbox', 'Works in every browser. Save or share each file from the Inbox.'),
      saveChoice('folder', S.folder ? `Save straight into “${S.folder.name}”` : 'Save straight into a folder on this computer',
        canFolder ? 'Best for big files. Works in Chrome and Edge on a computer.' : 'Not available in this browser.', !canFolder),
      S.folder && canFolder ? h('div', { class: 'row' },
        h('button', { class: 'btn quiet small', onclick: pickFolder }, icon('folder'), 'Choose a different folder'),
        S.folderPerm !== 'granted' ? h('button', { class: 'btn quiet small', onclick: async () => {
          S.folderPerm = await S.folder.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
          renderYou();
        } }, 'Allow access to this folder') : null) : null),

    h('section', { class: 'panel' },
      h('h2', {}, 'Notifications'),
      h('p', { class: 'lede' }, 'Get a notification when a friend wants to send you something while Conduit is in the background.'),
      typeof Notification === 'undefined'
        ? h('p', { class: 'lede' }, 'This browser doesn’t support notifications here. On iPhone, add Conduit to your Home Screen first.')
        : h('div', { class: 'row' }, h('button', { class: 'btn quiet', onclick: toggleNotify }, S.settings.notify && Notification.permission === 'granted' ? 'Turn off notifications' : 'Turn on notifications'))),

    h('section', { class: 'panel' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Invites'), h('button', { class: 'btn quiet small', onclick: openAddFriend }, icon('plus'), 'New invite')),
      invites.length
        ? h('ul', { class: 'invite-list' }, invites.map((inv) => h('li', { class: 'invite' },
          h('span', { class: 'item-name' }, inv.label ? `For ${inv.label}` : 'Invite'),
          h('span', { class: 'item-meta' },
            h('span', {}, `Used ${inv.uses} of ${inv.max}`),
            h('span', {}, `Expires in ${fmtDuration((inv.exp - Date.now()) / 1000)}`)),
          h('div', { class: 'row' },
            h('button', { class: 'btn quiet small', onclick: () => copyText(inviteLink(inv), 'Invite link copied') }, icon('copy'), 'Copy'),
            h('button', { class: 'btn quiet small', onclick: () => revokeInvite(inv.token) }, 'Revoke')))))
        : h('p', { class: 'lede' }, 'No active invites. Old invites stop working on their own.')),

    h('section', { class: 'panel' },
      h('h2', {}, 'This device'),
      h('p', { class: 'devid' }, `Conduit ${VERSION}. Device ID ${S.me.id}`),
      h('details', { class: 'explain' },
        h('summary', {}, 'How Conduit keeps your files private'),
        h('ul', {},
          h('li', {}, 'Files travel straight from your device to your friend’s over an encrypted WebRTC connection. They’re never uploaded to a server.'),
          h('li', {}, 'The server only passes short connection messages between friends. Every one is signed by the sender’s device, so the server can’t fake or change them.'),
          h('li', {}, 'Only friends you approved can reach you. Invites expire, and you approve each person who uses one.'),
          h('li', {}, 'If two networks can’t connect directly, data can go through a relay. It stays end-to-end encrypted, so the relay can’t read it.'),
          h('li', {}, 'Your identity is a key that lives only in this browser and can’t be copied out. Clearing this site’s data creates a new identity, and friends would need to add you again.'))),
      h('div', { class: 'row' }, h('button', { class: 'btn quiet', onclick: toggleLog }, icon('log'), 'Show event log'))),

    h('section', { class: 'panel' },
      h('h2', {}, 'Start over'),
      h('p', { class: 'lede' }, 'Erases your identity, friends, invites and received files from this browser.'),
      h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: resetAll }, 'Reset Conduit on this device'))),
  );
}

async function saveSettings() { await db.put('kv', S.settings, 'settings'); }

async function pickFolder() {
  try {
    const handle = await window.showDirectoryPicker({ id: 'conduit-receive', mode: 'readwrite', startIn: 'downloads' });
    S.folder = handle;
    S.folderPerm = 'granted';
    await db.put('kv', handle, 'folder');
    S.settings.save = 'folder';
    await saveSettings();
    toast(`New files will save into “${handle.name}”`);
  } catch (e) {
    if (e.name !== 'AbortError') toast(`Couldn’t use that folder: ${e.message}`, { bad: true });
  }
  renderYou();
  renderInbox();
}

async function toggleNotify() {
  if (S.settings.notify && Notification.permission === 'granted') {
    S.settings.notify = false;
  } else {
    const perm = await Notification.requestPermission();
    S.settings.notify = perm === 'granted';
    if (perm !== 'granted') toast('Notifications are blocked for this site in your browser settings', { bad: true });
  }
  await saveSettings();
  renderYou();
}

async function notify(title, body) {
  if (!S.settings.notify || !document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, tag: title, icon: '/icons/icon-192.png' });
    else new Notification(title, { body });
  } catch { /* ignore */ }
}

async function resetAll() {
  const ok = await confirmSheet({
    title: 'Reset Conduit on this device?',
    body: 'Your friends will see you as a stranger, and every received file still in the inbox will be deleted. This can’t be undone.',
    yes: 'Erase everything', danger: true,
  });
  if (!ok) return;
  for (const f of S.friends.values()) if (f.status === 'friend') signal.send(f.id, 'friend-remove', {}, { queue: true });
  await new Promise((r) => setTimeout(r, 600));
  for (const rec of S.inbox) if (rec.opfs) await inboxRemove(rec.opfs);
  await wipeEverything();
  location.reload();
}

// ───────────────────────────── chrome: views, log, drag & drop ─────────────────────────────

function showView(view) {
  S.view = view;
  for (const v of ['home', 'inbox', 'you']) $(`view-${v}`).hidden = v !== view;
  for (const b of document.querySelectorAll('.nav-item')) {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (view === 'inbox') { S.unseen = 0; renderBadge(); renderInbox(); }
  if (view === 'you') renderYou();
  window.scrollTo({ top: 0 });
}

function toggleLog(force) {
  const el = $('log');
  const open = typeof force === 'boolean' ? force : el.hidden;
  el.hidden = !open;
  $('log-toggle').setAttribute('aria-pressed', String(open));
  if (open) {
    $('log-lines').replaceChildren();
    for (const line of S.log) appendLogLine(line);
  }
}

function appendLogLine(line) {
  const box = $('log-lines');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.append(h('div', {}, h('time', {}, line.t.toLocaleTimeString([], { hour12: false })), line.msg));
  while (box.childElementCount > 600) box.firstChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

let dragDepth = 0;
const dragHasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

function showDrop() {
  const friends = sendableFriends();
  $('drop-targets').replaceChildren(...(friends.length
    ? friends.map((f) => h('div', { class: engineHost.isOnline(f.id) ? 'plate drop-target' : 'plate drop-target offline', dataset: { drop: f.id } }, h('span', { class: 'plate-text' }, nameOf(f.id))))
    : [h('p', { class: 'lede' }, 'Add a friend first, then drop files on them here.')]));
  $('drop').hidden = false;
}

function hideDrop() {
  dragDepth = 0;
  $('drop').hidden = true;
}

function wireStatic() {
  for (const b of document.querySelectorAll('.nav-item')) b.addEventListener('click', () => showView(b.dataset.view));
  $('me-plate').addEventListener('click', () => showView('you'));
  $('add-friend').addEventListener('click', openAddFriend);
  $('clear-finished').addEventListener('click', clearFinished);
  $('log-toggle').addEventListener('click', () => toggleLog());
  $('log-close').addEventListener('click', () => toggleLog(false));
  $('file-input').addEventListener('change', onPicked);
  $('folder-input').addEventListener('change', onPicked);

  addEventListener('keydown', (e) => {
    if (e.key === '`' && !e.target.closest?.('input, textarea')) { e.preventDefault(); toggleLog(); }
  });

  addEventListener('dragenter', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (dragDepth++ === 0) showDrop();
  });
  addEventListener('dragover', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const over = e.target.closest?.('[data-drop]');
    for (const t of document.querySelectorAll('.drop-target')) t.classList.toggle('over', t === over);
  });
  addEventListener('dragleave', (e) => {
    if (!dragHasFiles(e)) return;
    if (--dragDepth <= 0) hideDrop();
  });
  addEventListener('drop', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    const target = e.target.closest?.('[data-drop]');
    const captured = captureDrop(e.dataTransfer);
    hideDrop();
    if (!target) return;
    expandDrop(captured).then((items) => reviewSend(target.dataset.drop, items, null)).catch((err) => toast(`Couldn’t read those files: ${err.message}`, { bad: true }));
  });

  addEventListener('beforeunload', (e) => {
    if (transfers?.anyMoving()) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', syncWakeLock);
}

let wakeLock = null;
let wakeBusy = false;
async function syncWakeLock() {
  if (wakeBusy || !('wakeLock' in navigator)) return;
  const need = transfers.anyMoving() && document.visibilityState === 'visible';
  wakeBusy = true;
  try {
    if (need && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!need && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed right now */ }
  wakeBusy = false;
}

function closeIdleLinks() {
  for (const [id, l] of S.links) {
    if (l.isOpen && !transfers.activeWith(id) && Date.now() - l.lastUsed > 90e3) l.close('idle');
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((e) => log(`offline support unavailable: ${e.message}`));
}

// Handy when troubleshooting from the browser console.
Object.defineProperty(window, 'conduit', { get: () => ({ state: S, transfers, signal, links: S.links }) });
