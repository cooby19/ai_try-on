"use client";
// 加入購物車：MVP 只是示範用的假動作
import { useState } from "react";

export default function AddToCartButton({ productName }: { productName: string }) {
  const [added, setAdded] = useState(false);
  return (
    <button
      onClick={() => {
        setAdded(true);
        setTimeout(() => setAdded(false), 2000);
      }}
      className="rounded-lg border border-stone-300 bg-white px-5 py-2.5 text-sm font-medium hover:bg-stone-50 transition-colors"
    >
      {added ? `已加入購物車（示範）` : "加入購物車"}
    </button>
  );
}
