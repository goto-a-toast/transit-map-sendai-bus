import { NextResponse } from 'next/server';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

export const runtime = 'nodejs';
export const revalidate = 0;

export interface ServiceAlert {
  id:          string;
  header:      string;
  description: string;
  effect:      string;
}

const EFFECT_LABELS: Record<number, string> = {
  1: '運休', 2: '大幅遅延', 3: '迂回運行', 4: '乗り場変更',
  5: '増便',  6: 'ダイヤ改正', 7: 'お知らせ', 8: '遅延',
};

export async function GET() {
  const apiKey = process.env.ODPT_API_KEY;
  if (!apiKey) return NextResponse.json({ alerts: [] });

  const url = `https://api-public.odpt.org/api/v4/gtfs/realtime/odpt_SendaiMunicipal_bus_realtime_information_alert?acl:consumerKey=${apiKey}`;

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/x-protobuf, */*' },
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ alerts: [], fetchedAt: Date.now() });

    const buffer = Buffer.from(await res.arrayBuffer());
    const feed   = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

    const alerts: ServiceAlert[] = feed.entity
      .filter(e => e.alert)
      .map(e => {
        const a = e.alert!;
        return {
          id:          e.id,
          header:      a.headerText?.translation?.[0]?.text      ?? '',
          description: a.descriptionText?.translation?.[0]?.text ?? '',
          effect:      EFFECT_LABELS[(a.effect as unknown as number)] ?? 'お知らせ',
        };
      })
      .filter(a => a.header);

    return NextResponse.json({ alerts, fetchedAt: Date.now() });
  } catch {
    return NextResponse.json({ alerts: [], fetchedAt: Date.now() });
  }
}
