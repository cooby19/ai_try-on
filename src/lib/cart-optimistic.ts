import type { CartItemView, CartView, LocalCartItem, StoredGuestCart } from "./types";

export type CartMutation =
  | { id: string; type: "add"; variantId: string; quantity: number }
  | { id: string; type: "adjust"; variantId: string; delta: number }
  | { id: string; type: "set"; variantId: string; quantity: number }
  | { id: string; type: "remove"; variantId: string };

function clampQuantity(item: CartItemView, quantity: number) {
  return Math.min(item.maxQuantity, Math.max(1, quantity));
}

function withQuantity(item: CartItemView, quantity: number): CartItemView {
  const nextQuantity = clampQuantity(item, quantity);
  return {
    ...item,
    quantity: nextQuantity,
    lineSubtotal: item.available ? item.unitPrice * nextQuantity : 0,
  };
}

export function projectCart(base: CartView, mutations: readonly CartMutation[]): CartView {
  let items = base.items;

  for (const mutation of mutations) {
    if (mutation.type === "add") continue;
    const index = items.findIndex((item) => item.variantId === mutation.variantId);
    if (index < 0) continue;

    if (mutation.type === "remove") {
      items = items.filter((item) => item.variantId !== mutation.variantId);
      continue;
    }

    const item = items[index];
    const quantity = mutation.type === "adjust"
      ? item.quantity + mutation.delta
      : mutation.quantity;
    const nextItem = withQuantity(item, quantity);
    items = [...items.slice(0, index), nextItem, ...items.slice(index + 1)];
  }

  return {
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    subtotal: items.reduce((sum, item) => sum + item.lineSubtotal, 0),
    notices: base.notices,
  };
}

export function projectGuestCart(base: StoredGuestCart, mutations: readonly CartMutation[]): StoredGuestCart {
  let items = base.items;

  for (const mutation of mutations) {
    const index = items.findIndex((item) => item.variantId === mutation.variantId);
    if (mutation.type === "remove") {
      if (index >= 0) items = items.filter((item) => item.variantId !== mutation.variantId);
      continue;
    }

    if (mutation.type === "add") {
      const quantity = index >= 0 ? items[index].quantity + mutation.quantity : mutation.quantity;
      const next = { variantId: mutation.variantId, quantity: Math.min(99, quantity) };
      items = index < 0
        ? [...items, next]
        : [...items.slice(0, index), next, ...items.slice(index + 1)];
      continue;
    }

    if (index < 0) continue;
    const quantity = mutation.type === "adjust"
      ? items[index].quantity + mutation.delta
      : mutation.quantity;
    if (quantity < 1) {
      items = items.filter((item) => item.variantId !== mutation.variantId);
      continue;
    }
    const next = { ...items[index], quantity: Math.min(99, quantity) };
    items = [...items.slice(0, index), next, ...items.slice(index + 1)];
  }

  return { ...base, items };
}

export function guestCartFromView(cart: StoredGuestCart, view: CartView): StoredGuestCart {
  const items: LocalCartItem[] = view.items.map(({ variantId, quantity }) => ({ variantId, quantity }));
  return { ...cart, items };
}

export function requestQuantity(base: CartView, mutation: CartMutation): number | null {
  const item = base.items.find((candidate) => candidate.variantId === mutation.variantId);
  if (mutation.type === "add") return mutation.quantity;
  if (mutation.type === "remove" || !item) return null;
  return mutation.type === "adjust"
    ? clampQuantity(item, item.quantity + mutation.delta)
    : clampQuantity(item, mutation.quantity);
}
