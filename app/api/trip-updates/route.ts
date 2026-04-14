import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { getGtfsStaticCached } from '../../../lib/gtfs-static';

export const runtime = 'nodejs';
export const revalidate = 0;

export interface Arrival {
  tripId:      string;
  routeId:     string;
  routeName:   string; // e.g. "10系統"
  routeLong:   string; // e.g. "泉中央駅前〜仙台駅前"
  headsign:    string; // 行先
  arrivalTime: number; // ms timestamp
  delay:       number; // seconds (positive = late)
}

export async function GET(req: NextRequest) {
  const stopId = req.nextUrl.searchParams.get('stopId');
  if (!stopId) return NextResponse.json({ error: 'stopId が必要です' }, { status: 400 });

  const apiKey = process.env.ODPT_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'APIキーが未設定' }, { status: 500 });

  const url = `https://api-public.odpt.org/api/v4/gtfs/realtime/odpt_SendaiMunicipal_bus_realtime_information_trip_update?acl:consumerKey=${apiKey}`;

  try {
    // fetch TripUpdates + GTFS static in parallel
    const [res, gtfs] = await Promise.all([
      fetch(url, { headers: { Accept: 'application/x-protobuf, */*' }, cache: 'no-store' }),
      getGtfsStaticCached(apiKey).catch(() => null),
    ]);

    if (!res.ok) return NextResponse.json({ error: `API ${res.status}` }, { status: res.status });

    const buffer = Buffer.from(await res.arrayBuffer());
    const feed   = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

    const now      = Date.now();
    const arrivals: Arrival[] = [];
    const sampleStopIds = new Set<string>();
    let tripCount = 0;

    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu) continue;
      tripCount++;

      const tripId  = tu.trip?.tripId  ?? entity.id;
      const routeId = tu.trip?.routeId ?? (gtfs?.trips[tripId]?.routeId ?? '');
      const route   = gtfs?.routes[routeId];
      const trip    = gtfs?.trips[tripId];

      for (const stu of (tu.stopTimeUpdate ?? [])) {
        if (stu.stopId) sampleStopIds.add(stu.stopId);
        if (stu.stopId !== stopId) continue;

        const arrMs = stu.arrival?.time
          ? Number(stu.arrival.time) * 1000
          : stu.departure?.time
            ? Number(stu.departure.time) * 1000
            : null;

        if (!arrMs || arrMs < now - 60_000) continue; // skip arrivals > 1 min in past

        arrivals.push({
          tripId,
          routeId,
          routeName:   route?.shortName ? `${route.shortName}系統` : (routeId ? `${routeId}系統` : '-'),
          routeLong:   route?.longName  ?? '',
          headsign:    trip?.headsign   ?? '',
          arrivalTime: arrMs,
          delay:       stu.arrival?.delay ?? 0,
        });
        break; // one entry per trip per stop
      }
    }

    arrivals.sort((a, b) => a.arrivalTime - b.arrivalTime);

    // Return sample stop IDs for debugging when no arrivals found
    const debug = arrivals.length === 0
      ? { tripCount, sampleStopIds: [...sampleStopIds].slice(0, 6) }
      : undefined;

    return NextResponse.json({ stopId, arrivals: arrivals.slice(0, 8), fetchedAt: now, debug });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'エラー' },
      { status: 500 },
    );
  }
}
