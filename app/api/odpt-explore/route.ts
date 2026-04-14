import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import JSZip from 'jszip';

export const runtime = 'nodejs';
export const revalidate = 0;

// URLs to try for Sendai Municipal Bus GTFS-JP static data
const CANDIDATE_URLS = [
  // Direct resource download (resource ID 256 = Sendai Municipal Bus)
  'https://miyagi.dataeye.jp/resource_download/256',
  // Bundle download (dataset 251, contains both Sendai bus + Tsutsumazawa)
  'https://miyagi.dataeye.jp/resource_bundle_download/251',
];

function stripBom(buf: Buffer): Buffer {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3);
  return buf;
}

async function tryParseGtfsZip(buf: Buffer): Promise<{ ok: true; files: string[]; stops: string[]; routes: string[] } | { ok: false; error: string; magic: string; bytes: number }> {
  const stripped = stripBom(buf);
  try {
    const zip = await JSZip.loadAsync(stripped);
    const files = Object.keys(zip.files);

    // If this ZIP itself contains GTFS files, we're done
    if (zip.files['stops.txt']) {
      const stops  = (await zip.files['stops.txt'].async('text')).split('\n').slice(0, 6);
      const routes = zip.files['routes.txt']
        ? (await zip.files['routes.txt'].async('text')).split('\n').slice(0, 6)
        : [];
      return { ok: true, files, stops, routes };
    }

    // Otherwise look for a nested ZIP (bundle case)
    const innerName = files.find(f => /\.(zip|ZIP)$/i.test(f));
    if (innerName) {
      const innerBuf = await zip.files[innerName].async('nodebuffer');
      return tryParseGtfsZip(innerBuf); // recurse
    }

    return { ok: true, files, stops: [], routes: [] };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      magic: stripped.slice(0, 4).toString('hex'),
      bytes: stripped.length,
    };
  }
}

async function probeUrl(url: string) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return { url, status: res.status, error: `HTTP ${res.status}` };

    const buf    = Buffer.from(await res.arrayBuffer());
    const result = await tryParseGtfsZip(buf);
    return { url, status: res.status, bytes: buf.length, ...result };
  } catch (e) {
    return { url, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get('type') ?? 'gtfs-probe';

  if (type === 'gtfs-probe') {
    // Try candidate URLs one by one and return first success
    const results = [];
    for (const url of CANDIDATE_URLS) {
      const r = await probeUrl(url);
      results.push(r);
      if ((r as { ok?: boolean }).ok) break; // stop on first success
    }
    return NextResponse.json(results);
  }

  return NextResponse.json({ error: 'type=gtfs-probe' }, { status: 400 });
}
