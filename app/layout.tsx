import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '仙台市バス リアルタイムマップ',
  description: '仙台市交通局バスのリアルタイム位置情報をODPTデータを利用して可視化します。',
  openGraph: {
    title: '仙台市バス リアルタイムマップ',
    description: '仙台市交通局バスのリアルタイム位置情報マップ',
    locale: 'ja_JP',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="h-screen overflow-hidden">{children}</body>
    </html>
  );
}
