"use client";

import { useId, useMemo, useState } from "react";
import type { ProductVariant } from "@/lib/types";
import { useCart } from "./CartProvider";

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "單一尺寸"];

export default function AddToCartButton({
  productName,
  variants,
}: {
  productName: string;
  variants: ProductVariant[];
}) {
  const sorted = useMemo(() => [...variants].sort((a, b) => {
    const aRank = SIZE_ORDER.indexOf(a.size);
    const bRank = SIZE_ORDER.indexOf(b.size);
    return (aRank < 0 ? SIZE_ORDER.length : aRank) - (bRank < 0 ? SIZE_ORDER.length : bRank);
  }), [variants]);
  const firstAvailable = sorted.find((variant) => variant.is_active && variant.stock_quantity > 0);
  const [variantId, setVariantId] = useState(firstAvailable?.id ?? sorted[0]?.id ?? "");
  const [added, setAdded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const selectId = useId();
  const { addItem, pendingVariantIds } = useCart();
  const selected = sorted.find((variant) => variant.id === variantId);
  const soldOut = !firstAvailable;

  async function add() {
    if (!selected || soldOut) return;
    setLocalError(null);
    try {
      await addItem(selected.id);
      setAdded(true);
      window.setTimeout(() => setAdded(false), 2000);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "加入購物車失敗。");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor={selectId}>尺寸</label>
        <select
          id={selectId}
          value={variantId}
          onChange={(event) => setVariantId(event.target.value)}
          disabled={!sorted.length}
          className="rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm disabled:bg-stone-100"
          aria-label={`${productName}尺寸`}
        >
          {sorted.map((variant) => {
            const unavailable = !variant.is_active || variant.stock_quantity < 1;
            return (
              <option key={variant.id} value={variant.id} disabled={unavailable}>
                {variant.size}{unavailable ? "（缺貨）" : `（剩 ${variant.stock_quantity}）`}
              </option>
            );
          })}
        </select>
        <button
          type="button"
          onClick={add}
          disabled={soldOut || pendingVariantIds.has(variantId)}
          className="rounded-lg border border-stone-300 bg-white px-5 py-2.5 text-sm font-medium hover:bg-stone-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          {soldOut ? "已售完" : pendingVariantIds.has(variantId) ? "加入中…" : added ? "已加入購物車" : "加入購物車"}
        </button>
      </div>
      {localError && <p role="alert" className="mt-1.5 text-xs text-red-600">{localError}</p>}
    </div>
  );
}
