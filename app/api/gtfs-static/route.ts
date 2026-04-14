import { NextResponse } from 'next/server';
import { getGtfsStaticCached } from '../../../lib/gtfs-static';

export const runtime = 'nodejs';

export type { GtfsRoute, GtfsStop, GtfsTrip, GtfsStaticData } from '../../../lib/gtfs-static';

export async function GET() {
  const apiKey = process.env.ODPT_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'APIキーが未設定' }, { status: 500 });
  try {
    const data = await getGtfsStaticCached(apiKey);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'GTFSスタティック取得失敗' },
      { status: 500 },
    );
  }
}
