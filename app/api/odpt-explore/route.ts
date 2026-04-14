import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import JSZip from 'jszip';

export const runtime = 'nodejs';
export const revalidate = 0;

// Exploration endpoint
// /api/odpt-explore?type=gtfs-bundle   → try miyagi.dataeye.jp bundle ZIP
// /api/odpt-explore?type=gtfs-odpt    → try ODPT GTFS static (with API key)
// /api/odpt-explore?type=stops        → ODPT JSON-LD BusstopPole

const BUNDLE_URL = 'https://miyagi.dataeye.jp/resource_bundle_download/251';

// Try several ODPT GTFS static endpoint name variants
const ODPT_GTFS_VARIANTS = [
  'odpt_SendaiMunicipal_bus',
  'odpt_SendaiMunicipal',
  'odpt_SendaiMunicipal_Bus',
];

async function probeGtfsBundle() {
  const res = await fetch(BUNDLE_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    cache: 'no-store',
  });
  if (!res.ok) return { error: `HTTP ${res.status}`, url: BUNDLE_URL };

  const contentType = res.headers.get('content-type') ?? '';
  const buf = Buffer.from(await res.arrayBuffer());

  let outerZip: JSZip;
  try {
    outerZip = await JSZip.loadAsync(buf);
  } catch {
    return {
      error: 'outer ZIP parse failed',
      contentType,
      bytes: buf.length,
      firstBytes: buf.slice(0, 4).toString('hex'),
    };
  }

  const outerFiles = Object.keys(outerZip.files);

  // Look for an inner ZIP file
  const innerZipName = outerFiles.find(f =>
    f.toLowerCase().endsWith('.zip') || f.toLowerCase().endsWith('.zip')
  );

  if (!innerZipName) {
    // Maybe the outer zip IS the GTFS zip — list its files
    return { outerFiles, note: 'no inner zip found; listing outer files' };
  }

  const innerBuf = await outerZip.files[innerZipName].async('nodebuffer');
  let innerZip: JSZip;
  try {
    innerZip = await JSZip.loadAsync(innerBuf);
  } catch {
    return {
      error: 'inner ZIP parse failed',
      innerZipName,
      outerFiles,
    };
  }

  const innerFiles = Object.keys(innerZip.files);

  // Try to read stops.txt sample
  let stopsSample: string[] = [];
  if (innerZip.files['stops.txt']) {
    const text = await innerZip.files['stops.txt'].async('text');
    stopsSample = text.split('\n').slice(0, 6);
  }

  // Try to read routes.txt sample
  let routesSample: string[] = [];
  if (innerZip.files['routes.txt']) {
    const text = await innerZip.files['routes.txt'].async('text');
    routesSample = text.split('\n').slice(0, 6);
  }

  return { outerFiles, innerZipName, innerFiles, stopsSample, routesSample };
}

async function probeGtfsOdpt(apiKey: string) {
  const results: Record<string, string> = {};
  for (const name of ODPT_GTFS_VARIANTS) {
    const url = `https://api-public.odpt.org/api/v4/gtfs/static/${name}?acl:consumerKey=${apiKey}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      results[name] = `${res.status} ${res.statusText} (content-type: ${res.headers.get('content-type') ?? '?'}, bytes: ${res.headers.get('content-length') ?? '?'})`;
    } catch (e) {
      results[name] = `fetch error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return results;
}

export async function GET(req: NextRequest) {
  const type   = req.nextUrl.searchParams.get('type') ?? 'gtfs-bundle';
  const apiKey = process.env.ODPT_API_KEY ?? '';

  try {
    if (type === 'gtfs-bundle') {
      const result = await probeGtfsBundle();
      return NextResponse.json(result);
    }

    if (type === 'gtfs-odpt') {
      if (!apiKey) return NextResponse.json({ error: 'APIキーが未設定' }, { status: 500 });
      const result = await probeGtfsOdpt(apiKey);
      return NextResponse.json(result);
    }

    // JSON-LD fallback
    const BASE = 'https://api-public.odpt.org/api/v4';
    const OP   = 'odpt.Operator:SendaiMunicipal';
    const ENDPOINTS: Record<string, string> = {
      stops:  `${BASE}/odpt:BusstopPole?odpt:operator=${OP}`,
      routes: `${BASE}/odpt:BusroutePattern?odpt:operator=${OP}`,
    };
    const base = ENDPOINTS[type];
    if (!base) return NextResponse.json({ error: 'unknown type' }, { status: 400 });
    if (!apiKey) return NextResponse.json({ error: 'APIキーが未設定' }, { status: 500 });

    const res  = await fetch(`${base}&acl:consumerKey=${apiKey}`, { cache: 'no-store' });
    const json = await res.json();
    return NextResponse.json({ total: Array.isArray(json) ? json.length : 0, sample: Array.isArray(json) ? json.slice(0, 2) : json });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'エラー' },
      { status: 500 },
    );
  }
}
