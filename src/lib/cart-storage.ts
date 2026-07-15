import type { LocalCartItem, StoredGuestCart } from "./types";

export const CART_STORAGE_KEY = "ai-try-on-cart-v1";
export const MAX_CART_LINES = 50;
export const MAX_CART_QUANTITY = 99;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function normalizeCartItems(value: unknown): LocalCartItem[] {
  if (!Array.isArray(value)) return [];
  const quantities = new Map<string, number>();
  for (const item of value.slice(0, MAX_CART_LINES)) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { variantId?: unknown; quantity?: unknown };
    if (!isUuid(candidate.variantId) || !Number.isInteger(candidate.quantity)) continue;
    const quantity = Number(candidate.quantity);
    if (quantity < 1) continue;
    quantities.set(
      candidate.variantId,
      Math.min(MAX_CART_QUANTITY, (quantities.get(candidate.variantId) ?? 0) + quantity)
    );
  }
  return Array.from(quantities, ([variantId, quantity]) => ({ variantId, quantity }));
}

export function parseStrictCartItems(value: unknown): LocalCartItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_CART_LINES) return null;
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const candidate = item as { variantId?: unknown; quantity?: unknown };
    if (
      !isUuid(candidate.variantId) ||
      !Number.isInteger(candidate.quantity) ||
      Number(candidate.quantity) < 1 ||
      Number(candidate.quantity) > MAX_CART_QUANTITY
    ) {
      return null;
    }
  }
  return normalizeCartItems(value);
}

export function emptyGuestCart(guestCartId = crypto.randomUUID()): StoredGuestCart {
  return { version: 1, guestCartId, items: [] };
}

export function parseStoredGuestCart(raw: string | null): StoredGuestCart | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredGuestCart>;
    if (value.version !== 1 || !isUuid(value.guestCartId) || !Array.isArray(value.items)) {
      return null;
    }
    return { version: 1, guestCartId: value.guestCartId, items: normalizeCartItems(value.items) };
  } catch {
    return null;
  }
}

export function addLocalItem(cart: StoredGuestCart, variantId: string, quantity = 1): StoredGuestCart {
  return {
    ...cart,
    items: normalizeCartItems([...cart.items, { variantId, quantity }]),
  };
}

export function setLocalItem(cart: StoredGuestCart, variantId: string, quantity: number): StoredGuestCart {
  const remaining = cart.items.filter((item) => item.variantId !== variantId);
  return {
    ...cart,
    items: quantity < 1 ? remaining : normalizeCartItems([...remaining, { variantId, quantity }]),
  };
}

