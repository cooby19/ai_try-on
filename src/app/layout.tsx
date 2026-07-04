import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 虛擬試衣 Demo",
  description: "上傳正面半身照，預覽上衣穿在自己身上的效果（MVP）",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-TW" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-stone-50 text-stone-900">
        <header className="border-b border-stone-200 bg-white">
          <div className="mx-auto max-w-5xl px-4 py-4 flex items-center justify-between">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              樣衣間 <span className="text-stone-400 text-sm font-normal">AI 虛擬試衣 MVP</span>
            </Link>
            <span className="text-xs text-stone-400">Demo 環境</span>
          </div>
        </header>
        <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-8">{children}</main>
        <footer className="border-t border-stone-200 bg-white">
          <div className="mx-auto max-w-5xl px-4 py-4 text-xs text-stone-400">
            AI 試穿圖僅供參考，實際穿著效果依商品實物為準。
          </div>
        </footer>
      </body>
    </html>
  );
}
