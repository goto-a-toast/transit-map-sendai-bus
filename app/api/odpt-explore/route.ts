import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const revalidate = 0;

const GTFS_URL = 'https://miyagi.dataeye.jp/resource_download/256';

function stripBom(buf: Uint8Array): Uint8Array {
  return (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? buf.slice(3) : buf;
}

function hex(arr: Uint8Array, limit = 64): string {
  return Array.from(arr.slice(0, limit)).map(b => b.toString(16).padStart(2, '0')).join(' ');
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
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const td   = new TextDecoder('utf-8', { fatal: false });

    // ── Raw hex at key positions ──────────────────────────────────────
    const first64  = hex(data, 64);
    const at61k    = hex(data.slice(61210, 61280), 70);
    const last64   = hex(data.slice(data.length - 64));

    // ── Count ALL PK signatures ───────────────────────────────────────
    let pk0304 = 0, pk0102 = 0, pk0506 = 0, pk0708 = 0;
    for (let i = 0; i + 4 < data.length; i++) {
      if (data[i] !== 0x50 || data[i+1] !== 0x4B) continue;
      if (data[i+2] === 0x03 && data[i+3] === 0x04) pk0304++;
      if (data[i+2] === 0x01 && data[i+3] === 0x02) pk0102++;
      if (data[i+2] === 0x05 && data[i+3] === 0x06) pk0506++;
      if (data[i+2] === 0x07 && data[i+3] === 0x08) pk0708++;
    }

    // ── List first 15 PK\x03\x04 local headers (no name filter) ──────
    const localHeaders: Array<{pos: number; name: string; nameHex: string; nameLen: number; cSize: number; method: number}> = [];
    for (let i = 0; i + 30 < data.length && localHeaders.length < 15; i++) {
      if (data[i]!==0x50 || data[i+1]!==0x4B || data[i+2]!==0x03 || data[i+3]!==0x04) continue;
      const nameLen = (data[i+26] | (data[i+27] << 8));
      const extraLen = (data[i+28] | (data[i+29] << 8));
      const method  = view.getUint16(i + 8, true);
      const cSize   = view.getUint32(i + 18, true);
      if (nameLen > 256 || i + 30 + nameLen > data.length) {
        localHeaders.push({ pos: i, name: '(nameLen too large or OOB)', nameHex: '', nameLen, cSize, method });
        continue;
      }
      const nameBytes = data.slice(i + 30, i + 30 + nameLen);
      const name      = td.decode(nameBytes);
      const nameHex   = hex(nameBytes);
      localHeaders.push({ pos: i, name, nameHex, nameLen, cSize, method });
      // jump past local header to avoid re-scanning its data as another entry
      i += 30 + nameLen + extraLen - 1;
    }

    // ── List first 10 PK\x01\x02 CD entries (no name filter) ─────────
    const cdHeaders: Array<{pos: number; name: string; nameLen: number; cSize: number; localOffset: number}> = [];
    for (let i = 0; i + 46 < data.length && cdHeaders.length < 10; i++) {
      if (data[i]!==0x50 || data[i+1]!==0x4B || data[i+2]!==0x01 || data[i+3]!==0x02) continue;
      const nameLen = view.getUint16(i + 28, true);
      const extraLen = view.getUint16(i + 30, true);
      const commentLen = view.getUint16(i + 32, true);
      const cSize      = view.getUint32(i + 20, true);
      const localOffset = view.getUint32(i + 42, true);
      if (nameLen > 256 || i + 46 + nameLen > data.length) {
        cdHeaders.push({ pos: i, name: '(OOB)', nameLen, cSize, localOffset });
        continue;
      }
      const name = td.decode(data.slice(i + 46, i + 46 + nameLen));
      cdHeaders.push({ pos: i, name, nameLen, cSize, localOffset });
      i += 46 + nameLen + extraLen + commentLen - 1;
    }

    return NextResponse.json({
      totalBytes: data.length,
      rawBomBytes: raw.length,
      first64,
      at61k,
      last64,
      pkCounts: { pk0304, pk0102, pk0506, pk0708 },
      localHeaders,
      cdHeaders,
    });

  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }
}
