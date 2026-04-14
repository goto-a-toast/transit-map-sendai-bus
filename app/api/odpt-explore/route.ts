import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { unzipSync } from 'fflate';

export const runtime = 'nodejs';
export const revalidate = 0;

const GTFS_URL = 'https://miyagi.dataeye.jp/resource_download/256';

function stripBom(buf: Uint8Array): Uint8Array {
  return (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? buf.slice(3) : buf;
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

    // fflate.unzipSync handles data descriptors, ZIP64, truncated central dirs
    let unzipped: ReturnType<typeof unzipSync>;
    try {
      unzipped = unzipSync(data);
    } catch (e) {
      return NextResponse.json({
        ok: false, error: `fflate: ${e instanceof Error ? e.message : e}`,
        bytes: data.length,
        magic: Buffer.from(data.slice(0, 4)).toString('hex'),
      });
    }

    const fileList    = Object.keys(unzipped).sort();
    const td          = new TextDecoder('utf-8');
    const getText     = (name: string) => unzipped[name] ? td.decode(unzipped[name]) : '';

    const stopsSample  = getText('stops.txt').split('\n').slice(0, 6);
    const routesSample = getText('routes.txt').split('\n').slice(0, 6);
    const tripsSample  = getText('trips.txt').split('\n').slice(0, 4);

    return NextResponse.json({
      ok: fileList.length > 0,
      count: fileList.length,
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
