import { NextResponse } from 'next/server';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

export const runtime = 'nodejs';
export const revalidate = 0;

export interface BusVehicle {
  id:            string;
  lat:           number;
  lon:           number;
  bearing?:      number;
  speed?:        number;  // km/h
  tripId?:       string;
  routeId?:      string;
  vehicleLabel?: string;
  timestamp?:    number;
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

  const url =
    `https://api-public.odpt.org/api/v4/gtfs/realtime/odpt_SendaiMunicipal_bus_realtime_information_vehicle?acl:consumerKey=${apiKey}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/x-protobuf, application/octet-stream, */*' },
      cache: 'no-store',
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'ネットワークエラー' },
      { status: 500 },
    );
  }

  if (!res.ok) {
    return NextResponse.json(
      { error: `APIエラー: ${res.status} ${res.statusText}` },
      { status: res.status },
    );
  }

  try {
    const contentType = res.headers.get('content-type') ?? '';
    const buf         = Buffer.from(await res.arrayBuffer());

    let vehicles: BusVehicle[] = [];

    if (contentType.includes('json')) {
      vehicles = parseJson(JSON.parse(buf.toString('utf-8')));
    } else {
      try {
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
        vehicles = parseProtobuf(feed);
      } catch {
        try { vehicles = parseJson(JSON.parse(buf.toString('utf-8'))); } catch { /* ignore */ }
      }
    }

    return NextResponse.json({ vehicles, count: vehicles.length, fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '解析エラー' },
      { status: 500 },
    );
  }
}

function parseProtobuf(feed: GtfsRealtimeBindings.transit_realtime.FeedMessage): BusVehicle[] {
  return feed.entity.flatMap(entity => {
    const vp = entity.vehicle;
    if (!vp?.position) return [];
    const { latitude: lat, longitude: lon } = vp.position;
    if (!lat || !lon) return [];
    const statusNum = vp.currentStatus != null ? (vp.currentStatus as unknown as number) : undefined;
    return [{
      id:            entity.id,
      lat, lon,
      bearing:       vp.position.bearing ?? undefined,
      speed:         vp.position.speed   != null ? Math.round(vp.position.speed * 3.6) : undefined,
      tripId:        vp.trip?.tripId     ?? undefined,
      routeId:       vp.trip?.routeId   ?? undefined,
      vehicleLabel:  vp.vehicle?.label  ?? undefined,
      timestamp:     vp.timestamp != null ? Number(vp.timestamp) * 1000 : undefined,
      currentStatus: statusNum    != null ? STATUS_LABELS[statusNum] : undefined,
    }];
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJson(json: any): BusVehicle[] {
  if (!Array.isArray(json)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return json.flatMap((entity: any) => {
    const vp  = entity.vehicle ?? entity;
    const pos = vp?.position   ?? vp?.Position;
    if (!pos) return [];
    const lat = pos.latitude  ?? pos.Latitude;
    const lon = pos.longitude ?? pos.Longitude;
    if (!lat || !lon) return [];
    return [{
      id:            entity.id ?? String(Math.random()),
      lat, lon,
      bearing:       pos.bearing ?? pos.Bearing,
      speed:         pos.speed   ?? pos.Speed,
      tripId:        vp.trip?.tripId  ?? vp.Trip?.TripId,
      routeId:       vp.trip?.routeId ?? vp.Trip?.RouteId,
      vehicleLabel:  vp.vehicle?.label ?? vp.Vehicle?.Label,
      timestamp:     vp.timestamp ? Number(vp.timestamp) * 1000 : undefined,
      currentStatus: vp.currentStatus,
    }] as BusVehicle[];
  });
}
