import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const revalidate = 0;

// Exploration endpoint: try ODPT JSON-LD API for Sendai Municipal Bus
// Usage: /api/odpt-explore?type=stops   → odpt:BusstopPole
//        /api/odpt-explore?type=routes  → odpt:BusroutePattern
//        /api/odpt-explore?type=buses   → odpt:Bus (real-time)

const BASE = 'https://api-public.odpt.org/api/v4';
const OP   = 'odpt.Operator:SendaiMunicipal';

const ENDPOINTS: Record<string, string> = {
  stops:  `${BASE}/odpt:BusstopPole?odpt:operator=${OP}`,
  routes: `${BASE}/odpt:BusroutePattern?odpt:operator=${OP}`,
  buses:  `${BASE}/odpt:Bus?odpt:operator=${OP}`,
};

export async function GET(req: NextRequest) {
  const type   = req.nextUrl.searchParams.get('type') ?? 'stops';
  const limit  = Number(req.nextUrl.searchParams.get('limit') ?? '3');
  const apiKey = process.env.ODPT_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'APIキーが未設定' }, { status: 500 });

  const base = ENDPOINTS[type];
  if (!base) return NextResponse.json({ error: `type は stops / routes / buses のいずれか` }, { status: 400 });

  const url = `${base}&acl:consumerKey=${apiKey}`;

  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      return NextResponse.json({ error: `API ${res.status} ${res.statusText}`, url: base }, { status: res.status });
    }

    const json = await res.json();
    if (!Array.isArray(json)) {
      return NextResponse.json({ error: '配列ではないレスポンス', raw: json });
    }

    const sample = json.slice(0, limit);
    return NextResponse.json({
      type,
      total: json.length,
      sample,
      keys: sample[0] ? Object.keys(sample[0]) : [],
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'エラー' },
      { status: 500 },
    );
  }
}
