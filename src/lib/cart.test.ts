import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabaseAdmin } from "./supabase";
import { buildCartView, getCartView, resolveGuestCart } from "./cart";

vi.mock("server-only", () => ({}));
vi.mock("./supabase", () => ({ getSupabaseAdmin: vi.fn() }));

afterEach(() => vi.clearAllMocks());

describe("購物車伺服器 DTO", () => {
  it("總額只加總可購買品項，商品數量仍包含待移除的缺貨品項", () => {
    const cart = buildCartView([
      {
        variantId: "a",
        productId: "p1",
        name: "商品 A",
        imageUrl: "/a.jpg",
        size: "M",
        unitPrice: 590,
        quantity: 2,
        maxQuantity: 10,
        available: true,
        unavailableReason: null,
        lineSubtotal: 1180,
      },
      {
        variantId: "b",
        productId: "p2",
        name: "商品 B",
        imageUrl: "/b.jpg",
        size: "L",
        unitPrice: 9999,
        quantity: 1,
        maxQuantity: 0,
        available: false,
        unavailableReason: "out_of_stock",
        lineSubtotal: 0,
      },
    ]);
    expect(cart.itemCount).toBe(3);
    expect(cart.subtotal).toBe(1180);
  });

  it("登入購物車先用目前 user_id 對 carts 過濾，不存在時回空購物車", async () => {
    const reconcile = vi.fn().mockResolvedValue({ data: 0, error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    vi.mocked(getSupabaseAdmin).mockReturnValue({ rpc: reconcile, from } as never);

    expect(await getCartView("current-auth-user")).toEqual({
      items: [], itemCount: 0, subtotal: 0, notices: [],
    });
    expect(reconcile).toHaveBeenCalledWith("reconcile_cart_stock", { p_user_id: "current-auth-user" });
    expect(eq).toHaveBeenCalledWith("user_id", "current-auth-user");
  });

  it("訪客解析以可售量（扣除他人保留量後）下修超量數量", async () => {
    const variants = [{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      product_id: "product-1",
      size: "M",
      stock_quantity: 3,
      is_active: true,
      products: { id: "product-1", name: "真實名稱", price: "590.00", image_url: "/real.jpg", is_active: true },
    }];
    const returns = vi.fn().mockResolvedValue({ data: variants, error: null });
    const inFilter = vi.fn().mockReturnValue({ returns });
    const select = vi.fn().mockReturnValue({ in: inFilter });
    const rpc = vi.fn().mockResolvedValue({
      data: [{ variant_id: variants[0].id, available_quantity: 1 }],
      error: null,
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: vi.fn().mockReturnValue({ select }), rpc } as never);

    const result = await resolveGuestCart([{ variantId: variants[0].id, quantity: 9 }]);
    expect(result.items[0]).toMatchObject({ unitPrice: 590, quantity: 1, maxQuantity: 1, lineSubtotal: 590 });
    expect(result.notices[0]).toContain("依庫存調整");
    expect(rpc).toHaveBeenCalledWith("get_available_inventory", { p_variant_ids: [variants[0].id] });
  });
});
