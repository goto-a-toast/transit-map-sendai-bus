import { NextResponse } from 'next/server';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

export const runtime = 'nodejs';
export const revalidate = 0;

export async function GET() {
  const apiKey = process.env.ODPT_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'APIキーが未設定' }, { status: 500 });

  const url =
    `https://api-public.odpt.org/api/v4/gtfs/realtime/odpt_SendaiMunicipal_bus_realtime_information_trip_update?acl:consumerKey=${apiKey}`;

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/x-protobuf, */*' },
      cache: 'no-store',
    });
    if (!res.ok) return NextResponse.json({ error: `API ${res.status}` }, { status: res.status });

    const buffer = Buffer.from(await res.arrayBuffer());
    const feed   = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

    const now    = Date.now();
    const delays: Record<string, number> = {};

    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu) continue;
      const tripId = tu.trip?.tripId ?? entity.id;

      // Use delay from the first upcoming stop time update
      for (const stu of (tu.stopTimeUpdate ?? [])) {
        const arrMs = stu.arrival?.time
          ? Number(stu.arrival.time) * 1000
          : stu.departure?.time
            ? Number(stu.departure.time) * 1000
            : null;
        if (!arrMs || arrMs < now - 30_000) continue;
        delays[tripId] = stu.arrival?.delay ?? stu.departure?.delay ?? 0;
        break;
      }
    }

    return NextResponse.json({ delays, fetchedAt: now });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'エラー' },
      { status: 500 },
    );
  }
}
