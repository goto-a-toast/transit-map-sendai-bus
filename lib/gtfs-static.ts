import JSZip from 'jszip';

export interface GtfsRoute {
  shortName: string;
  longName:  string;
}
export interface GtfsStop {
  id:   string;
  name: string;
  lat:  number;
  lon:  number;
}
export interface GtfsTrip {
  routeId:  string;
  headsign: string;
}
export interface GtfsStaticData {
  routes: Record<string, GtfsRoute>;
  stops:  GtfsStop[];
  trips:  Record<string, GtfsTrip>;
}

// module-level cache
let cache:    GtfsStaticData | null = null;
let cachedAt  = 0;
const CACHE_TTL = 60 * 60 * 1000;

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '', inQ = false;
  for (const c of line) {
    if (c === '"')            { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else                        { cur += c; }
  }
  result.push(cur.trim());
  return result;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(l => {
    const vals = parseCsvLine(l);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
  });
}

export async function getGtfsStaticCached(apiKey: string): Promise<GtfsStaticData> {
  if (cache && Date.now() - cachedAt < CACHE_TTL) return cache;

  const url = `https://api-public.odpt.org/api/v4/gtfs/static/odpt_SendaiMunicipal_bus?acl:consumerKey=${apiKey}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`GTFS static: ${res.status} ${res.statusText}`);

  const zip = await JSZip.loadAsync(await res.arrayBuffer());

  const routes: Record<string, GtfsRoute> = {};
  const rf = zip.file('routes.txt');
  if (rf) {
    for (const row of parseCsv(await rf.async('text'))) {
      if (!row.route_id) continue;
      routes[row.route_id] = { shortName: row.route_short_name ?? '', longName: row.route_long_name ?? '' };
    }
  }

  const stops: GtfsStop[] = [];
  const sf = zip.file('stops.txt');
  if (sf) {
    for (const row of parseCsv(await sf.async('text'))) {
      const lat = parseFloat(row.stop_lat), lon = parseFloat(row.stop_lon);
      if (!row.stop_id || isNaN(lat) || isNaN(lon)) continue;
      stops.push({ id: row.stop_id, name: row.stop_name ?? row.stop_id, lat, lon });
    }
  }

  const trips: Record<string, GtfsTrip> = {};
  const tf = zip.file('trips.txt');
  if (tf) {
    for (const row of parseCsv(await tf.async('text'))) {
      if (!row.trip_id) continue;
      trips[row.trip_id] = { routeId: row.route_id ?? '', headsign: row.trip_headsign ?? '' };
    }
  }

  cache = { routes, stops, trips };
  cachedAt = Date.now();
  return cache;
}
