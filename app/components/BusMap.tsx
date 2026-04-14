'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { BusVehicle } from '../api/buses/route';
import type { ServiceAlert } from '../api/alerts/route';

const SENDAI_CENTER: [number, number] = [38.2682, 140.8694];
const REFRESH_INTERVAL = 15;
const LERP_DURATION    = 1500;
const DR_CAP_SEC       = 20;
const DR_SPEED_FACTOR  = 0.65;

let L: typeof import('leaflet') | null = null;

// ── math ──────────────────────────────────────────────────────────────────
function easeOutCubic(t: number) { return 1 - Math.pow(1 - t, 3); }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function lerpAngle(a: number, b: number, t: number) {
  return (a + (((b - a + 540) % 360) - 180) * t + 360) % 360;
}
function toRad(d: number) { return d * Math.PI / 180; }
function deadReckon(lat: number, lng: number, bear: number, spd: number, t: number): [number, number] {
  const s = Math.min(t, DR_CAP_SEC);
  const d = spd * DR_SPEED_FACTOR * s;
  const b = toRad(bear);
  return [
    lat + (d * Math.cos(b)) / 111_111,
    lng + (d * Math.sin(b)) / (111_111 * Math.cos(toRad(lat))),
  ];
}

// ── route colour & name ───────────────────────────────────────────────────

// Extract the short route number from a raw ID.
// tripId format:  "10_1_1100029012:56:0020260414" → "10"
// routeId format: "odpt.Route:SendaiMunicipal.10" → "10"
function extractRouteNum(id?: string): string {
  if (!id) return '';
  const firstSeg = id.split('_')[0];
  if (/^\d{1,3}$/.test(firstSeg)) return firstSeg;
  const parts = id.split(/[.:]/);
  return parts[parts.length - 1] ?? id;
}

function routeHue(routeId?: string, tripId?: string): number {
  const key = routeId ? extractRouteNum(routeId) : extractRouteNum(tripId);
  if (!key) return 210;
  return Math.abs(key.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 360;
}

function routeLabel(routeId?: string, tripId?: string): string {
  const num = routeId ? extractRouteNum(routeId) : extractRouteNum(tripId);
  return num ? `${num}系統` : '-';
}

// ── bus icon ─────────────────────────────────────────────────────────────
function getBusIcon(
  lf: typeof import('leaflet'),
  bearing: number,
  routeId?: string,
  tripId?: string,
  delay = 0,
) {
  const h = routeHue(routeId, tripId);
  // Delay indicator dot at top-right corner of the 32×32 icon
  const delayDot = delay >= 180
    ? `<circle cx="26" cy="6" r="5" fill="#ef4444" stroke="white" stroke-width="1.5"/>`
    : delay >= 60
    ? `<circle cx="26" cy="6" r="5" fill="#f59e0b" stroke="white" stroke-width="1.5"/>`
    : '';
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
    ${delayDot}
  </svg>`;
  return lf.divIcon({ html: svg, className: '', iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -18] });
}

// ── time formatting ───────────────────────────────────────────────────────
function formatTime(ts?: number) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('ja-JP');
}
function formatHM(ts: number) {
  return new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

// ── internal types ────────────────────────────────────────────────────────
interface LerpTask {
  fromLat: number; fromLng: number; toLat: number; toLng: number;
  fromBearing: number; toBearing: number; startTime: number;
}
interface DrAnchor {
  lat: number; lng: number; bearingDeg: number; speedMs: number;
  time: number; routeId?: string; tripId?: string;
}
interface FetchResult { vehicles: BusVehicle[]; count: number; fetchedAt: number; error?: string; }

interface TripStop {
  stopId:      string;
  arrivalTime: number;
  delay:       number;
  isTerminal:  boolean;
}
interface SelectedBus { bus: BusVehicle; stops: TripStop[] | null; error?: string; }

// ── component ─────────────────────────────────────────────────────────────
export default function BusMap() {
  const mapRef        = useRef<import('leaflet').Map | null>(null);
  const markersRef    = useRef<Map<string, import('leaflet').Marker>>(new Map());
  const bearingsRef   = useRef<Map<string, number>>(new Map());
  const busDataRef    = useRef<Map<string, BusVehicle>>(new Map());
  const containerRef  = useRef<HTMLDivElement>(null);
  const lerpRef       = useRef<Map<string, LerpTask>>(new Map());
  const drRef         = useRef<Map<string, DrAnchor>>(new Map());
  const rafRef        = useRef<number | null>(null);
  const drEnabledRef  = useRef(false);
  const countdownRef  = useRef(REFRESH_INTERVAL);
  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delayMapRef   = useRef<Record<string, number>>({});
  const selBusIdRef   = useRef<string | null>(null);

  const [status,        setStatus]        = useState<'loading' | 'ok' | 'error'>('loading');
  const [busCount,      setBusCount]      = useState(0);
  const [lastUpdate,    setLastUpdate]    = useState('');
  const [errorMsg,      setErrorMsg]      = useState('');
  const [countdown,     setCountdown]     = useState(REFRESH_INTERVAL);
  const [drEnabled,     setDrEnabled]     = useState(false);
  const [alerts,        setAlerts]        = useState<ServiceAlert[]>([]);
  const [dismissAlerts, setDismissAlerts] = useState(false);
  const [selectedBus,   setSelectedBus]   = useState<SelectedBus | null>(null);

  // ── RAF loop ──────────────────────────────────────────────────────────
  const startRaf = useCallback(() => {
    if (rafRef.current != null) return;
    const loop = () => {
      const now = performance.now();
      let active = false;

      for (const [id, task] of lerpRef.current) {
        const t = Math.min((now - task.startTime) / LERP_DURATION, 1);
        const e = easeOutCubic(t);
        const marker = markersRef.current.get(id);
        if (marker && L) {
          marker.setLatLng([lerp(task.fromLat, task.toLat, e), lerp(task.fromLng, task.toLng, e)]);
          const bearing = lerpAngle(task.fromBearing, task.toBearing, e);
          bearingsRef.current.set(id, bearing);
          const dr    = drRef.current.get(id);
          const delay = delayMapRef.current[dr?.tripId ?? ''] ?? 0;
          marker.setIcon(getBusIcon(L, bearing, dr?.routeId, dr?.tripId, delay));
        }
        if (t < 1) { active = true; }
        else {
          lerpRef.current.delete(id);
          const dr = drRef.current.get(id);
          if (dr) { dr.lat = task.toLat; dr.lng = task.toLng; dr.time = now; }
        }
      }

      if (drEnabledRef.current) {
        for (const [id, dr] of drRef.current) {
          if (lerpRef.current.has(id) || dr.speedMs <= 0) continue;
          const elapsed = (now - dr.time) / 1000;
          if (elapsed >= DR_CAP_SEC) continue;
          markersRef.current.get(id)?.setLatLng(
            deadReckon(dr.lat, dr.lng, dr.bearingDeg, dr.speedMs, elapsed)
          );
          active = true;
        }
      }

      rafRef.current = active ? requestAnimationFrame(loop) : null;
    };
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  // ── fetch trip stops (for click panel) ───────────────────────────────
  const fetchTripStops = useCallback(async (bus: BusVehicle) => {
    selBusIdRef.current = bus.id;
    setSelectedBus({ bus, stops: null });

    if (!bus.tripId) {
      setSelectedBus({ bus, stops: [], error: 'tripId なし' });
      return;
    }

    try {
      const res  = await fetch(`/api/trip-stops?tripId=${encodeURIComponent(bus.tripId)}`);
      const data: { stops?: TripStop[]; error?: string } = await res.json();
      if (selBusIdRef.current !== bus.id) return; // superseded by newer click
      if (data.error) {
        setSelectedBus({ bus, stops: [], error: data.error });
      } else {
        setSelectedBus({ bus, stops: data.stops ?? [] });
      }
    } catch {
      if (selBusIdRef.current !== bus.id) return;
      setSelectedBus({ bus, stops: [], error: 'ネットワークエラー' });
    }
  }, []);

  // ── fetch buses ───────────────────────────────────────────────────────
  const fetchBuses = useCallback(async () => {
    if (!mapRef.current || !L) return;
    try {
      const [busRes, delayRes] = await Promise.all([
        fetch('/api/buses',       { cache: 'no-store' }),
        fetch('/api/trip-delays', { cache: 'no-store' }).catch(() => null),
      ]);
      const data: FetchResult = await busRes.json();
      if (!busRes.ok || data.error) { setStatus('error'); setErrorMsg(data.error ?? 'エラー'); return; }

      if (delayRes?.ok) {
        const dd = await delayRes.json().catch(() => null);
        if (dd?.delays) delayMapRef.current = dd.delays;
      }

      const lf          = L;
      const existingIds = new Set(markersRef.current.keys());

      for (const bus of data.vehicles) {
        const newBearing = bus.bearing  ?? 0;
        const newSpeedMs = (bus.speed ?? 0) / 3.6;
        const delay      = delayMapRef.current[bus.tripId ?? ''] ?? 0;
        busDataRef.current.set(bus.id, bus);

        if (markersRef.current.has(bus.id)) {
          const marker      = markersRef.current.get(bus.id)!;
          const cur         = marker.getLatLng();
          const fromBearing = bearingsRef.current.get(bus.id) ?? newBearing;
          drRef.current.set(bus.id, {
            lat: bus.lat, lng: bus.lon, bearingDeg: newBearing,
            speedMs: newSpeedMs, time: performance.now(), routeId: bus.routeId, tripId: bus.tripId,
          });
          lerpRef.current.set(bus.id, {
            fromLat: cur.lat, fromLng: cur.lng, toLat: bus.lat, toLng: bus.lon,
            fromBearing, toBearing: newBearing, startTime: performance.now(),
          });
          // Update icon immediately to reflect new delay color
          marker.setIcon(getBusIcon(lf, fromBearing, bus.routeId, bus.tripId, delay));
          existingIds.delete(bus.id);
          startRaf();
        } else {
          const icon   = getBusIcon(lf, newBearing, bus.routeId, bus.tripId, delay);
          const marker = lf.marker([bus.lat, bus.lon], { icon })
            .on('click', () => {
              fetchTripStops(busDataRef.current.get(bus.id) ?? bus);
            })
            .addTo(mapRef.current!);
          markersRef.current.set(bus.id, marker);
          bearingsRef.current.set(bus.id, newBearing);
          drRef.current.set(bus.id, {
            lat: bus.lat, lng: bus.lon, bearingDeg: newBearing,
            speedMs: newSpeedMs, time: performance.now(), routeId: bus.routeId, tripId: bus.tripId,
          });
          if (newSpeedMs > 0) startRaf();
        }
      }

      for (const oldId of existingIds) {
        markersRef.current.get(oldId)?.remove();
        markersRef.current.delete(oldId);
        bearingsRef.current.delete(oldId);
        busDataRef.current.delete(oldId);
        lerpRef.current.delete(oldId);
        drRef.current.delete(oldId);
        // Close panel if the selected bus has left the feed
        if (selBusIdRef.current === oldId) {
          setSelectedBus(null);
          selBusIdRef.current = null;
        }
      }

      setBusCount(data.count);
      setLastUpdate(formatTime(data.fetchedAt));
      setStatus('ok');
      setErrorMsg('');
    } catch (e) {
      setStatus('error');
      setErrorMsg(e instanceof Error ? e.message : 'ネットワークエラー');
    }
  }, [startRaf, fetchTripStops]);

  // ── fetch alerts ──────────────────────────────────────────────────────
  const fetchAlerts = useCallback(async () => {
    try {
      const r = await fetch('/api/alerts');
      const d = await r.json();
      if (d.alerts?.length) { setAlerts(d.alerts); setDismissAlerts(false); }
      else                  { setAlerts([]); }
    } catch { /* ignore */ }
  }, []);

  // ── map init ──────────────────────────────────────────────────────────
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
      fetchAlerts();
    })();
  }, [fetchBuses, fetchAlerts]);

  // ── countdown ─────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      countdownRef.current -= 1;
      setCountdown(countdownRef.current);
      if (countdownRef.current <= 0) {
        countdownRef.current = REFRESH_INTERVAL;
        fetchBuses();
      }
      timerRef.current = setTimeout(tick, 1000);
    };
    timerRef.current = setTimeout(tick, 1000);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [fetchBuses]);

  // ── alert refresh ─────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(fetchAlerts, 60_000);
    return () => clearInterval(id);
  }, [fetchAlerts]);

  // ── handlers ──────────────────────────────────────────────────────────
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
      for (const [id, dr] of drRef.current)
        markersRef.current.get(id)?.setLatLng([dr.lat, dr.lng]);
    } else {
      const now = performance.now();
      for (const dr of drRef.current.values()) dr.time = now;
      startRaf();
    }
  };

  const closePanel = () => {
    setSelectedBus(null);
    selBusIdRef.current = null;
  };

  const alertOffset = alerts.length > 0 && !dismissAlerts;

  // ── render ────────────────────────────────────────────────────────────
  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />

      {/* alert banner */}
      {alertOffset && (
        <div className="absolute top-0 left-0 right-0 z-[1100]
                        bg-amber-50 border-b border-amber-200 px-4 py-2
                        flex items-start gap-3">
          <span className="text-amber-500 text-sm mt-0.5 flex-shrink-0">⚠️</span>
          <div className="flex-1 text-xs text-amber-800 space-y-0.5">
            {alerts.map(a => (
              <div key={a.id}>
                <span className="font-bold">[{a.effect}]</span> {a.header}
              </div>
            ))}
          </div>
          <button onClick={() => setDismissAlerts(true)}
            className="text-amber-400 hover:text-amber-600 text-sm flex-shrink-0">✕</button>
        </div>
      )}

      {/* header */}
      <div className={`absolute left-1/2 -translate-x-1/2 z-[1000] pointer-events-none
                       ${alertOffset ? 'top-10' : 'top-3'}`}>
        <div className="bg-white/92 backdrop-blur-sm rounded-xl px-5 py-2.5 shadow-lg
                        flex items-center gap-4 pointer-events-auto border border-gray-200">
          <div className="flex items-center gap-2">
            <span className="text-xl">🚌</span>
            <div>
              <div className="text-sm font-bold text-gray-900 leading-tight">仙台市バス リアルタイムマップ</div>
              <div className="text-[10px] text-gray-400 leading-tight">Sendai Municipal Bus Live Tracker</div>
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

      {/* bus detail panel */}
      {selectedBus && (
        <div className="absolute bottom-6 left-3 z-[1100]
                        bg-white/96 backdrop-blur-sm rounded-xl shadow-xl
                        border border-gray-200 w-64 flex flex-col overflow-hidden
                        max-h-[calc(100%-80px)]">
          {/* panel header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100"
               style={{ borderLeft: `3px solid hsl(${routeHue(selectedBus.bus.routeId, selectedBus.bus.tripId)},72%,48%)` }}>
            <div className="min-w-0">
              <div className="font-bold text-sm text-gray-900">
                {routeLabel(selectedBus.bus.routeId, selectedBus.bus.tripId)}
              </div>
              <div className="text-xs text-gray-400 truncate">
                {selectedBus.bus.vehicleLabel ?? selectedBus.bus.id}
                {selectedBus.bus.currentStatus && ` · ${selectedBus.bus.currentStatus}`}
              </div>
            </div>
            <button onClick={closePanel}
              className="ml-2 flex-shrink-0 text-gray-400 hover:text-gray-600 text-lg leading-none"
              aria-label="閉じる">✕</button>
          </div>

          {/* stops list */}
          <div className="overflow-y-auto flex-1 py-1">
            {selectedBus.stops === null && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-gray-400">
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                </svg>
                読み込み中...
              </div>
            )}
            {selectedBus.stops !== null && selectedBus.stops.length === 0 && (
              <div className="text-center py-6 text-xs text-gray-400">
                {selectedBus.error ?? '停車予定なし'}
              </div>
            )}
            {selectedBus.stops !== null && selectedBus.stops.length > 0 && (
              <table className="w-full text-xs">
                <tbody>
                  {selectedBus.stops.map((stop, i) => (
                    <tr key={`${stop.stopId}-${i}`}
                        className={`border-b border-gray-50 last:border-0
                                    ${stop.isTerminal ? 'bg-blue-50/70' : 'hover:bg-gray-50'}`}>
                      <td className="pl-3 pr-1 py-1.5 text-gray-300 w-5 text-right tabular-nums">{i + 1}</td>
                      <td className="px-2 py-1.5 font-mono font-semibold text-gray-800 whitespace-nowrap tabular-nums">
                        {formatHM(stop.arrivalTime)}
                      </td>
                      <td className="px-1 py-1.5 text-gray-400 text-[11px]">
                        {stop.isTerminal && <span className="text-blue-500 font-medium mr-0.5">終点</span>}
                        #{stop.stopId.split('_')[0]}
                      </td>
                      <td className="pr-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                        {stop.delay >= 180 ? (
                          <span className="text-red-500 font-medium">+{Math.round(stop.delay / 60)}分</span>
                        ) : stop.delay >= 60 ? (
                          <span className="text-amber-500 font-medium">+{Math.round(stop.delay / 60)}分</span>
                        ) : stop.delay <= -60 ? (
                          <span className="text-sky-500 font-medium">{Math.round(stop.delay / 60)}分</span>
                        ) : (
                          <span className="text-green-600">定刻</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* legend */}
          <div className="px-4 py-2 border-t border-gray-100 flex gap-3 text-[10px] text-gray-400">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500"/>3分超
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-400"/>1〜3分
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500"/>定刻
            </span>
          </div>
        </div>
      )}

      {/* controls */}
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
                      ${drEnabled
                        ? 'bg-blue-500 text-white border-blue-400 hover:bg-blue-600'
                        : 'bg-white/92 text-gray-500 border-gray-200 hover:bg-white'}`}>
          推算移動: {drEnabled ? 'ON' : 'OFF'}
        </button>
        <div className="bg-white/85 backdrop-blur-sm text-gray-500 text-[11px] rounded-lg px-3
                        py-1.5 shadow border border-gray-100">
          次回更新: {countdown}秒後
        </div>
        <div className="bg-white/80 backdrop-blur-sm text-gray-400 text-[10px] rounded-lg px-3
                        py-1.5 shadow border border-gray-100">
          データ: ODPT 仙台市交通局 · 15秒更新
        </div>
      </div>
    </div>
  );
}
