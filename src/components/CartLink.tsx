"use client";

import Link from "next/link";
import { useCart } from "./CartProvider";

export default function CartLink() {
  const { cart, loading } = useCart();
  return (
    <Link href="/cart" className="relative rounded-lg px-3 py-2 text-sm font-medium hover:bg-stone-50">
      購物車
      {!loading && cart.itemCount > 0 && (
        <span className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-stone-900 px-1.5 py-0.5 text-[11px] leading-4 text-white">
          {cart.itemCount > 99 ? "99+" : cart.itemCount}
        </span>
      )}
    </Link>
  );
}

