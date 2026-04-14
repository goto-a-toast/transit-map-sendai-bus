import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { inflateRawSync } from 'node:zlib';

export const runtime = 'nodejs';
export const revalidate = 0;

const GTFS_URL = 'https://miyagi.dataeye.jp/resource_download/256';

const GTFS_NAMES = new Set([
  'agency.txt','stops.txt','routes.txt','trips.txt','stop_times.txt',
  'calendar.txt','calendar_dates.txt','feed_info.txt','shapes.txt',
  'fare_attributes.txt','fare_rules.txt','frequencies.txt','transfers.txt',
  'translations.txt','attributions.txt','office_jp.txt','routes_jp.txt',
]);

function stripBom(buf: Uint8Array): Uint8Array {
  return (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? buf.slice(3) : buf;
}

interface CdEntry {
  pos: number; name: string;
  method: number; cSize: number; uSize: number; localOffset: number;
}

/** Scan the entire file for central-directory entries (PK\x01\x02) whose
 *  filename matches a known GTFS file. */
function findCdEntries(data: Uint8Array): Record<string, CdEntry> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const td   = new TextDecoder('utf-8');
  const out: Record<string, CdEntry> = {};

  for (let i = 0; i + 46 < data.length; i++) {
    if (data[i]!==0x50 || data[i+1]!==0x4B || data[i+2]!==0x01 || data[i+3]!==0x02) continue;
    const nameLen = view.getUint16(i + 28, true);
    if (nameLen < 3 || nameLen > 40 || i + 46 + nameLen > data.length) continue;
    const name = td.decode(data.slice(i + 46, i + 46 + nameLen));
    if (!GTFS_NAMES.has(name)) continue;

    out[name] = {
      pos:         i,
      name,
      method:      view.getUint16(i + 10, true),
      cSize:       view.getUint32(i + 20, true),
      uSize:       view.getUint32(i + 24, true),
      localOffset: view.getUint32(i + 42, true),
    };
  }
  return out;
}

/** Scan the entire file for local-file headers (PK\x03\x04) whose
 *  filename matches a known GTFS file. Returns name → byte offset. */
function findLocalHeaders(data: Uint8Array): Record<string, number> {
  const td  = new TextDecoder('utf-8');
  const out: Record<string, number> = {};

  for (let i = 0; i + 30 < data.length; i++) {
    if (data[i]!==0x50 || data[i+1]!==0x4B || data[i+2]!==0x03 || data[i+3]!==0x04) continue;
    const nameLen = (data[i+26] | (data[i+27] << 8));
    if (nameLen < 3 || nameLen > 40 || i + 30 + nameLen > data.length) continue;
    const name = td.decode(data.slice(i + 30, i + 30 + nameLen));
    if (GTFS_NAMES.has(name) && !(name in out)) out[name] = i;
  }
  return out;
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
    const td   = new TextDecoder('utf-8');

    // Locate central-directory & local-header entries for GTFS files
    const cdEntries    = findCdEntries(data);
    const localHeaders = findLocalHeaders(data);

    const cdNames    = Object.keys(cdEntries);
    const localNames = Object.keys(localHeaders);

    // Try to extract each GTFS file
    const extracted: Record<string, string[]> = {};
    const errors:    string[] = [];

    for (const name of [...new Set([...cdNames, ...localNames])]) {
      const cd       = cdEntries[name];
      const localPos = localHeaders[name] ?? -1;

      if (localPos < 0) {
        errors.push(`${name}: CD found at pos=${cd?.pos} but no local header`);
        continue;
      }

      // Parse local header to get dataStart
      const localExtraLen = (data[localPos+28] | (data[localPos+29] << 8));
      const localNameLen  = (data[localPos+26] | (data[localPos+27] << 8));
      const dataStart     = localPos + 30 + localNameLen + localExtraLen;

      // Prefer cSize from central directory (more reliable than local header)
      const localCSize = new DataView(data.buffer, data.byteOffset).getUint32(localPos + 18, true);
      const cSize      = (cd && cd.cSize > 0 && cd.cSize < data.length) ? cd.cSize : localCSize;
      const method     = cd ? cd.method : (data[localPos+8] | (data[localPos+9] << 8));

      if (cSize === 0) {
        errors.push(`${name}: cSize=0 in both CD and local header`);
        continue;
      }
      if (dataStart + cSize > data.length) {
        errors.push(`${name}: out of bounds (dataStart=${dataStart}, cSize=${cSize}, fileLen=${data.length})`);
        continue;
      }

      try {
        const compressed = data.slice(dataStart, dataStart + cSize);
        const raw2 = method === 0
          ? compressed
          : inflateRawSync(Buffer.from(compressed));
        const text = td.decode(raw2);
        extracted[name] = text.split('\n').slice(0, 4);
      } catch (e) {
        errors.push(`${name}: decompress err – ${e instanceof Error ? e.message : e}`);
      }
    }

    return NextResponse.json({
      ok:         Object.keys(extracted).length > 0,
      cdFound:    cdNames,
      localFound: localNames,
      cdDetails:  Object.fromEntries(
        cdNames.map(n => [n, { pos: cdEntries[n].pos, cSize: cdEntries[n].cSize, localOffset: cdEntries[n].localOffset }])
      ),
      localPositions: localHeaders,
      extracted,
      errors,
    });

  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }
}
