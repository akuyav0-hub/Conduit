// Streams a .zip archive to disk without holding it in memory.
// Files are stored as-is (photos, video and audio are already compressed, so this is the fast
// choice), and ZIP64 kicks in automatically for files or archives over 4 GB.
// Works in any environment: you supply how to read each entry and how to write at a position.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(prev, u8) {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const LIMIT32 = 0xffffffff;
const CHUNK = 4 * 1024 * 1024;
const enc = new TextEncoder();

function u64(view, at, n) {
  view.setUint32(at, n % 2 ** 32, true);
  view.setUint32(at + 4, Math.floor(n / 2 ** 32), true);
}

function zip64Extra(values) {
  const v = new DataView(new ArrayBuffer(4 + 8 * values.length));
  v.setUint16(0, 0x0001, true);
  v.setUint16(2, 8 * values.length, true);
  values.forEach((n, i) => u64(v, 4 + 8 * i, n));
  return new Uint8Array(v.buffer);
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// entries: [{ path: 'day 1/beach.jpg', size }]
// read(entry, offset, length) -> Promise<Uint8Array>
// writeAt(bytes, position) -> Promise
export async function writeZip(entries, { read, writeAt, onProgress, forceZip64 = false, date = new Date() }) {
  const { time, date: day } = dosTime(date);
  let pos = 0;
  let done = 0;
  let reported = 0;
  const put = async (bytes) => { await writeAt(bytes, pos); pos += bytes.length; };
  const central = [];

  for (const e of entries) {
    const name = enc.encode(e.path);
    const offset = pos;
    const big = forceZip64 || e.size >= LIMIT32;
    const extra = big ? zip64Extra([e.size, e.size]) : new Uint8Array(0);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, big ? 45 : 20, true);
    h.setUint16(6, 0x0800, true); // names are UTF-8
    h.setUint16(8, 0, true); // stored
    h.setUint16(10, time, true);
    h.setUint16(12, day, true);
    h.setUint32(14, 0, true); // CRC, filled in once the data has been read
    h.setUint32(18, big ? LIMIT32 : e.size, true);
    h.setUint32(22, big ? LIMIT32 : e.size, true);
    h.setUint16(26, name.length, true);
    h.setUint16(28, extra.length, true);
    await put(new Uint8Array(h.buffer));
    await put(name);
    await put(extra);

    let crc = 0;
    for (let off = 0; off < e.size; off += CHUNK) {
      const bytes = await read(e, off, Math.min(CHUNK, e.size - off));
      if (!bytes.length) throw new Error(`couldn't read ${e.path}`);
      crc = crc32(crc, bytes);
      await put(bytes);
      done += bytes.length;
      if (onProgress && done - reported >= 8 * 1024 * 1024) { reported = done; onProgress(done); }
    }
    const c = new DataView(new ArrayBuffer(4));
    c.setUint32(0, crc, true);
    await writeAt(new Uint8Array(c.buffer), offset + 14);
    central.push({ name, crc, size: e.size, offset });
  }

  const cdStart = pos;
  for (const c of central) {
    const bigSize = forceZip64 || c.size >= LIMIT32;
    const bigOffset = forceZip64 || c.offset >= LIMIT32;
    const fields = [];
    if (bigSize) fields.push(c.size, c.size);
    if (bigOffset) fields.push(c.offset);
    const extra = fields.length ? zip64Extra(fields) : new Uint8Array(0);
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true);
    h.setUint16(4, 45, true); // made by: MS-DOS, spec 4.5
    h.setUint16(6, fields.length ? 45 : 20, true);
    h.setUint16(8, 0x0800, true);
    h.setUint16(10, 0, true);
    h.setUint16(12, time, true);
    h.setUint16(14, day, true);
    h.setUint32(16, c.crc, true);
    h.setUint32(20, bigSize ? LIMIT32 : c.size, true);
    h.setUint32(24, bigSize ? LIMIT32 : c.size, true);
    h.setUint16(28, c.name.length, true);
    h.setUint16(30, extra.length, true);
    h.setUint16(32, 0, true);
    h.setUint16(34, 0, true);
    h.setUint16(36, 0, true);
    h.setUint32(38, 0, true);
    h.setUint32(42, bigOffset ? LIMIT32 : c.offset, true);
    await put(new Uint8Array(h.buffer));
    await put(c.name);
    await put(extra);
  }
  const cdSize = pos - cdStart;
  const count = central.length;
  const zip64End = forceZip64 || count >= 0xffff || cdSize >= LIMIT32 || cdStart >= LIMIT32;
  if (zip64End) {
    const recordAt = pos;
    const z = new DataView(new ArrayBuffer(56));
    z.setUint32(0, 0x06064b50, true);
    u64(z, 4, 44);
    z.setUint16(12, 45, true);
    z.setUint16(14, 45, true);
    z.setUint32(16, 0, true);
    z.setUint32(20, 0, true);
    u64(z, 24, count);
    u64(z, 32, count);
    u64(z, 40, cdSize);
    u64(z, 48, cdStart);
    await put(new Uint8Array(z.buffer));
    const l = new DataView(new ArrayBuffer(20));
    l.setUint32(0, 0x07064b50, true);
    l.setUint32(4, 0, true);
    u64(l, 8, recordAt);
    l.setUint32(16, 1, true);
    await put(new Uint8Array(l.buffer));
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, zip64End ? 0xffff : count, true);
  end.setUint16(10, zip64End ? 0xffff : count, true);
  end.setUint32(12, zip64End ? LIMIT32 : cdSize, true);
  end.setUint32(16, zip64End ? LIMIT32 : cdStart, true);
  end.setUint16(20, 0, true);
  await put(new Uint8Array(end.buffer));
  onProgress?.(done);
  return pos;
}
