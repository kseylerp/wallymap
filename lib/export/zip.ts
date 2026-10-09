/** A tiny zip writer: every file is stored without compression, which is all a handful of GeoJSON files needs. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Uint8Array };

/** The bytes of a .zip holding `entries` (names are UTF-8; no folders, comments or compression). */
export function zipStored(entries: ZipEntry[], modified = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const dosTime = (modified.getHours() << 11) | (modified.getMinutes() << 5) | (modified.getSeconds() >> 1);
  const dosDate = (Math.max(0, modified.getFullYear() - 1980) << 9) | ((modified.getMonth() + 1) << 5) | modified.getDate();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    // Local header (30 bytes), then the name and the stored data.
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // UTF-8 names
    head.setUint16(10, dosTime, true);
    head.setUint16(12, dosDate, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, nameBytes.length, true);
    local.push(new Uint8Array(head.buffer), nameBytes, data);
    // Central directory record (46 bytes) pointing back at that header.
    const rec = new DataView(new ArrayBuffer(46));
    rec.setUint32(0, 0x02014b50, true);
    rec.setUint16(4, 20, true);
    rec.setUint16(6, 20, true);
    rec.setUint16(8, 0x0800, true);
    rec.setUint16(12, dosTime, true);
    rec.setUint16(14, dosDate, true);
    rec.setUint32(16, crc, true);
    rec.setUint32(20, data.length, true);
    rec.setUint32(24, data.length, true);
    rec.setUint16(28, nameBytes.length, true);
    rec.setUint32(42, offset, true);
    central.push(new Uint8Array(rec.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
