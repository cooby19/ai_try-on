"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CART_STORAGE_KEY,
  emptyGuestCart,
  parseStoredGuestCart,
} from "@/lib/cart-storage";
import {
  guestCartFromView,
  projectCart,
  projectGuestCart,
  requestQuantity,
  type CartMutation,
} from "@/lib/cart-optimistic";
import type { CartView, StoredGuestCart } from "@/lib/types";

const EMPTY_CART: CartView = { items: [], itemCount: 0, subtotal: 0, notices: [] };

interface CartContextValue {
  cart: CartView;
  loading: boolean;
  pendingVariantIds: ReadonlySet<string>;
  error: string | null;
  isAuthenticated: boolean;
  addItem: (variantId: string, quantity?: number) => Promise<void>;
  adjustItem: (variantId: string, delta: 1 | -1) => Promise<void>;
  setItem: (variantId: string, quantity: number) => Promise<void>;
  removeItem: (variantId: string) => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

type QueuedMutation = CartMutation & {
  resolve: () => void;
  reject: (error: Error) => void;
};

type CartMutationInput =
  | { type: "add"; variantId: string; quantity: number }
  | { type: "adjust"; variantId: string; delta: number }
  | { type: "set"; variantId: string; quantity: number }
  | { type: "remove"; variantId: string };

const CartContext = createContext<CartContextValue | null>(null);

function readGuestCart(): StoredGuestCart {
  const existing = parseStoredGuestCart(window.localStorage.getItem(CART_STORAGE_KEY));
  if (existing) return existing;
  const created = emptyGuestCart();
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(created));
  return created;
}

function writeGuestCart(cart: StoredGuestCart) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
}

async function fetchCart(url: string, init?: RequestInit): Promise<CartView> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as (CartView & { message?: string }) | null;
  if (!response.ok || !body?.items) throw new Error(body?.message ?? "購物車同步失敗，請稍後再試。");
  return body;
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export default function CartProvider({
  isAuthenticated,
  children,
}: {
  isAuthenticated: boolean;
  children: ReactNode;
}) {
  const [cart, setCart] = useState<CartView>(EMPTY_CART);
  const [loading, setLoading] = useState(true);
  const [pendingVariantIds, setPendingVariantIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const canonicalCart = useRef<CartView>(EMPTY_CART);
  const guestConfirmed = useRef<StoredGuestCart | null>(null);
  const queue = useRef<QueuedMutation[]>([]);
  const processing = useRef(false);
  const refreshAfterQueue = useRef(false);
  const mutationSequence = useRef(0);

  const updatePendingVariants = useCallback(() => {
    if (mounted.current) setPendingVariantIds(new Set(queue.current.map((mutation) => mutation.variantId)));
  }, []);

  const updateDisplayedCart = useCallback(() => {
    if (mounted.current) setCart(projectCart(canonicalCart.current, queue.current));
  }, []);

  const writeGuestProjection = useCallback(() => {
    const base = guestConfirmed.current;
    if (!base) return;
    writeGuestCart(projectGuestCart(base, queue.current));
  }, []);

  const resolveGuest = useCallback(async (guest: StoredGuestCart) => {
    const resolved = await fetchCart("/api/cart/resolve", {
      method: "POST",
      body: JSON.stringify({ items: guest.items }),
    });
    return { resolved, guest: guestCartFromView(guest, resolved) };
  }, []);

  const syncNow = useCallback(async () => {
    try {
      setError(null);
      const revision = mutationSequence.current;
      if (isAuthenticated) {
        const next = await fetchCart("/api/cart");
        if (revision !== mutationSequence.current) return;
        canonicalCart.current = next;
      } else {
        const base = guestConfirmed.current ?? readGuestCart();
        const next = await resolveGuest(base);
        if (revision !== mutationSequence.current) return;
        guestConfirmed.current = next.guest;
        writeGuestCart(next.guest);
        canonicalCart.current = next.resolved;
      }
      updateDisplayedCart();
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause, "購物車同步失敗。"));
    }
  }, [isAuthenticated, resolveGuest, updateDisplayedCart]);

  const requestAuthenticatedMutation = useCallback(async (mutation: CartMutation) => {
    if (mutation.type === "remove") {
      return fetchCart(`/api/cart/items/${encodeURIComponent(mutation.variantId)}`, { method: "DELETE" });
    }
    if (mutation.type === "add") {
      return fetchCart("/api/cart/items", {
        method: "POST",
        body: JSON.stringify({ variantId: mutation.variantId, quantity: mutation.quantity }),
      });
    }

    const quantity = requestQuantity(canonicalCart.current, mutation);
    if (quantity === null) throw new Error("這筆商品已不存在，請重新整理購物車。");
    return fetchCart(`/api/cart/items/${encodeURIComponent(mutation.variantId)}`, {
      method: "PATCH",
      body: JSON.stringify({ quantity }),
    });
  }, []);

  const runQueue = useCallback(async () => {
    if (processing.current) return;
    processing.current = true;

    while (queue.current.length > 0) {
      const mutation = queue.current[0];
      try {
        if (isAuthenticated) {
          canonicalCart.current = await requestAuthenticatedMutation(mutation);
        } else {
          const base = guestConfirmed.current ?? readGuestCart();
          const next = await resolveGuest(projectGuestCart(base, [mutation]));
          guestConfirmed.current = next.guest;
          canonicalCart.current = next.resolved;
        }
        queue.current.shift();
        mutation.resolve();
      } catch (cause) {
        queue.current.shift();
        const message = errorMessage(cause, "購物車操作失敗。");
        if (mounted.current) setError(message);
        mutation.reject(new Error(message));

        // 網路逾時時請求可能已在伺服器完成；在處理下一筆意圖前重新取得權威快照。
        if (isAuthenticated) {
          try {
            canonicalCart.current = await fetchCart("/api/cart");
          } catch {
            // 保留最後成功快照；下一次 focus 或手動 refresh 仍會重新校正。
          }
        }
      }

      if (!isAuthenticated) writeGuestProjection();
      updatePendingVariants();
      updateDisplayedCart();
    }

    processing.current = false;
    if (refreshAfterQueue.current) {
      refreshAfterQueue.current = false;
      void syncNow();
    }
  }, [isAuthenticated, requestAuthenticatedMutation, resolveGuest, syncNow, updateDisplayedCart, updatePendingVariants, writeGuestProjection]);

  const enqueue = useCallback((mutation: CartMutationInput) => {
    setError(null);
    const id = String(++mutationSequence.current);
    return new Promise<void>((resolve, reject) => {
      queue.current.push({ ...mutation, id, resolve, reject } as QueuedMutation);
      if (!isAuthenticated && !guestConfirmed.current) guestConfirmed.current = readGuestCart();
      if (!isAuthenticated) writeGuestProjection();
      updatePendingVariants();
      updateDisplayedCart();
      void runQueue();
    });
  }, [isAuthenticated, runQueue, updateDisplayedCart, updatePendingVariants, writeGuestProjection]);

  const refresh = useCallback(async () => {
    if (processing.current || queue.current.length > 0) {
      refreshAfterQueue.current = true;
      return;
    }
    await syncNow();
  }, [syncNow]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    async function initialize() {
      setLoading(true);
      setError(null);
      try {
        const revision = mutationSequence.current;
        if (!isAuthenticated) {
          const base = readGuestCart();
          guestConfirmed.current = base;
          const next = await resolveGuest(base);
          if (cancelled || revision !== mutationSequence.current) return;
          guestConfirmed.current = next.guest;
          writeGuestCart(next.guest);
          canonicalCart.current = next.resolved;
          updateDisplayedCart();
          return;
        }

        const guest = parseStoredGuestCart(window.localStorage.getItem(CART_STORAGE_KEY));
        const next = guest?.items.length
          ? await fetchCart("/api/cart/merge", {
              method: "POST",
              body: JSON.stringify({ guestCartId: guest.guestCartId, items: guest.items }),
            })
          : await fetchCart("/api/cart");
        if (cancelled || revision !== mutationSequence.current) return;
        if (guest?.items.length) window.localStorage.removeItem(CART_STORAGE_KEY);
        canonicalCart.current = next;
        updateDisplayedCart();
      } catch (cause) {
        if (!cancelled && mounted.current) setError(errorMessage(cause, "購物車同步失敗。"));
      } finally {
        if (!cancelled && mounted.current) setLoading(false);
      }
    }
    void initialize();
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [isAuthenticated, resolveGuest, updateDisplayedCart]);

  useEffect(() => {
    function onFocus() {
      void refresh();
    }
    function onStorage(event: StorageEvent) {
      if (!isAuthenticated && event.key === CART_STORAGE_KEY) void refresh();
    }
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, [isAuthenticated, refresh]);

  const addItem = useCallback((variantId: string, quantity = 1) => (
    enqueue({ type: "add", variantId, quantity })
  ), [enqueue]);

  const adjustItem = useCallback((variantId: string, delta: 1 | -1) => (
    enqueue({ type: "adjust", variantId, delta })
  ), [enqueue]);

  const setItem = useCallback((variantId: string, quantity: number) => (
    enqueue({ type: "set", variantId, quantity })
  ), [enqueue]);

  const removeItem = useCallback((variantId: string) => (
    enqueue({ type: "remove", variantId })
  ), [enqueue]);

  return (
    <CartContext.Provider value={{
      cart,
      loading,
      pendingVariantIds,
      error,
      isAuthenticated,
      addItem,
      adjustItem,
      setItem,
      removeItem,
      refresh,
      clearError: () => setError(null),
    }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart 必須在 CartProvider 內使用。");
  return context;
}
