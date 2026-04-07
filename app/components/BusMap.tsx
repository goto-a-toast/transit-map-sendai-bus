'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { BusVehicle } from '../api/buses/route';

const SENDAI_CENTER: [number, number] = [38.2682, 140.8694];
const REFRESH_INTERVAL = 30; // seconds

// Leaflet をクライアントサイドのみで動的にロード
let L: typeof import('leaflet') | null = null;

function getBusIcon(lf: typeof import('leaflet'), bearing?: number, routeId?: string): import('leaflet').DivIcon {
  const hue = routeId
    ? Math.abs(routeId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % 360
    : 210;

  const rotation = bearing != null ? bearing : 0;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.4"/>
        </filter>
      </defs>
      <g transform="rotate(${rotation}, 14, 14)" filter="url(#shadow)">
        <!-- Direction arrow -->
        <polygon points="14,2 18,10 10,10" fill="hsl(${hue},80%,40%)" opacity="0.9"/>
      </g>
      <!-- Bus body -->
      <rect x="7" y="9" width="14" height="12" rx="2" fill="hsl(${hue},75%,50%)" filter="url(#shadow)"/>
      <rect x="9" y="11" width="4" height="3" rx="1" fill="white" opacity="0.9"/>
      <rect x="15" y="11" width="4" height="3" rx="1" fill="white" opacity="0.9"/>
      <rect x="8" y="20" width="3" height="2" rx="1" fill="hsl(${hue},60%,30%)"/>
      <rect x="17" y="20" width="3" height="2" rx="1" fill="hsl(${hue},60%,30%)"/>
    </svg>
  `;

  return lf.divIcon({
    html: svg,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  });
}

function formatTime(ts?: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('ja-JP');
}

interface FetchResult {
  vehicles: BusVehicle[];
  count: number;
  fetchedAt: number;
  error?: string;
}

export default function BusMap() {
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const markersRef = useRef<Map<string, import('leaflet').Marker>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [busCount, setBusCount] = useState(0);
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState('');
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const countdownRef = useRef(REFRESH_INTERVAL);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchBuses = useCallback(async () => {
    if (!mapRef.current || !L) return;
    try {
      const res = await fetch('/api/buses', { cache: 'no-store' });
      const data: FetchResult = await res.json();

      if (!res.ok || data.error) {
        setStatus('error');
        setErrorMsg(data.error ?? 'エラーが発生しました');
        return;
      }

      const map = mapRef.current;
      const lf = L;
      const existingIds = new Set(markersRef.current.keys());

      for (const bus of data.vehicles) {
        const latlng: [number, number] = [bus.lat, bus.lon];
        const icon = getBusIcon(lf, bus.bearing, bus.routeId);
        const popupContent = buildPopup(bus);

        if (markersRef.current.has(bus.id)) {
          const marker = markersRef.current.get(bus.id)!;
          marker.setLatLng(latlng);
          marker.setIcon(icon);
          marker.getPopup()?.setContent(popupContent);
          existingIds.delete(bus.id);
        } else {
          const marker = lf
            .marker(latlng, { icon })
            .bindPopup(popupContent, { maxWidth: 240 })
            .addTo(map);
          markersRef.current.set(bus.id, marker);
        }
      }

      // 消えたバスを削除
      for (const oldId of existingIds) {
        markersRef.current.get(oldId)?.remove();
        markersRef.current.delete(oldId);
      }

      setBusCount(data.count);
      setLastUpdate(formatTime(data.fetchedAt));
      setStatus('ok');
      setErrorMsg('');
    } catch (e) {
      setStatus('error');
      setErrorMsg(e instanceof Error ? e.message : 'ネットワークエラー');
    }
  }, []);

  // マップ初期化
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    (async () => {
      const leaflet = await import('leaflet');
      L = leaflet;

      const map = leaflet.map(containerRef.current!, {
        center: SENDAI_CENTER,
        zoom: 13,
        zoomControl: true,
      });

      leaflet
        .tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
          subdomains: 'abcd',
          maxZoom: 20,
        })
        .addTo(map);

      mapRef.current = map;
      await fetchBuses();
    })();
  }, [fetchBuses]);

  // 自動更新タイマー
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
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [fetchBuses]);

  const handleRefresh = () => {
    countdownRef.current = REFRESH_INTERVAL;
    setCountdown(REFRESH_INTERVAL);
    setStatus('loading');
    fetchBuses();
  };

  return (
    <div className="relative w-full h-full">
      {/* Map container */}
      <div ref={containerRef} className="w-full h-full" />

      {/* Header overlay */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none">
        <div className="bg-black/75 backdrop-blur-sm text-white rounded-xl px-5 py-2.5 shadow-xl flex items-center gap-4 pointer-events-auto">
          <div className="flex items-center gap-2">
            <span className="text-xl">🚌</span>
            <div>
              <div className="text-sm font-bold leading-tight">仙台市バス リアルタイムマップ</div>
              <div className="text-[10px] text-gray-400 leading-tight">Sendai Municipal Bus Live Tracker</div>
            </div>
          </div>
          <div className="h-8 w-px bg-white/20" />
          {status === 'loading' && (
            <div className="flex items-center gap-1.5 text-yellow-400 text-xs">
              <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              <span>取得中...</span>
            </div>
          )}
          {status === 'ok' && (
            <div className="text-xs text-gray-300 flex flex-col items-end">
              <span className="text-green-400 font-semibold">{busCount} 台運行中</span>
              <span className="text-[10px] text-gray-500">更新: {lastUpdate}</span>
            </div>
          )}
          {status === 'error' && (
            <div className="text-xs text-red-400 max-w-[180px] truncate">{errorMsg}</div>
          )}
        </div>
      </div>

      {/* Bottom controls */}
      <div className="absolute bottom-5 right-3 z-[1000] flex flex-col gap-2 items-end">
        <button
          onClick={handleRefresh}
          className="bg-black/75 backdrop-blur-sm text-white text-xs rounded-lg px-3 py-2 shadow-lg hover:bg-black/90 transition flex items-center gap-1.5"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          今すぐ更新
        </button>
        <div className="bg-black/60 backdrop-blur-sm text-gray-400 text-[11px] rounded-lg px-3 py-1.5 shadow">
          次回更新: {countdown}秒後
        </div>
        <div className="bg-black/60 backdrop-blur-sm text-gray-500 text-[10px] rounded-lg px-3 py-1.5 shadow leading-relaxed">
          <div>データ: ODPT 仙台市交通局</div>
          <div>30秒ごとに自動更新</div>
        </div>
      </div>
    </div>
  );
}

function buildPopup(bus: BusVehicle): string {
  const rows = [
    ['車両ID', bus.vehicleLabel ?? bus.id],
    ['路線', bus.routeId ?? '-'],
    ['便', bus.tripId ?? '-'],
    ['速度', bus.speed != null ? `${bus.speed} km/h` : '-'],
    ['方位', bus.bearing != null ? `${bus.bearing}°` : '-'],
    ['状態', bus.currentStatus ?? '-'],
    ['更新', formatTime(bus.timestamp)],
  ];

  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="color:#9ca3af;padding:2px 8px 2px 0;font-size:11px;white-space:nowrap">${label}</td>
         <td style="color:#f3f4f6;padding:2px 0;font-size:11px;font-weight:500">${value}</td></tr>`
    )
    .join('');

  return `
    <div style="background:#1f2937;color:#f3f4f6;border-radius:8px;padding:10px 12px;min-width:180px;font-family:system-ui,sans-serif">
      <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:#60a5fa">🚌 バス情報</div>
      <table style="border-collapse:collapse;width:100%">${rowsHtml}</table>
    </div>
  `;
}
