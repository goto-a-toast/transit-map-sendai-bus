'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { BusVehicle } from '../api/buses/route';

const SENDAI_CENTER: [number, number] = [38.2682, 140.8694];
const REFRESH_INTERVAL = 15; // seconds
const LERP_DURATION   = 1500; // ms — snap-to-new-position animation
const DR_CAP_SEC      = 20;   // dead-reckoning cap (stop extrapolating after this many seconds)
const DR_SPEED_FACTOR = 0.65; // scale down speed to account for road curvature & measurement noise

let L: typeof import('leaflet') | null = null;

// ── math helpers ───────────────────────────────────────────────────────────
function easeOutCubic(t: number): number { return 1 - Math.pow(1 - t, 3); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((b - a + 540) % 360) - 180;
  return (a + diff * t + 360) % 360;
}
function toRad(deg: number): number { return (deg * Math.PI) / 180; }

/** Extrapolate lat/lng from an anchor using constant speed + bearing */
function deadReckon(
  anchorLat: number, anchorLng: number,
  bearingDeg: number, speedMs: number,
  elapsedSec: number,
): [number, number] {
  const t    = Math.min(elapsedSec, DR_CAP_SEC);
  const bRad = toRad(bearingDeg);
  const dist = speedMs * DR_SPEED_FACTOR * t; // metres travelled (damped)
  const dlat = (dist * Math.cos(bRad)) / 111_111;
  const dlng = (dist * Math.sin(bRad)) / (111_111 * Math.cos(toRad(anchorLat)));
  return [anchorLat + dlat, anchorLng + dlng];
}

// ── per-bus state ──────────────────────────────────────────────────────────
interface LerpTask {
  fromLat: number; fromLng: number;
  toLat:   number; toLng:   number;
  fromBearing: number; toBearing: number;
  startTime: number;
}

/** Dead-reckoning anchor — set once lerp ends (or on first appearance) */
interface DrAnchor {
  lat: number; lng: number;
  bearingDeg: number;
  speedMs: number;
  time: number;          // performance.now()
  routeId?: string;
}

// ── icon factory ───────────────────────────────────────────────────────────
function getBusIcon(
  lf: typeof import('leaflet'),
  bearing: number,
  routeId?: string,
): import('leaflet').DivIcon {
  const hue = routeId
    ? Math.abs(routeId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % 360
    : 210;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <defs>
        <filter id="sh" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.35"/>
        </filter>
      </defs>
      <g transform="rotate(${bearing},16,16)" filter="url(#sh)">
        <polygon points="16,3 20,11 12,11" fill="hsl(${hue},85%,38%)"/>
      </g>
      <rect x="8" y="11" width="16" height="13" rx="2.5" fill="hsl(${hue},72%,48%)" filter="url(#sh)"/>
      <rect x="10" y="13" width="5" height="3.5" rx="1" fill="white" opacity="0.95"/>
      <rect x="17" y="13" width="5" height="3.5" rx="1" fill="white" opacity="0.95"/>
      <rect x="9"  y="23" width="3.5" height="2.5" rx="1" fill="hsl(${hue},60%,28%)"/>
      <rect x="19.5" y="23" width="3.5" height="2.5" rx="1" fill="hsl(${hue},60%,28%)"/>
    </svg>`;
  return lf.divIcon({ html: svg, className: '', iconSize: [32,32], iconAnchor: [16,16], popupAnchor: [0,-18] });
}

// ── popup ──────────────────────────────────────────────────────────────────
function formatTime(ts?: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('ja-JP');
}
function buildPopup(bus: BusVehicle): string {
  const rows: [string, string][] = [
    ['車両', bus.vehicleLabel ?? bus.id],
    ['路線', bus.routeId ?? '-'],
    ['便',   bus.tripId  ?? '-'],
    ['速度', bus.speed   != null ? `${bus.speed} km/h` : '-'],
    ['方位', bus.bearing != null ? `${Math.round(bus.bearing)}°` : '-'],
    ['状態', bus.currentStatus ?? '-'],
    ['更新', formatTime(bus.timestamp)],
  ];
  const rowsHtml = rows.map(([l,v]) => `
    <tr>
      <td style="color:#6b7280;padding:2px 10px 2px 0;font-size:11px;white-space:nowrap">${l}</td>
      <td style="color:#111827;padding:2px 0;font-size:11px;font-weight:600">${v}</td>
    </tr>`).join('');
  return `
    <div style="background:#fff;border-radius:8px;padding:10px 13px;min-width:180px;
                font-family:system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.15)">
      <div style="font-weight:700;font-size:13px;margin-bottom:7px;color:#2563eb">🚌 バス情報</div>
      <table style="border-collapse:collapse;width:100%">${rowsHtml}</table>
    </div>`;
}

// ── component ──────────────────────────────────────────────────────────────
interface FetchResult { vehicles: BusVehicle[]; count: number; fetchedAt: number; error?: string; }

export default function BusMap() {
  const mapRef       = useRef<import('leaflet').Map | null>(null);
  const markersRef   = useRef<Map<string, import('leaflet').Marker>>(new Map());
  const bearingsRef  = useRef<Map<string, number>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // lerp tasks: position snap when new API data arrives
  const lerpTasksRef = useRef<Map<string, LerpTask>>(new Map());
  // dead-reckoning anchors: continuous movement between updates
  const drRef        = useRef<Map<string, DrAnchor>>(new Map());
  const rafRef       = useRef<number | null>(null);

  const [status,     setStatus]     = useState<'loading'|'ok'|'error'>('loading');
  const [busCount,   setBusCount]   = useState(0);
  const [lastUpdate, setLastUpdate] = useState('');
  const [errorMsg,   setErrorMsg]   = useState('');
  const [countdown,  setCountdown]  = useState(REFRESH_INTERVAL);
  const countdownRef = useRef(REFRESH_INTERVAL);
  const timerRef     = useRef<ReturnType<typeof setTimeout>|null>(null);

  // ── unified RAF loop ────────────────────────────────────────────────────
  const startRaf = useCallback(() => {
    if (rafRef.current != null) return;

    const loop = () => {
      const now = performance.now();
      let needsNextFrame = false;

      // 1. Lerp tasks: snap to new reported position
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

        if (t < 1) {
          needsNextFrame = true;
        } else {
          lerpTasksRef.current.delete(id);
          // Lerp done → set dead-reckoning anchor from the arrived position
          const dr = drRef.current.get(id);
          if (dr) {
            dr.lat  = task.toLat;
            dr.lng  = task.toLng;
            dr.time = now;
          }
        }
      }

      // 2. Dead reckoning: extrapolate movement for non-lerping buses
      for (const [id, dr] of drRef.current) {
        if (lerpTasksRef.current.has(id)) continue; // lerp has priority
        if (dr.speedMs <= 0) continue;

        const elapsed = (now - dr.time) / 1000;
        if (elapsed >= DR_CAP_SEC) continue; // stop extrapolating after cap

        const [lat, lng] = deadReckon(dr.lat, dr.lng, dr.bearingDeg, dr.speedMs, elapsed);
        markersRef.current.get(id)?.setLatLng([lat, lng]);
        needsNextFrame = true;
      }

      rafRef.current = needsNextFrame ? requestAnimationFrame(loop) : null;
    };

    rafRef.current = requestAnimationFrame(loop);
  }, []);

  // ── fetch buses ──────────────────────────────────────────────────────────
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
        const popup      = buildPopup(bus);

        if (markersRef.current.has(bus.id)) {
          const marker      = markersRef.current.get(bus.id)!;
          const cur         = marker.getLatLng(); // current visual pos (may be dead-reckoned)
          const fromBearing = bearingsRef.current.get(bus.id) ?? newBearing;

          // Update DR state with new speed/bearing (anchor will be set when lerp ends)
          drRef.current.set(bus.id, {
            lat: bus.lat, lng: bus.lon,       // target reported position
            bearingDeg: newBearing,
            speedMs:    newSpeedMs,
            time:       performance.now(),    // overridden when lerp ends
            routeId:    bus.routeId,
          });

          // Lerp from current visual position → new reported position
          lerpTasksRef.current.set(bus.id, {
            fromLat: cur.lat, fromLng: cur.lng,
            toLat:   bus.lat, toLng:   bus.lon,
            fromBearing, toBearing: newBearing,
            startTime: performance.now(),
          });

          marker.getPopup()?.setContent(popup);
          existingIds.delete(bus.id);
          startRaf();
        } else {
          // New bus — place immediately, start dead reckoning at once
          const icon   = getBusIcon(lf, newBearing, bus.routeId);
          const marker = lf.marker([bus.lat, bus.lon], { icon })
            .bindPopup(popup, { maxWidth: 260 })
            .addTo(mapRef.current!);
          markersRef.current.set(bus.id, marker);
          bearingsRef.current.set(bus.id, newBearing);
          drRef.current.set(bus.id, {
            lat: bus.lat, lng: bus.lon,
            bearingDeg: newBearing, speedMs: newSpeedMs,
            time: performance.now(), routeId: bus.routeId,
          });
          if (newSpeedMs > 0) startRaf();
        }
      }

      // Remove disappeared buses
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

  // ── map init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    (async () => {
      const leaflet = await import('leaflet');
      L = leaflet;
      const map = leaflet.map(containerRef.current!, { center: SENDAI_CENTER, zoom: 13 });
      leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      mapRef.current = map;
      await fetchBuses();
    })();
  }, [fetchBuses]);

  // ── countdown + auto-refresh ─────────────────────────────────────────────
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

  const handleRefresh = () => {
    countdownRef.current = REFRESH_INTERVAL;
    setCountdown(REFRESH_INTERVAL);
    setStatus('loading');
    fetchBuses();
  };

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />

      {/* Header */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none">
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

      {/* Bottom controls */}
      <div className="absolute bottom-6 right-3 z-[1000] flex flex-col gap-2 items-end">
        <button
          onClick={handleRefresh}
          className="bg-white/92 backdrop-blur-sm text-gray-700 text-xs rounded-lg px-3 py-2
                     shadow-md hover:bg-white transition flex items-center gap-1.5 border border-gray-200"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
          今すぐ更新
        </button>
        <div className="bg-white/85 backdrop-blur-sm text-gray-500 text-[11px] rounded-lg px-3
                        py-1.5 shadow border border-gray-100">
          次回更新: {countdown}秒後
        </div>
        <div className="bg-white/80 backdrop-blur-sm text-gray-400 text-[10px] rounded-lg px-3
                        py-1.5 shadow border border-gray-100 leading-relaxed">
          <div>データ: ODPT 仙台市交通局 · 15秒更新</div>
          <div>位置は速度・方位から推算中</div>
        </div>
      </div>
    </div>
  );
}
