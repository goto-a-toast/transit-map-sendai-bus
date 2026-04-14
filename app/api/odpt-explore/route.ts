import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { unzipSync } from 'fflate';

export const runtime = 'nodejs';
export const revalidate = 0;

const GTFS_URL = 'https://miyagi.dataeye.jp/resource_download/256';

function stripBom(buf: Uint8Array): Uint8Array {
  return (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? buf.slice(3) : buf;
}

/** Find EOCD record, return { totalEntries, cdOffset, cdSize } or null */
function readEocd(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Search backward from end
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65558); i--) {
    if (data[i] === 0x50 && data[i+1] === 0x4B && data[i+2] === 0x05 && data[i+3] === 0x06) {
      return {
        totalEntries: view.getUint16(i + 10, true),
        cdSize:       view.getUint32(i + 12, true),
        cdOffset:     view.getUint32(i + 16, true),
      };
    }
  }
  return null;
}

/** Parse central directory manually, ignoring file data offsets being wrong */
function scanCentralDir(data: Uint8Array, cdOffset: number, totalEntries: number) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const td = new TextDecoder('utf-8');
  const entries: Array<{ name: string; localOffset: number; cSize: number; uSize: number; method: number }> = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries && pos + 46 < data.length; i++) {
    if (!(data[pos]===0x50 && data[pos+1]===0x4B && data[pos+2]===0x01 && data[pos+3]===0x02)) break;
    const method      = view.getUint16(pos + 10, true);
    const cSize       = view.getUint32(pos + 20, true);
    const uSize       = view.getUint32(pos + 24, true);
    const nameLen     = view.getUint16(pos + 28, true);
    const extraLen    = view.getUint16(pos + 30, true);
    const commentLen  = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name        = td.decode(data.slice(pos + 46, pos + 46 + nameLen));
    entries.push({ name, localOffset, cSize, uSize, method });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
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

    const raw  = new Uint8Array(await res.arrayBuffer());
    const data = stripBom(raw);

    // ── Step 1: Read EOCD ──────────────────────────────────────────────
    const eocd = readEocd(data);
    const cdEntries = eocd ? scanCentralDir(data, eocd.cdOffset, eocd.totalEntries) : [];

    // ── Step 2: Try fflate first ───────────────────────────────────────
    let unzipped: ReturnType<typeof unzipSync> | null = null;
    let fflateError = '';
    try {
      unzipped = unzipSync(data);
    } catch (e) {
      fflateError = e instanceof Error ? e.message : String(e);
    }

    const td = new TextDecoder('utf-8');

    // ── Step 3: Check if the "" entry is itself a ZIP ──────────────────
    if (unzipped) {
      const emptyEntry = unzipped[''];
      if (emptyEntry && emptyEntry.length > 4 &&
          emptyEntry[0] === 0x50 && emptyEntry[1] === 0x4B) {
        // Nested ZIP inside the "" entry
        try {
          const inner = unzipSync(emptyEntry);
          const innerFiles = Object.keys(inner).sort();
          const getText = (name: string) => inner[name] ? td.decode(inner[name]) : '';
          return NextResponse.json({
            ok: innerFiles.length > 0,
            source: 'nested-zip',
            count: innerFiles.length,
            fileList: innerFiles,
            stopsSample:  getText('stops.txt').split('\n').slice(0, 6),
            routesSample: getText('routes.txt').split('\n').slice(0, 6),
            tripsSample:  getText('trips.txt').split('\n').slice(0, 4),
          });
        } catch (e) {
          // Fall through to diagnostics
        }
      }

      // ── Step 4: Check normal fflate output ────────────────────────────
      const fileList = Object.keys(unzipped).sort();
      if (fileList.some(f => f === 'stops.txt')) {
        const getText = (name: string) => unzipped![name] ? td.decode(unzipped![name]) : '';
        return NextResponse.json({
          ok: true, source: 'fflate',
          count: fileList.length, fileList,
          stopsSample:  getText('stops.txt').split('\n').slice(0, 6),
          routesSample: getText('routes.txt').split('\n').slice(0, 6),
          tripsSample:  getText('trips.txt').split('\n').slice(0, 4),
        });
      }
    }

    // ── Step 5: Return diagnostics ────────────────────────────────────
    const emptyLen   = unzipped?.[''] ? unzipped[''].length : 0;
    const emptyMagic = unzipped?.[''] && unzipped[''].length >= 4
      ? Buffer.from(unzipped[''].slice(0, 4)).toString('hex')
      : 'n/a';

    return NextResponse.json({
      ok: false,
      totalBytes: data.length,
      eocd,
      cdEntries,          // what the central directory actually contains
      fflateError,
      fflateFiles: unzipped ? Object.keys(unzipped) : [],
      emptyEntryBytes: emptyLen,
      emptyEntryMagic:  emptyMagic,
    });

  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }
}
