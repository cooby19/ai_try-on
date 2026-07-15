import { describe, expect, it } from "vitest";
import {
  addLocalItem,
  normalizeCartItems,
  parseStoredGuestCart,
  parseStrictCartItems,
  setLocalItem,
} from "./cart-storage";

const VARIANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VARIANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("本機購物車資料邊界", () => {
  it("相同規格去重加總，且最多保存 99 件", () => {
    expect(normalizeCartItems([
      { variantId: VARIANT_A, quantity: 70 },
      { variantId: VARIANT_A, quantity: 40 },
      { variantId: VARIANT_B, quantity: 2 },
    ])).toEqual([
      { variantId: VARIANT_A, quantity: 99 },
      { variantId: VARIANT_B, quantity: 2 },
    ]);
  });

  it("異常 JSON、偽造 UUID 與非法數量不會進入購物車", () => {
    expect(parseStoredGuestCart("not-json")).toBeNull();
    expect(parseStrictCartItems([{ variantId: "not-a-uuid", quantity: 1 }])).toBeNull();
    expect(parseStrictCartItems([{ variantId: VARIANT_A, quantity: 100 }])).toBeNull();
    expect(normalizeCartItems([
      { variantId: "not-a-uuid", quantity: 1 },
      { variantId: VARIANT_A, quantity: -1 },
    ])).toEqual([]);
  });

  it("localStorage 格式只保留規格與數量，不採用前端價格", () => {
    const parsed = parseStoredGuestCart(JSON.stringify({
      version: 1,
      guestCartId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      items: [{ variantId: VARIANT_A, quantity: 2, price: 1, name: "偽造商品" }],
    }));
    expect(parsed).toEqual({
      version: 1,
      guestCartId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      items: [{ variantId: VARIANT_A, quantity: 2 }],
    });
  });

  it("加入、設定與移除都維持單一規格列", () => {
    const initial = {
      version: 1 as const,
      guestCartId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      items: [{ variantId: VARIANT_A, quantity: 1 }],
    };
    const added = addLocalItem(initial, VARIANT_A, 2);
    expect(added.items).toEqual([{ variantId: VARIANT_A, quantity: 3 }]);
    expect(setLocalItem(added, VARIANT_A, 5).items).toEqual([{ variantId: VARIANT_A, quantity: 5 }]);
    expect(setLocalItem(added, VARIANT_A, 0).items).toEqual([]);
  });
});

