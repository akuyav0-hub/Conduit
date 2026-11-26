// Disk work for the inbox, off the main thread so the interface stays smooth:
// writes incoming files to the browser's private on-disk storage (OPFS), and builds .zip
// downloads of received folders.

import { writeZip } from './lib/zip.js';

const open = new Map();
let dirPromise;
const inbox = () => (dirPromise ??= navigator.storage.getDirectory().then((root) => root.getDirectoryHandle('inbox', { create: true })));

// A writer that can write at any position: a sync access handle where available, a stream otherwise.
async function openWriter(name) {
  const fh = await (await inbox()).getFileHandle(name, { create: true });
  if (typeof fh.createSyncAccessHandle === 'function') {
    const h = await fh.createSyncAccessHandle();
    await h.truncate(0);
    return {
      async writeAt(bytes, at) {
        let done = 0;
        while (done < bytes.length) {
          const n = await h.write(bytes.subarray(done), { at: at + done });
          if (!n) throw new DOMException('The disk is full or the write was refused', 'QuotaExceededError');
          done += n;
        }
      },
      async close() { await h.flush(); await h.close(); },
      async abort() { try { await h.close(); } catch { /* ignore */ } },
    };
  }
  const ws = await fh.createWritable({ keepExistingData: false });
  return {
    writeAt: (bytes, at) => ws.write({ type: 'write', position: at, data: bytes }),
    close: () => ws.close(),
    async abort() { try { await ws.abort(); } catch { /* ignore */ } },
  };
}

async function remove(name) {
  try { await (await inbox()).removeEntry(name); } catch { /* already gone */ }
}

self.onmessage = async ({ data: m }) => {
  try {
    if (m.op === 'open') {
      open.set(m.name, await openWriter(m.name));
    } else if (m.op === 'write') {
      const w = open.get(m.name);
      if (!w) throw new Error('file is not open');
      await w.writeAt(new Uint8Array(m.buf, 0, m.len), m.at);
    } else if (m.op === 'close') {
      const w = open.get(m.name);
      open.delete(m.name);
      await w?.close();
    } else if (m.op === 'abort' || m.op === 'remove') {
      const w = open.get(m.name);
      open.delete(m.name);
      await w?.abort();
      await remove(m.name);
    } else if (m.op === 'zip') {
      const dir = await inbox();
      const out = await openWriter(m.out);
      const sources = new Map();
      try {
        await writeZip(m.entries, {
          forceZip64: !!m.forceZip64,
          async read(e, off, len) {
            let file = sources.get(e.src);
            if (!file) {
              file = await (await dir.getFileHandle(e.src)).getFile();
              if (file.size !== e.size) throw new Error(`${e.path} changed on disk`);
              sources.clear();
              sources.set(e.src, file);
            }
            return new Uint8Array(await file.slice(off, off + len).arrayBuffer());
          },
          writeAt: (bytes, at) => out.writeAt(bytes, at),
          onProgress: (done) => self.postMessage({ id: m.id, progress: done }),
        });
        await out.close();
      } catch (e) {
        await out.abort();
        await remove(m.out);
        throw e;
      }
    }
    self.postMessage({ id: m.id, ok: true });
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: e?.message || String(e), name: e?.name || 'Error' });
  }
};
