import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { inflateRawSync } from 'node:zlib';

export const runtime = 'nodejs';
export const revalidate = 0;

const GTFS_URL = 'https://miyagi.dataeye.jp/resource_download/256';

function stripBom(buf: Uint8Array): Uint8Array {
  return (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? buf.slice(3) : buf;
}

function hexDump(arr: Uint8Array, offset = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < arr.length; i += 16) {
    const row = Array.from(arr.slice(i, i + 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    lines.push(`${(offset + i).toString(16).padStart(7, '0')}: ${row}`);
  }
  return lines.join('\n');
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

    const len = data.length;

    // ── 1. Hex dump last 900 bytes (contains all 12 CD entries + EOCD) ──
    const cdWindow = data.slice(len - 900);
    const cdHex = hexDump(cdWindow, len - 900);

    // ── 2. Hex dump first 200 bytes (first local header + what follows) ──
    const firstHex = hexDump(data.slice(0, 200));

    // ── 3. Scan last 900 bytes byte-by-byte for ALL PK\x01\x02 (NO jump) ──
    const cdStart = len - 900;
    const rawCdEntries: Array<{
      absPos: number; nameLen: number; extraLen: number; commentLen: number;
      method: number; cSize: number; uSize: number; localOffset: number;
      nameRaw: string; nameBytes: string;
    }> = [];

    for (let i = 0; i + 46 < cdWindow.length; i++) {
      if (cdWindow[i]!==0x50 || cdWindow[i+1]!==0x4B ||
          cdWindow[i+2]!==0x01 || cdWindow[i+3]!==0x02) continue;

      const absPos     = cdStart + i;
      const vMethod    = new DataView(cdWindow.buffer, cdWindow.byteOffset + i, cdWindow.byteLength - i);
      const method     = vMethod.getUint16(8, true);
      const cSize      = vMethod.getUint32(20, true);
      const uSize      = vMethod.getUint32(24, true);
      const nameLen    = vMethod.getUint16(28, true);
      const extraLen   = vMethod.getUint16(30, true);
      const commentLen = vMethod.getUint16(32, true);
      const localOffset = vMethod.getUint32(42, true);
      const nameBytes  = nameLen > 0 && i + 46 + nameLen <= cdWindow.length
        ? Array.from(cdWindow.slice(i + 46, i + 46 + nameLen)).map(b => b.toString(16).padStart(2,'0')).join(' ')
        : '';
      const nameRaw = nameLen > 0 && nameLen <= 100 && i + 46 + nameLen <= cdWindow.length
        ? td.decode(cdWindow.slice(i + 46, i + 46 + nameLen))
        : '';
      rawCdEntries.push({ absPos, nameLen, extraLen, commentLen, method, cSize, uSize, localOffset, nameRaw, nameBytes });
    }

    // ── 4. For each CD entry with a short printable name, try to extract ──
    // Base: "" CD entry says localOffset=16777216, "" local header is at 0
    // → base = 16777216
    const BASE = 16_777_216;
    const extracted: Record<string, string[]> = {};
    const errors: string[] = [];

    for (const cd of rawCdEntries) {
      if (!cd.nameRaw || cd.nameLen < 3 || cd.nameLen > 30) continue;
      if (!/^[\x20-\x7E]+$/.test(cd.nameRaw)) continue;

      const adjustedPos = cd.localOffset - BASE;
      if (adjustedPos < 0 || adjustedPos + 30 > len) {
        errors.push(`${cd.nameRaw}: adjusted pos ${adjustedPos} OOB (localOffset=${cd.localOffset})`);
        continue;
      }

      // Skip local file header at adjustedPos
      const localNameLen  = (data[adjustedPos+26] | (data[adjustedPos+27] << 8));
      const localExtraLen = (data[adjustedPos+28] | (data[adjustedPos+29] << 8));
      const dataStart     = adjustedPos + 30 + localNameLen + localExtraLen;

      // Use CD's cSize (fall back to local header if CD cSize seems wrong)
      const cSizeToUse = (cd.cSize > 0 && cd.cSize < len) ? cd.cSize
        : view.getUint32(adjustedPos + 18, true);
      const methodToUse = cd.method;

      if (dataStart + cSizeToUse > len || cSizeToUse === 0) {
        errors.push(`${cd.nameRaw}: dataStart=${dataStart} cSize=${cSizeToUse} invalid`);
        continue;
      }

      try {
        const compData = data.slice(dataStart, dataStart + cSizeToUse);
        const raw2 = methodToUse === 0 ? compData : inflateRawSync(Buffer.from(compData));
        extracted[cd.nameRaw] = td.decode(raw2).split('\n').slice(0, 5);
      } catch (e) {
        errors.push(`${cd.nameRaw}: decompress – ${e instanceof Error ? e.message : e} (dataStart=${dataStart} cSize=${cSizeToUse})`);
      }
    }

    return NextResponse.json({
      totalBytes: len,
      firstHex,
      cdHex,
      rawCdEntries,
      extracted,
      errors,
    });

  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    clearTimeout(timer);
  }
}
