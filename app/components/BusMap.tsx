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
function routeHue(routeId?: string) {
  if (!routeId) return 210;
  return Math.abs(routeId.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 360;
}

// Extract a short display label from the raw routeId string.
// e.g. "odpt.Route:SendaiMunicipal.10" → "10系統"
//      "10"                            → "10系統"
function routeLabel(routeId?: string): string {
  if (!routeId) return '-';
  const last = routeId.split(/[.:]/).pop() ?? routeId;
  return `${last}系統`;
}

// ── bus icon ─────────────────────────────────────────────────────────────
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
  return lf.divIcon({ html: svg, className: '', iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -18] });
}

// ── popup ─────────────────────────────────────────────────────────────────
function formatTime(ts?: number) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('ja-JP');
}

function buildBusPopup(bus: BusVehicle): string {
  const h = routeHue(bus.routeId);
  const rows: [string, string][] = [
    ['車両', bus.vehicleLabel ?? bus.id],
    ['路線', routeLabel(bus.routeId)],
    ['速度', bus.speed != null ? `${bus.speed} km/h` : '-'],
    ['状態', bus.currentStatus ?? '-'],
    ['更新', formatTime(bus.timestamp)],
  ];
  const rowsHtml = rows.map(([l, v]) =>
    `<tr>
      <td style="color:#6b7280;padding:2px 10px 2px 0;font-size:11px;white-space:nowrap">${l}</td>
      <td style="color:#111827;padding:2px 0;font-size:11px;font-weight:600">${v}</td>
    </tr>`
  ).join('');
  return `<div style="background:#fff;border-radius:8px;padding:10px 13px;min-width:180px;
    font-family:system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.15)">
    <div style="font-weight:700;font-size:13px;margin-bottom:7px;color:hsl(${h},65%,40%)">🚌 バス情報</div>
    <table style="border-collapse:collapse;width:100%">${rowsHtml}</table>
  </div>`;
}

// ── internal types ────────────────────────────────────────────────────────
interface LerpTask {
  fromLat: number; fromLng: number; toLat: number; toLng: number;
  fromBearing: number; toBearing: number; startTime: number;
}
interface DrAnchor {
  lat: number; lng: number; bearingDeg: number; speedMs: number;
  time: number; routeId?: string;
}
interface FetchResult { vehicles: BusVehicle[]; count: number; fetchedAt: number; error?: string; }

// ── component ─────────────────────────────────────────────────────────────
export default function BusMap() {
  const mapRef       = useRef<import('leaflet').Map | null>(null);
  const markersRef   = useRef<Map<string, import('leaflet').Marker>>(new Map());
  const bearingsRef  = useRef<Map<string, number>>(new Map());
  const busDataRef   = useRef<Map<string, BusVehicle>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const lerpRef      = useRef<Map<string, LerpTask>>(new Map());
  const drRef        = useRef<Map<string, DrAnchor>>(new Map());
  const rafRef       = useRef<number | null>(null);
  const drEnabledRef = useRef(true);
  const countdownRef = useRef(REFRESH_INTERVAL);
  const timerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status,        setStatus]        = useState<'loading' | 'ok' | 'error'>('loading');
  const [busCount,      setBusCount]      = useState(0);
  const [lastUpdate,    setLastUpdate]    = useState('');
  const [errorMsg,      setErrorMsg]      = useState('');
  const [countdown,     setCountdown]     = useState(REFRESH_INTERVAL);
  const [drEnabled,     setDrEnabled]     = useState(true);
  const [alerts,        setAlerts]        = useState<ServiceAlert[]>([]);
  const [dismissAlerts, setDismissAlerts] = useState(false);

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
          marker.setIcon(getBusIcon(L, bearing, drRef.current.get(id)?.routeId));
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

  // ── fetch buses ───────────────────────────────────────────────────────
  const fetchBuses = useCallback(async () => {
    if (!mapRef.current || !L) return;
    try {
      const res  = await fetch('/api/buses', { cache: 'no-store' });
      const data: FetchResult = await res.json();
      if (!res.ok || data.error) { setStatus('error'); setErrorMsg(data.error ?? 'エラー'); return; }

      const lf = L;
      const existingIds = new Set(markersRef.current.keys());

      for (const bus of data.vehicles) {
        const newBearing = bus.bearing  ?? 0;
        const newSpeedMs = (bus.speed ?? 0) / 3.6;
        busDataRef.current.set(bus.id, bus);

        if (markersRef.current.has(bus.id)) {
          const marker      = markersRef.current.get(bus.id)!;
          const cur         = marker.getLatLng();
          const fromBearing = bearingsRef.current.get(bus.id) ?? newBearing;
          drRef.current.set(bus.id, {
            lat: bus.lat, lng: bus.lon, bearingDeg: newBearing,
            speedMs: newSpeedMs, time: performance.now(), routeId: bus.routeId,
          });
          lerpRef.current.set(bus.id, {
            fromLat: cur.lat, fromLng: cur.lng, toLat: bus.lat, toLng: bus.lon,
            fromBearing, toBearing: newBearing, startTime: performance.now(),
          });
          existingIds.delete(bus.id);
          startRaf();
        } else {
          const icon = getBusIcon(lf, newBearing, bus.routeId);
          const marker = lf.marker([bus.lat, bus.lon], { icon })
            .bindPopup(() => buildBusPopup(busDataRef.current.get(bus.id) ?? bus), { maxWidth: 260 })
            .addTo(mapRef.current!);
          markersRef.current.set(bus.id, marker);
          bearingsRef.current.set(bus.id, newBearing);
          drRef.current.set(bus.id, {
            lat: bus.lat, lng: bus.lon, bearingDeg: newBearing,
            speedMs: newSpeedMs, time: performance.now(), routeId: bus.routeId,
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
