import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import JSZip from 'jszip';

export const runtime = 'nodejs';
export const revalidate = 0;

const BUNDLE_URL = 'https://miyagi.dataeye.jp/resource_bundle_download/251';

const ODPT_GTFS_VARIANTS = [
  'odpt_SendaiMunicipal_bus',
  'odpt_SendaiMunicipal',
];

async function probeGtfsBundle() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(BUNDLE_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return { error: `HTTP ${res.status}`, url: BUNDLE_URL };

  const buf = Buffer.from(await res.arrayBuffer());

  // Try parsing outer bundle as ZIP
  let outerZip: JSZip;
  try {
    outerZip = await JSZip.loadAsync(buf);
  } catch (e) {
    return {
      step: 'outer_zip_failed',
      error: e instanceof Error ? e.message : String(e),
      bytes: buf.length,
      magic: buf.slice(0, 4).toString('hex'),
    };
  }

  const outerFiles = Object.keys(outerZip.files);

  // Case A: outer ZIP already contains GTFS files directly
  if (outerZip.files['stops.txt']) {
    const stops  = (await outerZip.files['stops.txt'].async('text')).split('\n').slice(0, 5);
    const routes = outerZip.files['routes.txt']
      ? (await outerZip.files['routes.txt'].async('text')).split('\n').slice(0, 5)
      : [];
    return { step: 'success_outer_is_gtfs', outerFiles, stops, routes };
  }

  // Case B: outer ZIP contains an inner ZIP
  const innerName = outerFiles.find(f => /\.(zip|ZIP)/.test(f));
  if (!innerName) {
    return { step: 'no_inner_zip', outerFiles };
  }

  const innerBuf   = await outerZip.files[innerName].async('nodebuffer');
  const innerMagic = innerBuf.slice(0, 4).toString('hex'); // '504b0304' = ZIP

  // Try parsing inner as ZIP
  let innerZip: JSZip;
  try {
    innerZip = await JSZip.loadAsync(innerBuf);
  } catch (e) {
    return {
      step: 'inner_zip_failed',
      error: e instanceof Error ? e.message : String(e),
      innerName,
      innerBytes: innerBuf.length,
      innerMagic,  // 504b0304 = valid ZIP header
      outerFiles,
    };
  }

  const innerFiles = Object.keys(innerZip.files);
  const stops  = innerZip.files['stops.txt']
    ? (await innerZip.files['stops.txt'].async('text')).split('\n').slice(0, 5)
    : ['stops.txt not found'];
  const routes = innerZip.files['routes.txt']
    ? (await innerZip.files['routes.txt'].async('text')).split('\n').slice(0, 5)
    : ['routes.txt not found'];

  return { step: 'success', innerName, innerFiles, stops, routes };
}

async function probeGtfsOdpt(apiKey: string) {
  const results: Record<string, string> = {};
  for (const name of ODPT_GTFS_VARIANTS) {
    const url = `https://api-public.odpt.org/api/v4/gtfs/static/${name}?acl:consumerKey=${apiKey}`;
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      results[name] = `${r.status} (type:${r.headers.get('content-type') ?? '?'} len:${r.headers.get('content-length') ?? '?'})`;
    } catch (e) {
      results[name] = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(t);
    }
  }
  return results;
}

export async function GET(req: NextRequest) {
  const type   = req.nextUrl.searchParams.get('type') ?? 'gtfs-bundle';
  const apiKey = process.env.ODPT_API_KEY ?? '';

  try {
    if (type === 'gtfs-bundle') return NextResponse.json(await probeGtfsBundle());
    if (type === 'gtfs-odpt') {
      if (!apiKey) return NextResponse.json({ error: 'APIキーが未設定' }, { status: 500 });
      return NextResponse.json(await probeGtfsOdpt(apiKey));
    }
    return NextResponse.json({ error: 'type=gtfs-bundle or gtfs-odpt' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'エラー' },
      { status: 500 },
    );
  }
}
