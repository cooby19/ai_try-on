import type { Metadata } from "next";
import Link from "next/link";
import { signOut } from "@/app/auth/actions";
import { getCurrentUser, userDisplayName } from "@/lib/user";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 虛擬試衣 Demo",
  description: "上傳正面半身照，預覽上衣穿在自己身上的效果（MVP）",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getCurrentUser();
  return (
    <html lang="zh-TW" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-stone-50 text-stone-900">
        <header className="border-b border-stone-200 bg-white">
          <div className="mx-auto max-w-5xl px-4 py-4 flex items-center justify-between">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              樣衣間 <span className="text-stone-400 text-sm font-normal">AI 虛擬試衣 MVP</span>
            </Link>
            {user ? (
              <details className="relative">
                <summary className="cursor-pointer list-none rounded-lg px-3 py-2 text-sm font-medium hover:bg-stone-50">
                  {userDisplayName(user)} <span className="text-stone-400">⌄</span>
                </summary>
                <div className="absolute right-0 z-40 mt-2 w-44 overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
                  <Link href="/account" className="block px-4 py-2 text-sm hover:bg-stone-50">
                    帳戶設定
                  </Link>
                  <form action={signOut}>
                    <button type="submit" className="block w-full px-4 py-2 text-left text-sm hover:bg-stone-50">
                      登出
                    </button>
                  </form>
                </div>
              </details>
            ) : (
              <Link href="/login" className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-stone-50">
                登入／註冊
              </Link>
            )}
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
