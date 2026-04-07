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
  routeName?: string;
  vehicleLabel?: string;
  timestamp?: number;
  currentStatus?: string;
}

// GTFS-RT VehicleStopStatus の正しいマッピング
// 0 = INCOMING_AT, 1 = STOPPED_AT, 2 = IN_TRANSIT_TO
const STATUS_LABELS: Record<number, string> = {
  0: '接近中',
  1: '停車中',
  2: '走行中',
};

// 路線名キャッシュ (サーバープロセスの生存期間中保持)
let routeNameCache: Map<string, string> | null = null;
let routeNameCachedAt = 0;
const ROUTE_CACHE_TTL = 60 * 60 * 1000; // 1時間

async function getRouteNames(apiKey: string): Promise<Map<string, string>> {
  if (routeNameCache && Date.now() - routeNameCachedAt < ROUTE_CACHE_TTL) {
    return routeNameCache;
  }

  const map = new Map<string, string>();
  try {
    // ODPT JSON API から仙台市バスの路線情報を取得
    const url = `https://api-public.odpt.org/api/v4/odpt:BusroutePattern?odpt:operator=odpt.Operator:SendaiMunicipal&acl:consumerKey=${apiKey}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return map;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patterns: any[] = await res.json();
    for (const p of patterns) {
      // owl:sameAs 例: "odpt.BusroutePattern:SendaiMunicipal.101.1"
      const sameAs: string = p['owl:sameAs'] ?? '';
      // GTFS route_id は末尾の数字部分 (e.g. "101") に対応することが多い
      const match = sameAs.match(/\.(\d+)\.\d+$/);
      if (!match) continue;
      const routeId = match[1];
      // dc:title または odpt:busrouteName を優先
      const name: string =
        p['dc:title'] ?? p['odpt:busrouteName'] ?? p['odpt:kana'] ?? '';
      if (name && !map.has(routeId)) {
        map.set(routeId, name);
      }
    }
  } catch {
    // 取得失敗時はキャッシュなしで続行
  }

  routeNameCache = map;
  routeNameCachedAt = Date.now();
  return map;
}

export async function GET() {
  const apiKey = process.env.ODPT_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'APIキーが設定されていません' }, { status: 500 });
  }

  // 路線名と車両位置を並行取得
  const [routeNames, vehicleRes] = await Promise.all([
    getRouteNames(apiKey),
    fetch(
      `https://api-public.odpt.org/api/v4/gtfs/realtime/odpt_SendaiMunicipal_bus_realtime_information_vehicle?acl:consumerKey=${apiKey}`,
      { headers: { Accept: 'application/x-protobuf, application/octet-stream, */*' }, cache: 'no-store' }
    ).catch(() => null),
  ]);

  if (!vehicleRes || !vehicleRes.ok) {
    const status = vehicleRes?.status ?? 500;
    const text   = vehicleRes?.statusText ?? '不明なエラー';
    return NextResponse.json({ error: `APIエラー: ${status} ${text}` }, { status });
  }

  try {
    const contentType  = vehicleRes.headers.get('content-type') ?? '';
    const arrayBuffer  = await vehicleRes.arrayBuffer();
    const buffer       = Buffer.from(arrayBuffer);
    let vehicles: BusVehicle[] = [];

    if (contentType.includes('json')) {
      vehicles = parseJsonResponse(JSON.parse(buffer.toString('utf-8')), routeNames);
    } else {
      try {
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
        vehicles = parseProtobufFeed(feed, routeNames);
      } catch {
        try {
          vehicles = parseJsonResponse(JSON.parse(buffer.toString('utf-8')), routeNames);
        } catch {
          return NextResponse.json({ error: 'レスポンスのパースに失敗しました' }, { status: 500 });
        }
      }
    }

    return NextResponse.json({ vehicles, count: vehicles.length, fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : '不明なエラー' }, { status: 500 });
  }
}

function parseProtobufFeed(
  feed: GtfsRealtimeBindings.transit_realtime.FeedMessage,
  routeNames: Map<string, string>,
): BusVehicle[] {
  const vehicles: BusVehicle[] = [];

  for (const entity of feed.entity) {
    const vp = entity.vehicle;
    if (!vp?.position) continue;
    const { latitude: lat, longitude: lon } = vp.position;
    if (!lat || !lon) continue;

    const statusNum = vp.currentStatus != null ? (vp.currentStatus as unknown as number) : undefined;
    const routeId   = vp.trip?.routeId ?? undefined;

    vehicles.push({
      id: entity.id,
      lat,
      lon,
      bearing:       vp.position.bearing ?? undefined,
      speed:         vp.position.speed != null ? Math.round(vp.position.speed * 3.6) : undefined,
      tripId:        vp.trip?.tripId ?? undefined,
      routeId,
      routeName:     routeId ? (routeNames.get(routeId) ?? formatRouteId(routeId)) : undefined,
      vehicleLabel:  vp.vehicle?.label ?? undefined,
      timestamp:     vp.timestamp != null ? Number(vp.timestamp) * 1000 : undefined,
      currentStatus: statusNum != null ? STATUS_LABELS[statusNum] : undefined,
    });
  }

  return vehicles;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJsonResponse(json: any, routeNames: Map<string, string>): BusVehicle[] {
  if (!Array.isArray(json)) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return json.flatMap((entity: any) => {
    const vp  = entity.vehicle ?? entity;
    const pos = vp?.position ?? vp?.Position;
    if (!pos) return [];
    const lat = pos.latitude  ?? pos.Latitude;
    const lon = pos.longitude ?? pos.Longitude;
    if (!lat || !lon) return [];
    const routeId = vp.trip?.routeId ?? vp.Trip?.RouteId;
    return [{
      id:            entity.id ?? entity.Id ?? String(Math.random()),
      lat, lon,
      bearing:       pos.bearing  ?? pos.Bearing,
      speed:         pos.speed    ?? pos.Speed,
      routeId,
      routeName:     routeId ? (routeNames.get(routeId) ?? formatRouteId(routeId)) : undefined,
      tripId:        vp.trip?.tripId    ?? vp.Trip?.TripId,
      vehicleLabel:  vp.vehicle?.label  ?? vp.Vehicle?.Label,
      timestamp:     vp.timestamp ? Number(vp.timestamp) * 1000 : undefined,
      currentStatus: vp.currentStatus,
    }] as BusVehicle[];
  });
}

/** ODPT APIで名称が取れなかった場合のフォールバック表示 */
function formatRouteId(id: string): string {
  if (/^\d+$/.test(id)) return `${id}系統`;
  // "odpt.BusroutePattern:SendaiMunicipal.101.1" のような形式
  const m = id.match(/\.(\d+)(?:\.\d+)?$/);
  if (m) return `${m[1]}系統`;
  return id;
}
