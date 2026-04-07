import { NextResponse } from 'next/server';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

export const runtime = 'nodejs';
export const revalidate = 0;

export interface BusVehicle {
  id: string;
  lat: number;
  lon: number;
  bearing?: number;
  speed?: number;
  tripId?: string;
  routeId?: string;
  vehicleLabel?: string;
  timestamp?: number;
  currentStatus?: string;
  congestionLevel?: string;
}

const STATUS_LABELS: Record<number, string> = {
  0: '停車中',
  1: '到着',
  2: '走行中',
};

export async function GET() {
  const apiKey = process.env.ODPT_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'APIキーが設定されていません' }, { status: 500 });
  }

  const endpoint =
    'https://api-public.odpt.org/api/v4/gtfs/realtime/odpt_SendaiMunicipal_bus_realtime_information_vehicle';
  const url = `${endpoint}?acl:consumerKey=${apiKey}`;

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/x-protobuf, application/octet-stream, */*' },
      cache: 'no-store',
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `APIエラー: ${response.status} ${response.statusText}` },
        { status: response.status }
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let vehicles: BusVehicle[] = [];

    // JSON レスポンスの場合
    if (contentType.includes('json')) {
      const json = JSON.parse(buffer.toString('utf-8'));
      vehicles = parseJsonResponse(json);
    } else {
      // GTFS-RT Protobuf の場合
      try {
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
        vehicles = parseProtobufFeed(feed);
      } catch {
        // フォールバック: JSON としてパース
        try {
          const json = JSON.parse(buffer.toString('utf-8'));
          vehicles = parseJsonResponse(json);
        } catch {
          return NextResponse.json(
            { error: 'レスポンスのパースに失敗しました' },
            { status: 500 }
          );
        }
      }
    }

    return NextResponse.json({
      vehicles,
      count: vehicles.length,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '不明なエラー';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function parseProtobufFeed(
  feed: GtfsRealtimeBindings.transit_realtime.FeedMessage
): BusVehicle[] {
  const vehicles: BusVehicle[] = [];

  for (const entity of feed.entity) {
    const vp = entity.vehicle;
    if (!vp || !vp.position) continue;

    const lat = vp.position.latitude;
    const lon = vp.position.longitude;
    if (!lat || !lon) continue;

    const statusNum =
      vp.currentStatus != null
        ? (vp.currentStatus as unknown as number)
        : undefined;

    vehicles.push({
      id: entity.id,
      lat,
      lon,
      bearing: vp.position.bearing ?? undefined,
      speed: vp.position.speed != null ? Math.round((vp.position.speed ?? 0) * 3.6) : undefined, // m/s → km/h
      tripId: vp.trip?.tripId ?? undefined,
      routeId: vp.trip?.routeId ?? undefined,
      vehicleLabel: vp.vehicle?.label ?? undefined,
      timestamp: vp.timestamp != null ? Number(vp.timestamp) * 1000 : undefined,
      currentStatus: statusNum != null ? STATUS_LABELS[statusNum] : undefined,
    });
  }

  return vehicles;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJsonResponse(json: any): BusVehicle[] {
  if (!Array.isArray(json)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return json.flatMap((entity: any) => {
    const vp = entity.vehicle ?? entity;
    const pos = vp?.position ?? vp?.Position;
    if (!pos) return [];
    const lat = pos.latitude ?? pos.Latitude;
    const lon = pos.longitude ?? pos.Longitude;
    if (!lat || !lon) return [];
    return [
      {
        id: entity.id ?? entity.Id ?? String(Math.random()),
        lat,
        lon,
        bearing: pos.bearing ?? pos.Bearing,
        speed: pos.speed ?? pos.Speed,
        routeId: vp.trip?.routeId ?? vp.Trip?.RouteId,
        tripId: vp.trip?.tripId ?? vp.Trip?.TripId,
        vehicleLabel: vp.vehicle?.label ?? vp.Vehicle?.Label,
        timestamp: vp.timestamp ? Number(vp.timestamp) * 1000 : undefined,
        currentStatus: vp.currentStatus,
      },
    ] as BusVehicle[];
  });
}
