import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { inflateRawSync } from 'node:zlib';

export const runtime = 'nodejs';
export const revalidate = 0;

const GTFS_URL = 'https://miyagi.dataeye.jp/resource_download/256';

function stripBom(buf: Buffer): Buffer {
  return (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? buf.slice(3) : buf;
}

interface LocalHeader {
  flags: number;
  compression: number;
  cSize: number;
  uSize: number;
  name: string;
  dataStart: number;
  hasDataDescriptor: boolean;
}

function readLocalHeader(buf: Buffer, pos: number): LocalHeader | null {
  if (pos + 30 > buf.length) return null;
  if (!(buf[pos] === 0x50 && buf[pos+1] === 0x4B && buf[pos+2] === 0x03 && buf[pos+3] === 0x04)) return null;
  const flags       = buf.readUInt16LE(pos + 6);
  const compression = buf.readUInt16LE(pos + 8);
  const cSize       = buf.readUInt32LE(pos + 18);
  const uSize       = buf.readUInt32LE(pos + 22);
  const nameLen     = buf.readUInt16LE(pos + 26);
  const extraLen    = buf.readUInt16LE(pos + 28);
  const name        = buf.slice(pos + 30, pos + 30 + nameLen).toString('utf8');
  const dataStart   = pos + 30 + nameLen + extraLen;
  return { flags, compression, cSize, uSize, name, dataStart, hasDataDescriptor: (flags & 0x08) !== 0 };
}

/**
 * Parse ZIP local file headers, handling both fixed-size and data-descriptor entries.
 * Does NOT require a valid central directory.
 */
function parseZipLocal(buf: Buffer): { files: Map<string, string>; debug: object } {
  const files = new Map<string, string>();
  const debug: { firstHeader?: object; errors: string[] } = { errors: [] };
  let pos = 0;

  // Find first PK\x03\x04
  while (pos + 30 < buf.length) {
    if (buf[pos] === 0x50 && buf[pos+1] === 0x4B && buf[pos+2] === 0x03 && buf[pos+3] === 0x04) break;
    pos++;
  }

  while (pos + 30 < buf.length) {
    const hdr = readLocalHeader(buf, pos);
    if (!hdr) break; // no more local headers

    // Record first header for debugging
    if (!debug.firstHeader) {
      debug.firstHeader = {
        pos, flags: `0x${hdr.flags.toString(16)}`,
        compression: hdr.compression, cSize: hdr.cSize, uSize: hdr.uSize,
        name: hdr.name, dataStart: hdr.dataStart, hasDataDescriptor: hdr.hasDataDescriptor,
      };
    }

    let compData: Buffer = Buffer.alloc(0);
    let nextPos: number = pos + 4;

    if (!hdr.hasDataDescriptor && hdr.cSize > 0 && hdr.dataStart + hdr.cSize <= buf.length) {
      // ── Simple case: size known in header ──────────────────────────────
      compData = buf.slice(hdr.dataStart, hdr.dataStart + hdr.cSize);
      nextPos  = hdr.dataStart + hdr.cSize;
    } else {
      // ── Data descriptor case: scan forward for next signature ──────────
      let scan = hdr.dataStart;
      let found = false;

      while (scan + 4 < buf.length) {
        if (buf[scan] === 0x50 && buf[scan+1] === 0x4B) {
          if (buf[scan+2] === 0x07 && buf[scan+3] === 0x08) {
            // PK\x07\x08 = data descriptor (with signature)
            compData = buf.slice(hdr.dataStart, scan);
            nextPos  = scan + 16; // sig(4)+crc(4)+cSize(4)+uSize(4)
            found = true; break;
          }
          if (buf[scan+2] === 0x03 && buf[scan+3] === 0x04) {
            // PK\x03\x04 = next local file header (descriptor has no sig)
            compData = buf.slice(hdr.dataStart, scan - 12); // minus crc+cSize+uSize
            nextPos  = scan;
            found = true; break;
          }
          if (buf[scan+2] === 0x01 && buf[scan+3] === 0x02) {
            // PK\x01\x02 = central directory (last entry)
            compData = buf.slice(hdr.dataStart, scan - 12);
            nextPos  = scan;
            found = true; break;
          }
        }
        scan++;
      }

      if (!found) {
        debug.errors.push(`${hdr.name}: could not find end of data descriptor`);
        break;
      }
    }

    pos = nextPos;

    if (hdr.name.endsWith('/') || !hdr.name) continue;
    if (compData!.length === 0) { debug.errors.push(`${hdr.name}: empty`); continue; }

    try {
      const out = hdr.compression === 0 ? compData! : inflateRawSync(compData!);
      files.set(hdr.name, out.toString('utf8'));
    } catch (e) {
      debug.errors.push(`${hdr.name}: decompress failed – ${e instanceof Error ? e.message : e}`);
    }
  }

  return { files, debug };
}

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('type') !== 'gtfs-probe') {
    return NextResponse.json({ error: 'type=gtfs-probe' }, { status: 400 });
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(GTFS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return NextResponse.json({ error: `HTTP ${res.status}` });

    const buf            = stripBom(Buffer.from(await res.arrayBuffer()));
    const { files, debug } = parseZipLocal(buf);
    const fileList       = [...files.keys()].sort();

    if (files.size === 0) {
      return NextResponse.json({ ok: false, count: 0, fileList, debug });
    }

    const stopsSample  = (files.get('stops.txt')  ?? '').split('\n').slice(0, 6);
    const routesSample = (files.get('routes.txt') ?? '').split('\n').slice(0, 6);
    const tripsSample  = (files.get('trips.txt')  ?? '').split('\n').slice(0, 4);

    return NextResponse.json({ ok: true, count: files.size, fileList, stopsSample, routesSample, tripsSample });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }
}
