import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

export const runtime = 'nodejs';
export const revalidate = 0;

export interface TripStop {
  stopId:      string;
  arrivalTime: number; // ms timestamp
  delay:       number; // seconds (positive = late)
  isTerminal:  boolean;
}

export interface TripStopsResponse {
  tripId:    string;
  routeId:   string;
  stops:     TripStop[];
  fetchedAt: number;
}

export async function GET(req: NextRequest) {
  const tripId = req.nextUrl.searchParams.get('tripId');
  if (!tripId) return NextResponse.json({ error: 'tripId が必要です' }, { status: 400 });

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

    const now = Date.now();

    for (const entity of feed.entity) {
      const tu = entity.tripUpdate;
      if (!tu) continue;
      const entityTripId = tu.trip?.tripId ?? entity.id;
      if (entityTripId !== tripId) continue;

      const stops: TripStop[] = [];
      for (const stu of (tu.stopTimeUpdate ?? [])) {
        const arrMs = stu.arrival?.time
          ? Number(stu.arrival.time) * 1000
          : stu.departure?.time
            ? Number(stu.departure.time) * 1000
            : null;
        if (!arrMs || arrMs < now - 60_000) continue;
        stops.push({
          stopId:      stu.stopId ?? '',
          arrivalTime: arrMs,
          delay:       stu.arrival?.delay ?? stu.departure?.delay ?? 0,
          isTerminal:  (stu.stopId ?? '').endsWith('_0'),
        });
      }

      return NextResponse.json({
        tripId,
        routeId:   tu.trip?.routeId ?? '',
        stops,
        fetchedAt: now,
      } satisfies TripStopsResponse);
    }

    // tripId not found in current feed
    return NextResponse.json({
      tripId,
      routeId:   '',
      stops:     [],
      fetchedAt: now,
    } satisfies TripStopsResponse);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'エラー' },
      { status: 500 },
    );
  }
}
