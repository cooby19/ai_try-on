"use client";

import Link from "next/link";
import { useState } from "react";
import type { CartItemView } from "@/lib/types";
import { useCart } from "./CartProvider";

const currency = new Intl.NumberFormat("zh-TW", {
  style: "currency",
  currency: "TWD",
  maximumFractionDigits: 0,
});

const UNAVAILABLE_MESSAGE = {
  product_inactive: "商品已下架",
  variant_inactive: "此尺寸已停止販售",
  out_of_stock: "目前缺貨",
} as const;

export default function CartPageClient() {
  const {
    cart,
    loading,
    error,
    isAuthenticated,
    pendingVariantIds,
    adjustItem,
    setItem,
    removeItem,
    clearError,
  } = useCart();

  if (loading) return <p className="py-16 text-center text-sm text-stone-500">正在載入購物車…</p>;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">購物車</h1>
          <p className="mt-1 text-sm text-stone-500">共 {cart.itemCount} 件商品</p>
        </div>
        <Link href="/" className="text-sm text-stone-500 hover:underline">繼續選購</Link>
      </div>

      {!isAuthenticated && cart.items.length > 0 && (
        <div className="mt-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <Link href="/login?returnTo=%2Fcart" className="font-medium underline">登入</Link>
          後即可保存購物車，並在其他裝置繼續查看。
        </div>
      )}

      {error && (
        <div role="alert" className="mt-5 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <button type="button" onClick={clearError} className="shrink-0 underline">關閉</button>
        </div>
      )}
      {cart.notices.map((notice, index) => (
        <div key={`${notice}-${index}`} className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {notice}
        </div>
      ))}

      {!cart.items.length ? (
        <div className="mt-8 rounded-xl border border-stone-200 bg-white px-6 py-16 text-center">
          <p className="font-medium">購物車目前是空的</p>
          <p className="mt-1 text-sm text-stone-500">選擇喜歡的商品與尺寸後加入購物車。</p>
          <Link href="/" className="mt-5 inline-block rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700">
            前往商品列表
          </Link>
        </div>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_18rem]">
          <div className="space-y-3">
            {cart.items.map((item) => (
              <CartRow
                key={`${item.variantId}:${item.quantity}`}
                item={item}
                syncing={pendingVariantIds.has(item.variantId)}
                onAdjust={(delta) => adjustItem(item.variantId, delta)}
                onSet={(quantity) => setItem(item.variantId, quantity)}
                onRemove={() => removeItem(item.variantId)}
              />
            ))}
          </div>
          <aside className="h-fit rounded-xl border border-stone-200 bg-white p-5 lg:sticky lg:top-5">
            <h2 className="font-semibold">金額摘要</h2>
            <div className="mt-4 flex justify-between text-sm">
              <span className="text-stone-500">可購買商品</span>
              <span>{cart.items.filter((item) => item.available).reduce((sum, item) => sum + item.quantity, 0)} 件</span>
            </div>
            <div className="mt-4 flex items-baseline justify-between border-t border-stone-200 pt-4">
              <span className="font-medium">總金額</span>
              <span className="text-xl font-semibold">{currency.format(cart.subtotal)}</span>
            </div>
            <p className="mt-3 text-xs leading-5 text-stone-500">價格與庫存以伺服器目前資料為準；缺貨或下架商品不列入總額。</p>
          </aside>
        </div>
      )}
    </div>
  );
}

function CartRow({
  item,
  syncing,
  onAdjust,
  onSet,
  onRemove,
}: {
  item: CartItemView;
  syncing: boolean;
  onAdjust: (delta: 1 | -1) => Promise<void>;
  onSet: (quantity: number) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(item.quantity));
  const [draftError, setDraftError] = useState<string | null>(null);

  async function commit() {
    const quantity = Number(draft);
    if (!Number.isInteger(quantity) || quantity < 1) {
      setDraftError("數量必須是至少 1 的整數。");
      setDraft(String(item.quantity));
      return;
    }
    if (quantity > item.maxQuantity) {
      setDraftError(`目前最多只能購買 ${item.maxQuantity} 件。`);
      setDraft(String(item.quantity));
      return;
    }
    if (quantity !== item.quantity) {
      try {
        setDraftError(null);
        await onSet(quantity);
      } catch {
        setDraftError("數量更新失敗，請稍後再試。");
        setDraft(String(item.quantity));
      }
    }
  }

  return (
    <article className="rounded-xl border border-stone-200 bg-white p-4" aria-busy={syncing}>
      <div className="flex gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={item.imageUrl} alt={item.name} className="h-24 w-24 shrink-0 rounded-lg border border-stone-200 bg-stone-50 object-cover" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Link href={`/products/${item.productId}`} className="font-medium hover:underline">{item.name}</Link>
              <p className="mt-1 text-sm text-stone-500">尺寸：{item.size}</p>
            </div>
            <span className="shrink-0 font-medium">{currency.format(item.lineSubtotal)}</span>
          </div>
          <p className="mt-1 text-sm text-stone-500">單價 {currency.format(item.unitPrice)}</p>
          {!item.available && item.unavailableReason && (
            <p className="mt-2 text-sm font-medium text-red-600">{UNAVAILABLE_MESSAGE[item.unavailableReason]}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!item.available || item.quantity <= 1}
              onClick={() => void onAdjust(-1).catch(() => undefined)}
              className="h-9 w-9 rounded-lg border border-stone-300 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={`減少${item.name}數量`}
            >−</button>
            <input
              type="number"
              min={1}
              max={Math.max(1, item.maxQuantity)}
              inputMode="numeric"
              value={draft}
              disabled={!item.available}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => void commit()}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className="h-9 w-16 rounded-lg border border-stone-300 text-center text-sm disabled:bg-stone-100"
              aria-label={`${item.name}數量`}
            />
            <button
              type="button"
              disabled={!item.available || item.quantity >= item.maxQuantity}
              onClick={() => void onAdjust(1).catch(() => undefined)}
              className="h-9 w-9 rounded-lg border border-stone-300 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={`增加${item.name}數量`}
            >＋</button>
            <span className="text-xs text-stone-400">最多 {item.maxQuantity} 件</span>
            <button
              type="button"
              onClick={() => void onRemove().catch(() => undefined)}
              className="ml-auto text-sm text-stone-500 hover:text-red-600"
            >{syncing ? "同步中…" : "移除"}</button>
          </div>
          {draftError && <p role="alert" className="mt-2 text-xs text-red-600">{draftError}</p>}
        </div>
      </div>
    </article>
  );
}
