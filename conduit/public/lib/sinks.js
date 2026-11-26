// Where incoming bytes go. Every sink writes straight to disk as data arrives, so file size is
// limited by free disk space, not by memory:
//   folder  — directly into a folder you picked (Chrome / Edge on desktop)
//   inbox   — the browser's private disk storage (every modern browser); save out from the Inbox
//   memory  — last resort for browsers without disk storage (e.g. some private-browsing modes)

let worker = null;
let seq = 0;
const calls = new Map();

function call(msg, transfer = [], onProgress = null) {
  if (!worker) {
    worker = new Worker('/opfs-worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      const c = calls.get(data.id);
      if (!c) return;
      if (data.progress !== undefined) { c.onProgress?.(data.progress); return; }
      calls.delete(data.id);
      if (data.ok) c.resolve(data);
      else c.reject(Object.assign(new Error(data.error), { name: data.name }));
    };
    worker.onerror = (e) => {
      for (const c of calls.values()) c.reject(new Error(e.message || 'storage worker crashed'));
      calls.clear();
      worker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    calls.set(id, { resolve, reject, onProgress });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

async function inboxDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('inbox', { create: true });
}

let opfsOk;
export async function inboxUsable() {
  if (opfsOk !== undefined) return opfsOk;
  try {
    await inboxDir();
    opfsOk = typeof Worker !== 'undefined';
  } catch {
    opfsOk = false;
  }
  return opfsOk;
}

export async function inboxFile(name) {
  return (await (await inboxDir()).getFileHandle(name)).getFile();
}

export async function inboxRemove(name) {
  try { await (await inboxDir()).removeEntry(name); } catch { await call({ op: 'remove', name }).catch(() => {}); }
}

// Builds a .zip of inbox files on disk and returns it as a File ready to download.
// entries: [{ src: inbox file name, path: path inside the zip, size }]
export async function zipInbox(out, entries, onProgress, { forceZip64 = false } = {}) {
  await call({ op: 'zip', out, entries, forceZip64 }, [], onProgress);
  return inboxFile(out);
}

export async function inboxNames() {
  const out = [];
  try {
    for await (const name of (await inboxDir()).keys()) out.push(name);
  } catch { /* iteration unsupported */ }
  return out;
}

class OpfsSink {
  static async open(name) {
    await call({ op: 'open', name });
    return new OpfsSink(name);
  }
  constructor(name) { this.name = name; this.pos = 0; }
  async write(buf, len) {
    await call({ op: 'write', name: this.name, buf: buf.buffer, len, at: this.pos }, [buf.buffer]);
    this.pos += len;
  }
  async close() {
    await call({ op: 'close', name: this.name });
    return { kind: 'inbox', opfs: this.name };
  }
  async abort() { await call({ op: 'abort', name: this.name }).catch(() => {}); }
}

class FolderSink {
  static async open(root, file) {
    let dir = root;
    for (const part of file.path ? file.path.split('/') : []) dir = await dir.getDirectoryHandle(part, { create: true });
    const name = await uniqueName(dir, file.name);
    const fh = await dir.getFileHandle(name, { create: true });
    const stream = await fh.createWritable({ keepExistingData: false });
    return new FolderSink(dir, name, stream, file.path);
  }
  constructor(dir, name, stream, path) { this.dir = dir; this.name = name; this.stream = stream; this.path = path; }
  async write(buf, len) { await this.stream.write(buf.subarray(0, len)); }
  async close() {
    await this.stream.close();
    return { kind: 'folder', savedAs: this.path ? `${this.path}/${this.name}` : this.name };
  }
  async abort() {
    try { await this.stream.abort(); } catch { /* ignore */ }
    try { await this.dir.removeEntry(this.name); } catch { /* ignore */ }
  }
}

class MemorySink {
  constructor(file) { this.parts = []; this.type = file.type; }
  async write(buf, len) { this.parts.push(len === buf.length ? buf : buf.slice(0, len)); }
  async close() {
    const blob = new Blob(this.parts, { type: this.type || 'application/octet-stream' });
    this.parts = null;
    return { kind: 'memory', blob };
  }
  async abort() { this.parts = null; }
}

async function uniqueName(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 0; n < 500; n++) {
    const candidate = n ? `${base} (${n})${ext}` : name;
    try {
      await dir.getFileHandle(candidate);
    } catch (e) {
      if (e.name === 'NotFoundError') return candidate;
      throw e;
    }
  }
  return `${base} (${Date.now()})${ext}`;
}

export async function openSink(batch, file, host) {
  if (batch.mode === 'folder' && host.folder) {
    try { return await FolderSink.open(host.folder, file); } catch (e) {
      host.log(`couldn't write to your folder (${e.message}) — using the inbox instead`);
      batch.mode = 'inbox';
    }
  }
  if (batch.mode !== 'memory' && (await inboxUsable())) {
    try { return await OpfsSink.open(`${batch.tid}-${file.i}`); } catch (e) {
      host.log(`inbox storage unavailable (${e.message}) — holding the file in memory`);
      batch.mode = 'memory';
    }
  }
  return new MemorySink(file);
}
