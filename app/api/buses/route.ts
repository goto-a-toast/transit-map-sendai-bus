import { NextResponse } from 'next/server';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { getGtfsStaticCached } from '../../../lib/gtfs-static';

export const runtime = 'nodejs';
export const revalidate = 0;

export interface BusVehicle {
  id: string;
  lat: number;
  lon: number;
  bearing?: number;
  speed?: number;         // km/h
  tripId?: string;
  routeId?: string;
  routeShort?: string;   // e.g. "10"
  routeLong?: string;    // e.g. "泉中央駅前〜仙台駅前"
  headsign?: string;     // 行先
  vehicleLabel?: string;
  timestamp?: number;
  currentStatus?: string;
}

// GTFS-RT VehicleStopStatus: 0=INCOMING_AT, 1=STOPPED_AT, 2=IN_TRANSIT_TO
const STATUS_LABELS: Record<number, string> = {
  0: '接近中',
  1: '停車中',
  2: '走行中',
};

export async function GET() {
  const apiKey = process.env.ODPT_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'APIキーが設定されていません' }, { status: 500 });
  }

  const vehicleUrl =
    `https://api-public.odpt.org/api/v4/gtfs/realtime/odpt_SendaiMunicipal_bus_realtime_information_vehicle?acl:consumerKey=${apiKey}`;

  // 車両位置 + GTFSスタティックを並行取得
  const [vehicleRes, gtfs] = await Promise.all([
    fetch(vehicleUrl, {
      headers: { Accept: 'application/x-protobuf, application/octet-stream, */*' },
      cache: 'no-store',
    }).catch(() => null),
    getGtfsStaticCached(apiKey).catch(() => null),
  ]);

  if (!vehicleRes?.ok) {
    return NextResponse.json(
      { error: `APIエラー: ${vehicleRes?.status ?? 500}` },
      { status: vehicleRes?.status ?? 500 },
    );
  }

  try {
    const contentType = vehicleRes.headers.get('content-type') ?? '';
    const buf         = Buffer.from(await vehicleRes.arrayBuffer());
    let vehicles: BusVehicle[] = [];

    if (contentType.includes('json')) {
      vehicles = parseJsonResponse(JSON.parse(buf.toString('utf-8')), gtfs);
    } else {
      try {
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
        vehicles = parseProtobufFeed(feed, gtfs);
      } catch {
        try {
          vehicles = parseJsonResponse(JSON.parse(buf.toString('utf-8')), gtfs);
        } catch {
          return NextResponse.json({ error: 'レスポンスのパースに失敗しました' }, { status: 500 });
        }
      }
    }

    return NextResponse.json({ vehicles, count: vehicles.length, fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '不明なエラー' },
      { status: 500 },
    );
  }
}

type GtfsCache = Awaited<ReturnType<typeof getGtfsStaticCached>> | null;

function enrichRoute(routeId: string | undefined, tripId: string | undefined, gtfs: GtfsCache) {
  if (!gtfs || !routeId) return { routeShort: undefined, routeLong: undefined, headsign: undefined };
  const route   = gtfs.routes[routeId];
  const headsign = tripId ? (gtfs.trips[tripId]?.headsign ?? undefined) : undefined;
  return {
    routeShort: route?.shortName || (routeId ? routeId : undefined),
    routeLong:  route?.longName  || undefined,
    headsign,
  };
}

function parseProtobufFeed(
  feed: GtfsRealtimeBindings.transit_realtime.FeedMessage,
  gtfs: GtfsCache,
): BusVehicle[] {
  return feed.entity.flatMap(entity => {
    const vp = entity.vehicle;
    if (!vp?.position) return [];
    const { latitude: lat, longitude: lon } = vp.position;
    if (!lat || !lon) return [];

    const statusNum = vp.currentStatus != null ? (vp.currentStatus as unknown as number) : undefined;
    const routeId   = vp.trip?.routeId ?? undefined;
    const tripId    = vp.trip?.tripId  ?? undefined;

    return [{
      id:            entity.id,
      lat, lon,
      bearing:       vp.position.bearing ?? undefined,
      speed:         vp.position.speed   != null ? Math.round(vp.position.speed * 3.6) : undefined,
      tripId,
      routeId,
      ...enrichRoute(routeId, tripId, gtfs),
      vehicleLabel:  vp.vehicle?.label  ?? undefined,
      timestamp:     vp.timestamp != null ? Number(vp.timestamp) * 1000 : undefined,
      currentStatus: statusNum    != null ? STATUS_LABELS[statusNum] : undefined,
    }];
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJsonResponse(json: any, gtfs: GtfsCache): BusVehicle[] {
  if (!Array.isArray(json)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return json.flatMap((entity: any) => {
    const vp  = entity.vehicle ?? entity;
    const pos = vp?.position   ?? vp?.Position;
    if (!pos) return [];
    const lat = pos.latitude  ?? pos.Latitude;
    const lon = pos.longitude ?? pos.Longitude;
    if (!lat || !lon) return [];
    const routeId = vp.trip?.routeId ?? vp.Trip?.RouteId;
    const tripId  = vp.trip?.tripId  ?? vp.Trip?.TripId;
    return [{
      id:            entity.id ?? entity.Id ?? String(Math.random()),
      lat, lon,
      bearing:       pos.bearing ?? pos.Bearing,
      speed:         pos.speed   ?? pos.Speed,
      routeId, tripId,
      ...enrichRoute(routeId, tripId, gtfs),
      vehicleLabel:  vp.vehicle?.label ?? vp.Vehicle?.Label,
      timestamp:     vp.timestamp ? Number(vp.timestamp) * 1000 : undefined,
      currentStatus: vp.currentStatus,
    }] as BusVehicle[];
  });
}
