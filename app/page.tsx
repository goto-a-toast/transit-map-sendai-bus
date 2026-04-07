import dynamic from 'next/dynamic';

// Leaflet はSSRで動かないためdynamic importでクライアントのみ描画
const BusMap = dynamic(() => import('./components/BusMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-gray-900">
      <div className="text-center text-white">
        <svg
          className="animate-spin h-10 w-10 text-blue-400 mx-auto mb-4"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v8H4z"
          />
        </svg>
        <p className="text-sm text-gray-400">マップを読み込み中...</p>
      </div>
    </div>
  ),
});

export default function Home() {
  return (
    <main className="w-full h-screen">
      <BusMap />
    </main>
  );
}
