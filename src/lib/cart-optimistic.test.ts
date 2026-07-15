import { describe, expect, it } from "vitest";
import { guestCartFromView, projectCart, projectGuestCart, requestQuantity } from "./cart-optimistic";
import type { CartView } from "./types";

const CART: CartView = {
  items: [{
    variantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    productId: "product-a",
    name: "商品 A",
    imageUrl: "/a.jpg",
    size: "M",
    unitPrice: 590,
    quantity: 1,
    maxQuantity: 3,
    available: true,
    unavailableReason: null,
    lineSubtotal: 590,
  }],
  itemCount: 1,
  subtotal: 590,
  notices: [],
};

const VARIANT_ID = CART.items[0].variantId;

describe("樂觀購物車投影", () => {
  it("快速增加數量時立即重算數量、總額與徽章數量", () => {
    const cart = projectCart(CART, [
      { id: "one", type: "adjust", variantId: VARIANT_ID, delta: 1 },
      { id: "two", type: "adjust", variantId: VARIANT_ID, delta: 1 },
    ]);

    expect(cart.items[0]).toMatchObject({ quantity: 3, lineSubtotal: 1770 });
    expect(cart).toMatchObject({ itemCount: 3, subtotal: 1770 });
  });

  it("移除品項會立即將其從投影與徽章中移除", () => {
    const cart = projectCart(CART, [{ id: "remove", type: "remove", variantId: VARIANT_ID }]);
    expect(cart).toEqual({ items: [], itemCount: 0, subtotal: 0, notices: [] });
  });

  it("失敗操作移除後，後續增量會依已確認數量重新計算", () => {
    const laterIntent = { id: "two", type: "adjust", variantId: VARIANT_ID, delta: 1 } as const;
    expect(projectCart(CART, [laterIntent]).items[0].quantity).toBe(2);
    expect(requestQuantity(CART, laterIntent)).toBe(2);
  });

  it("訪客 cart 在背景驗證前即寫入意圖，且可採用伺服器校正結果", () => {
    const guest = { version: 1 as const, guestCartId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", items: [{ variantId: VARIANT_ID, quantity: 1 }] };
    const optimistic = projectGuestCart(guest, [{ id: "one", type: "adjust", variantId: VARIANT_ID, delta: 1 }]);
    expect(optimistic.items[0].quantity).toBe(2);
    expect(guestCartFromView(optimistic, projectCart(CART, [])).items[0].quantity).toBe(1);
  });
});
