// 首頁：商品列表（Server Component，直接從資料庫讀商品）
import Link from "next/link";
import { getSupabaseAdmin, isSupabaseConfigured } from "@/lib/supabase";
import type { Product } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  if (!isSupabaseConfigured()) {
    return <SetupGuide reason="尚未設定 Supabase 環境變數" />;
  }

  const supabase = getSupabaseAdmin();
  const { data: products, error } = await supabase
    .from("products")
    .select("*")
    .eq("is_active", true)
    .order("created_at")
    .returns<Product[]>();

  if (error) {
    return <SetupGuide reason={`資料庫查詢失敗：${error.message}（可能還沒執行 migration）`} />;
  }
  if (!products?.length) {
    return <SetupGuide reason="products 資料表是空的（種子資料尚未匯入）" />;
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-1">上衣</h1>
      <p className="text-sm text-stone-500 mb-6">選一件商品，上傳照片體驗 AI 試穿。</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {products.map((p) => (
          <Link
            key={p.id}
            href={`/products/${p.id}`}
            className="group rounded-xl border border-stone-200 bg-white overflow-hidden hover:shadow-md transition-shadow"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.image_url}
              alt={p.name}
              className="w-full aspect-square object-cover bg-stone-100"
            />
            <div className="p-4">
              <h2 className="font-medium group-hover:underline">{p.name}</h2>
              <p className="text-sm text-stone-500 mt-0.5">
                {p.color} · {p.fit}
              </p>
              <p className="mt-2 font-semibold">NT$ {Math.round(p.price)}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function SetupGuide({ reason }: { reason: string }) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-sm leading-6">
      <h1 className="text-lg font-semibold mb-2">還差一步就能開始 Demo</h1>
      <p className="text-amber-800 mb-4">{reason}</p>
      <ol className="list-decimal pl-5 space-y-1 text-stone-700">
        <li>
          到 <span className="font-mono">supabase.com</span> 建立免費專案
        </li>
        <li>
          複製 <span className="font-mono">.env.local.example</span> 為{" "}
          <span className="font-mono">.env.local</span>，填入專案的 URL 與 service role key
        </li>
        <li>在 Supabase Dashboard 的 SQL Editor 依序執行 migrations 001～008</li>
        <li>重新啟動 dev server</li>
      </ol>
      <p className="mt-4 text-stone-500">詳細步驟請見專案 README.md。</p>
    </div>
  );
}
