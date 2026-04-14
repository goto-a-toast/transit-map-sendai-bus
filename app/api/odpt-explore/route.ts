import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { inflateRawSync } from 'node:zlib';

export const runtime = 'nodejs';
export const revalidate = 0;

const GTFS_URL = 'https://miyagi.dataeye.jp/resource_download/256';

function stripBom(buf: Buffer): Buffer {
  return (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? buf.slice(3) : buf;
}

/**
 * Parse ZIP by scanning local file headers (PK\x03\x04).
 * Does NOT rely on the central directory — works on truncated ZIPs.
 */
function parseZipLocal(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let pos = 0;

  while (pos + 30 < buf.length) {
    // Scan for local file header signature: PK\x03\x04
    if (!(buf[pos] === 0x50 && buf[pos+1] === 0x4B &&
          buf[pos+2] === 0x03 && buf[pos+3] === 0x04)) {
      pos++;
      continue;
    }

    const compression    = buf.readUInt16LE(pos + 8);
    const compressedSize = buf.readUInt32LE(pos + 18);
    const nameLen        = buf.readUInt16LE(pos + 26);
    const extraLen       = buf.readUInt16LE(pos + 28);
    const name           = buf.slice(pos + 30, pos + 30 + nameLen).toString('utf8');
    const dataStart      = pos + 30 + nameLen + extraLen;

    pos = dataStart + compressedSize;

    if (!name || name.endsWith('/') || dataStart + compressedSize > buf.length) continue;
    if (compressedSize === 0) continue;

    try {
      const raw     = buf.slice(dataStart, dataStart + compressedSize);
      const content = compression === 0 ? raw : inflateRawSync(raw);
      files.set(name, content.toString('utf8'));
    } catch { /* skip corrupt entry */ }
  }

  return files;
}

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get('type') ?? 'gtfs-probe';

  if (type !== 'gtfs-probe') {
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

    const buf   = stripBom(Buffer.from(await res.arrayBuffer()));
    const files = parseZipLocal(buf);

    const fileList = [...files.keys()].sort();

    const stopsSample  = files.has('stops.txt')
      ? files.get('stops.txt')!.split('\n').slice(0, 6)
      : ['stops.txt not found'];
    const routesSample = files.has('routes.txt')
      ? files.get('routes.txt')!.split('\n').slice(0, 6)
      : ['routes.txt not found'];
    const tripsSample  = files.has('trips.txt')
      ? files.get('trips.txt')!.split('\n').slice(0, 4)
      : ['trips.txt not found'];

    return NextResponse.json({
      ok:   files.size > 0,
      count: files.size,
      fileList,
      stopsSample,
      routesSample,
      tripsSample,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }
}
