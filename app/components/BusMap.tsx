'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { BusVehicle } from '../api/buses/route';
import type { GtfsStop } from '../../lib/gtfs-static';
import type { Arrival } from '../api/trip-updates/route';
import type { ServiceAlert } from '../api/alerts/route';

const SENDAI_CENTER: [number, number] = [38.2682, 140.8694];
const REFRESH_INTERVAL  = 15;
const LERP_DURATION     = 1500;
const DR_CAP_SEC        = 20;
const DR_SPEED_FACTOR   = 0.65;
const STOP_MIN_ZOOM     = 14;   // バス停マーカーを表示する最小ズーム
const ALERT_REFRESH_MS  = 60_000;

let L: typeof import('leaflet') | null = null;

// ── math ──────────────────────────────────────────────────────────────────
function easeOutCubic(t: number) { return 1 - Math.pow(1 - t, 3); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function lerpAngle(a: number, b: number, t: number) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}
function toRad(d: number) { return d * Math.PI / 180; }
function deadReckon(lat: number, lng: number, bear: number, spd: number, t: number): [number, number] {
  const s = Math.min(t, DR_CAP_SEC);
  const d = spd * DR_SPEED_FACTOR * s;
  const b = toRad(bear);
  return [lat + (d * Math.cos(b)) / 111_111,
          lng + (d * Math.sin(b)) / (111_111 * Math.cos(toRad(lat)))];
}

// ── colour per route ──────────────────────────────────────────────────────
function routeHue(routeId?: string) {
  if (!routeId) return 210;
  return Math.abs(routeId.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 360;
}

// ── bus icon ──────────────────────────────────────────────────────────────
function getBusIcon(lf: typeof import('leaflet'), bearing: number, routeId?: string) {
  const h = routeHue(routeId);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <defs><filter id="sh" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.35"/>
    </filter></defs>
    <g transform="rotate(${bearing},16,16)" filter="url(#sh)">
      <polygon points="16,3 20,11 12,11" fill="hsl(${h},85%,38%)"/>
    </g>
    <rect x="8" y="11" width="16" height="13" rx="2.5" fill="hsl(${h},72%,48%)" filter="url(#sh)"/>
    <rect x="10" y="13" width="5" height="3.5" rx="1" fill="white" opacity="0.95"/>
    <rect x="17" y="13" width="5" height="3.5" rx="1" fill="white" opacity="0.95"/>
    <rect x="9" y="23" width="3.5" height="2.5" rx="1" fill="hsl(${h},60%,28%)"/>
    <rect x="19.5" y="23" width="3.5" height="2.5" rx="1" fill="hsl(${h},60%,28%)"/>
  </svg>`;
  return lf.divIcon({ html: svg, className: '', iconSize: [32,32], iconAnchor: [16,16], popupAnchor: [0,-18] });
}

// ── bus stop icon ─────────────────────────────────────────────────────────
function getStopIcon(lf: typeof import('leaflet')) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
    <circle cx="9" cy="9" r="7" fill="#2563eb" stroke="white" stroke-width="2"/>
    <text x="9" y="13" text-anchor="middle" font-size="9" font-weight="bold" fill="white" font-family="sans-serif">S</text>
  </svg>`;
  return lf.divIcon({ html: svg, className: '', iconSize: [18,18], iconAnchor: [9,9], popupAnchor: [0,-12] });
}

// ── popup ─────────────────────────────────────────────────────────────────
function formatTime(ts?: number) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('ja-JP');
}
function buildBusPopup(bus: BusVehicle) {
  const routeDisplay = bus.routeShort
    ? `${bus.routeShort}系統${bus.routeLong ? `<br><span style="font-size:10px;color:#6b7280">${bus.routeLong}</span>` : ''}`
    : (bus.routeId ?? '-');
  const rows: [string,string][] = [
    ['車両',  bus.vehicleLabel ?? bus.id],
    ['路線',  routeDisplay],
    ['行先',  bus.headsign ?? '-'],
    ['速度',  bus.speed  != null ? `${bus.speed} km/h` : '-'],
    ['状態',  bus.currentStatus ?? '-'],
    ['更新',  formatTime(bus.timestamp)],
  ];
  const rowsHtml = rows.map(([l,v]) => `<tr>
    <td style="color:#6b7280;padding:2px 10px 2px 0;font-size:11px;white-space:nowrap">${l}</td>
    <td style="color:#111827;padding:2px 0;font-size:11px;font-weight:600">${v}</td>
  </tr>`).join('');
  return `<div style="background:#fff;border-radius:8px;padding:10px 13px;min-width:190px;
    font-family:system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.15)">
    <div style="font-weight:700;font-size:13px;margin-bottom:7px;color:hsl(${routeHue(bus.routeId)},70%,40%)">🚌 バス情報</div>
    <table style="border-collapse:collapse;width:100%">${rowsHtml}</table>
  </div>`;
}

// ── interfaces ────────────────────────────────────────────────────────────
interface LerpTask {
  fromLat: number; fromLng: number; toLat: number; toLng: number;
  fromBearing: number; toBearing: number; startTime: number;
}
interface DrAnchor {
  lat: number; lng: number; bearingDeg: number; speedMs: number;
  time: number; routeId?: string;
}
interface FetchResult { vehicles: BusVehicle[]; count: number; fetchedAt: number; error?: string; }
interface SelectedStop { id: string; name: string; }

// ── component ─────────────────────────────────────────────────────────────
export default function BusMap() {
  const mapRef        = useRef<import('leaflet').Map | null>(null);
  const markersRef    = useRef<Map<string, import('leaflet').Marker>>(new Map());
  const bearingsRef   = useRef<Map<string, number>>(new Map());
  const containerRef  = useRef<HTMLDivElement>(null);
  const lerpTasksRef  = useRef<Map<string, LerpTask>>(new Map());
  const drRef         = useRef<Map<string, DrAnchor>>(new Map());
  const rafRef        = useRef<number | null>(null);
  const stopLayerRef  = useRef<import('leaflet').LayerGroup | null>(null);

  const drEnabledRef  = useRef(true);
  const countdownRef  = useRef(REFRESH_INTERVAL);
  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status,        setStatus]        = useState<'loading'|'ok'|'error'>('loading');
  const [busCount,      setBusCount]      = useState(0);
  const [lastUpdate,    setLastUpdate]    = useState('');
  const [errorMsg,      setErrorMsg]      = useState('');
  const [countdown,     setCountdown]     = useState(REFRESH_INTERVAL);
  const [drEnabled,     setDrEnabled]     = useState(true);
  const [alerts,        setAlerts]        = useState<ServiceAlert[]>([]);
  const [dismissAlerts, setDismissAlerts] = useState(false);
  const [selectedStop,  setSelectedStop]  = useState<SelectedStop | null>(null);
  const [arrivals,      setArrivals]      = useState<Arrival[]>([]);
  const [approachLoading, setApproachLoading] = useState(false);

  // ── RAF loop ─────────────────────────────────────────────────────────────
  const startRaf = useCallback(() => {
    if (rafRef.current != null) return;
    const loop = () => {
      const now = performance.now();
      let active = false;

      for (const [id, task] of lerpTasksRef.current) {
        const t = Math.min((now - task.startTime) / LERP_DURATION, 1);
        const e = easeOutCubic(t);
        const marker = markersRef.current.get(id);
        if (marker && L) {
          marker.setLatLng([lerp(task.fromLat, task.toLat, e), lerp(task.fromLng, task.toLng, e)]);
          const bearing = lerpAngle(task.fromBearing, task.toBearing, e);
          bearingsRef.current.set(id, bearing);
          marker.setIcon(getBusIcon(L, bearing, drRef.current.get(id)?.routeId));
        }
        if (t < 1) { active = true; }
        else {
          lerpTasksRef.current.delete(id);
          const dr = drRef.current.get(id);
          if (dr) { dr.lat = task.toLat; dr.lng = task.toLng; dr.time = now; }
        }
      }

      if (drEnabledRef.current) {
        for (const [id, dr] of drRef.current) {
          if (lerpTasksRef.current.has(id) || dr.speedMs <= 0) continue;
          const elapsed = (now - dr.time) / 1000;
          if (elapsed >= DR_CAP_SEC) continue;
          markersRef.current.get(id)?.setLatLng(deadReckon(dr.lat, dr.lng, dr.bearingDeg, dr.speedMs, elapsed));
          active = true;
        }
      }

      rafRef.current = active ? requestAnimationFrame(loop) : null;
    };
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  // ── fetch buses ───────────────────────────────────────────────────────────
  const fetchBuses = useCallback(async () => {
    if (!mapRef.current || !L) return;
    try {
      const res  = await fetch('/api/buses', { cache: 'no-store' });
      const data: FetchResult = await res.json();
      if (!res.ok || data.error) { setStatus('error'); setErrorMsg(data.error ?? 'エラー'); return; }

      const lf = L;
      const existingIds = new Set(markersRef.current.keys());

      for (const bus of data.vehicles) {
        const newBearing = bus.bearing ?? 0;
        const newSpeedMs = (bus.speed ?? 0) / 3.6;
        const popup      = buildBusPopup(bus);

        if (markersRef.current.has(bus.id)) {
          const marker      = markersRef.current.get(bus.id)!;
          const cur         = marker.getLatLng();
          const fromBearing = bearingsRef.current.get(bus.id) ?? newBearing;
          drRef.current.set(bus.id, { lat: bus.lat, lng: bus.lon, bearingDeg: newBearing, speedMs: newSpeedMs, time: performance.now(), routeId: bus.routeId });
          lerpTasksRef.current.set(bus.id, { fromLat: cur.lat, fromLng: cur.lng, toLat: bus.lat, toLng: bus.lon, fromBearing, toBearing: newBearing, startTime: performance.now() });
          marker.getPopup()?.setContent(popup);
          existingIds.delete(bus.id);
          startRaf();
        } else {
          const marker = lf.marker([bus.lat, bus.lon], { icon: getBusIcon(lf, newBearing, bus.routeId) })
            .bindPopup(popup, { maxWidth: 280 })
            .addTo(mapRef.current!);
          markersRef.current.set(bus.id, marker);
          bearingsRef.current.set(bus.id, newBearing);
          drRef.current.set(bus.id, { lat: bus.lat, lng: bus.lon, bearingDeg: newBearing, speedMs: newSpeedMs, time: performance.now(), routeId: bus.routeId });
          if (newSpeedMs > 0) startRaf();
        }
      }
      for (const oldId of existingIds) {
        markersRef.current.get(oldId)?.remove();
        markersRef.current.delete(oldId);
        bearingsRef.current.delete(oldId);
        lerpTasksRef.current.delete(oldId);
        drRef.current.delete(oldId);
      }
      setBusCount(data.count);
      setLastUpdate(formatTime(data.fetchedAt));
      setStatus('ok');
      setErrorMsg('');
    } catch (e) {
      setStatus('error');
      setErrorMsg(e instanceof Error ? e.message : 'ネットワークエラー');
    }
  }, [startRaf]);

  // ── fetch stops (GTFS static) ─────────────────────────────────────────────
  const loadStops = useCallback(async (map: import('leaflet').Map, lf: typeof import('leaflet')) => {
    try {
      const res  = await fetch('/api/gtfs-static');
      if (!res.ok) return;
      const data: { stops: GtfsStop[] } = await res.json();

      const layer = lf.layerGroup().addTo(map);
      stopLayerRef.current = layer;
      const stopIcon = getStopIcon(lf);

      for (const stop of data.stops) {
        const marker = lf.marker([stop.lat, stop.lon], { icon: stopIcon })
          .bindTooltip(stop.name, { direction: 'top', offset: [0, -10], opacity: 0.9 });
        marker.on('click', () => {
          setSelectedStop({ id: stop.id, name: stop.name });
        });
        layer.addLayer(marker);
      }

      // ズームに応じて表示切替
      const toggleStops = () => {
        if (map.getZoom() >= STOP_MIN_ZOOM) layer.addTo(map);
        else layer.remove();
      };
      map.on('zoomend', toggleStops);
      toggleStops();
    } catch { /* stops are optional */ }
  }, []);

  // ── fetch approach times ──────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedStop) return;
    setApproachLoading(true);
    setArrivals([]);
    fetch(`/api/trip-updates?stopId=${encodeURIComponent(selectedStop.id)}`)
      .then(r => r.json())
      .then(d => { setArrivals(d.arrivals ?? []); })
      .catch(() => { setArrivals([]); })
      .finally(() => setApproachLoading(false));
  }, [selectedStop]);

  // ── fetch alerts ──────────────────────────────────────────────────────────
  const fetchAlerts = useCallback(async () => {
    try {
      const r = await fetch('/api/alerts');
      const d = await r.json();
      if (d.alerts?.length) { setAlerts(d.alerts); setDismissAlerts(false); }
    } catch { /* ignore */ }
  }, []);

  // ── map init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    (async () => {
      const lf = await import('leaflet');
      L = lf;
      const map = lf.map(containerRef.current!, { center: SENDAI_CENTER, zoom: 13 });
      lf.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      mapRef.current = map;
      await fetchBuses();
      await loadStops(map, lf);
      await fetchAlerts();
    })();
  }, [fetchBuses, loadStops, fetchAlerts]);

  // ── countdown + auto-refresh ──────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      countdownRef.current -= 1;
      setCountdown(countdownRef.current);
      if (countdownRef.current <= 0) { countdownRef.current = REFRESH_INTERVAL; fetchBuses(); }
      timerRef.current = setTimeout(tick, 1000);
    };
    timerRef.current = setTimeout(tick, 1000);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [fetchBuses]);

  // ── alert periodic refresh ────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(fetchAlerts, ALERT_REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchAlerts]);

  const handleRefresh = () => {
    countdownRef.current = REFRESH_INTERVAL;
    setCountdown(REFRESH_INTERVAL);
    setStatus('loading');
    fetchBuses();
  };

  const handleToggleDr = () => {
    const next = !drEnabledRef.current;
    drEnabledRef.current = next;
    setDrEnabled(next);
    if (!next) {
      for (const [id, dr] of drRef.current) markersRef.current.get(id)?.setLatLng([dr.lat, dr.lng]);
    } else {
      const now = performance.now();
      for (const dr of drRef.current.values()) dr.time = now;
      startRaf();
    }
  };

  // ── relative time helper ──────────────────────────────────────────────────
  function relTime(ms: number) {
    const diff = Math.round((ms - Date.now()) / 1000);
    if (diff <= 0)  return 'まもなく';
    if (diff < 60)  return `約${diff}秒後`;
    return `約${Math.round(diff / 60)}分後`;
  }

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />

      {/* ── alert banner ── */}
      {alerts.length > 0 && !dismissAlerts && (
        <div className="absolute top-0 left-0 right-0 z-[1100] bg-amber-50 border-b border-amber-300 px-4 py-2 flex items-start gap-3">
          <span className="text-amber-600 text-sm mt-0.5">⚠️</span>
          <div className="flex-1 text-xs text-amber-800 space-y-0.5">
            {alerts.map(a => (
              <div key={a.id}><span className="font-bold">[{a.effect}]</span> {a.header}</div>
            ))}
          </div>
          <button onClick={() => setDismissAlerts(true)} className="text-amber-500 hover:text-amber-700 text-sm leading-none">✕</button>
        </div>
      )}

      {/* ── header ── */}
      <div className={`absolute left-1/2 -translate-x-1/2 z-[1000] pointer-events-none ${alerts.length > 0 && !dismissAlerts ? 'top-10' : 'top-3'}`}>
        <div className="bg-white/92 backdrop-blur-sm text-gray-800 rounded-xl px-5 py-2.5 shadow-lg
                        flex items-center gap-4 pointer-events-auto border border-gray-200">
          <div className="flex items-center gap-2">
            <span className="text-xl">🚌</span>
            <div>
              <div className="text-sm font-bold leading-tight text-gray-900">仙台市バス リアルタイムマップ</div>
              <div className="text-[10px] text-gray-500 leading-tight">Sendai Municipal Bus Live Tracker</div>
            </div>
          </div>
          <div className="h-8 w-px bg-gray-200" />
          {status === 'loading' && (
            <div className="flex items-center gap-1.5 text-blue-500 text-xs">
              <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
              取得中...
            </div>
          )}
          {status === 'ok' && (
            <div className="text-xs flex flex-col items-end">
              <span className="text-green-600 font-semibold">{busCount} 台運行中</span>
              <span className="text-[10px] text-gray-400">更新: {lastUpdate}</span>
            </div>
          )}
          {status === 'error' && (
            <div className="text-xs text-red-500 max-w-[180px] truncate">{errorMsg}</div>
          )}
        </div>
      </div>

      {/* ── bottom-right controls ── */}
      <div className="absolute bottom-6 right-3 z-[1000] flex flex-col gap-2 items-end">
        <button onClick={handleRefresh}
          className="bg-white/92 backdrop-blur-sm text-gray-700 text-xs rounded-lg px-3 py-2
                     shadow-md hover:bg-white transition flex items-center gap-1.5 border border-gray-200">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
          今すぐ更新
        </button>
        <button onClick={handleToggleDr}
          className={`backdrop-blur-sm text-xs rounded-lg px-3 py-2 shadow-md transition
                      flex items-center gap-1.5 border
                      ${drEnabled ? 'bg-blue-500 text-white border-blue-400 hover:bg-blue-600'
                                  : 'bg-white/92 text-gray-500 border-gray-200 hover:bg-white'}`}>
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/>
          </svg>
          推算移動: {drEnabled ? 'ON' : 'OFF'}
        </button>
        <div className="bg-white/85 backdrop-blur-sm text-gray-500 text-[11px] rounded-lg px-3 py-1.5 shadow border border-gray-100">
          次回更新: {countdown}秒後
        </div>
        <div className="bg-white/80 backdrop-blur-sm text-gray-400 text-[10px] rounded-lg px-3 py-1.5 shadow border border-gray-100 leading-relaxed">
          <div>データ: ODPT 仙台市交通局 · 15秒更新</div>
          <div className="text-blue-400">🔵 ズーム14以上でバス停表示</div>
        </div>
      </div>

      {/* ── approach panel ── */}
      {selectedStop && (
        <div className="absolute bottom-0 left-0 right-0 z-[1050]
                        bg-white border-t border-gray-200 shadow-2xl rounded-t-2xl
                        max-h-[55vh] flex flex-col">
          {/* panel header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <span className="text-blue-500 text-lg">🚏</span>
              <div>
                <div className="font-bold text-gray-900 text-sm">{selectedStop.name}</div>
                <div className="text-[10px] text-gray-400">次のバス</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setSelectedStop(null); setArrivals([]); }}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none px-1">✕</button>
            </div>
          </div>

          {/* arrival list */}
          <div className="overflow-y-auto flex-1 divide-y divide-gray-50">
            {approachLoading && (
              <div className="flex items-center justify-center py-8 text-gray-400 text-sm gap-2">
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                取得中...
              </div>
            )}
            {!approachLoading && arrivals.length === 0 && (
              <div className="text-center py-8 text-gray-400 text-sm">
                接近中のバスはありません
              </div>
            )}
            {!approachLoading && arrivals.map((arr, i) => {
              const hue = routeHue(arr.routeId);
              return (
                <div key={i} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
                  {/* route badge */}
                  <div className="rounded-lg px-2.5 py-1 text-white text-xs font-bold min-w-[52px] text-center"
                       style={{ background: `hsl(${hue},65%,48%)` }}>
                    {arr.routeName}
                  </div>
                  {/* destination */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-800 truncate">
                      {arr.headsign || arr.routeLong || '-'}
                    </div>
                    {arr.routeLong && arr.headsign && (
                      <div className="text-[10px] text-gray-400 truncate">{arr.routeLong}</div>
                    )}
                  </div>
                  {/* arrival time */}
                  <div className="text-right flex-shrink-0">
                    <div className={`text-sm font-bold ${arr.delay > 60 ? 'text-red-500' : 'text-blue-600'}`}>
                      {relTime(arr.arrivalTime)}
                    </div>
                    <div className="text-[10px] text-gray-400">
                      {new Date(arr.arrivalTime).toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' })}
                      {arr.delay > 0 && <span className="text-red-400 ml-1">+{Math.round(arr.delay/60)}分遅</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
