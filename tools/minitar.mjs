// Read one member out of a gzipped tar archive held in memory, without
// unpacking the rest. Chart archives are plain ustar plus, for long template
// paths, the GNU long-name ('L') and pax extended-header ('x', 'X', 'A')
// blocks that tar writes in front of the entry.

import { gunzipSync } from 'node:zlib';

/**
 * @param {Buffer} gz a .tgz archive
 * @param {(name: string, type: string) => boolean} want
 * @returns {{name: string, data: Buffer, mtime: number, type: string} | null}
 */
export function findMember(gz, want) {
  return walk(gunzipSync(gz), want);
}

function walk(buf, want) {
  let off = 0, longName = null, paxPath = null, paxMtime = null;
  const str = (start, len) => {
    let end = start;
    while (end < start + len && buf[end] !== 0) end++;
    return buf.subarray(start, end).toString('utf8');
  };
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((c) => c === 0)) { off += 512; continue; }
    const size = parseInt(str(off + 124, 12).trim() || '0', 8) || 0;
    const type = str(off + 156, 1) || '0';
    const mtime = parseInt(str(off + 136, 12).trim() || '0', 8) || 0;
    let name = str(off, 100);
    const prefix = str(off + 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    if (longName) { name = longName; longName = null; }
    if (paxPath) { name = paxPath; paxPath = null; }
    if (paxMtime) { paxMtime = null; }

    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);

    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
    } else if (type === 'x' || type === 'X' || type === 'A') {
      for (const part of data.toString('utf8').split('\n')) {
        const m = /^\d+ ([^=]+)=(.*)$/.exec(part.trim());
        if (!m) continue;
        const key = m[1].replace(/^vfs\./, '');
        if (key === 'path') paxPath = m[2].replace(/^\.\//, '');
        else if (key === 'mtime') paxMtime = Number(m[2]);
      }
    } else if (want(name, type)) {
      return { name, data, mtime: paxMtime ?? mtime, type };
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}
