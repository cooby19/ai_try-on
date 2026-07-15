import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/http";
import { requireUser } from "@/lib/user";
import {
  addCartItemForUser,
  deleteCartItemForUser,
  getCartView,
  mergeGuestCartForUser,
  setCartItemForUser,
} from "@/lib/cart";
import { GET } from "./route";
import { POST as ADD } from "./items/route";
import { DELETE, PATCH } from "./items/[variantId]/route";
import { POST as MERGE } from "./merge/route";

vi.mock("@/lib/user", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/cart", () => ({
  CartError: class CartError extends Error {},
  getCartView: vi.fn(),
  addCartItemForUser: vi.fn(),
  setCartItemForUser: vi.fn(),
  deleteCartItemForUser: vi.fn(),
  mergeGuestCartForUser: vi.fn(),
}));

const USER_ID = "current-auth-user";
const VARIANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CART = { items: [], itemCount: 0, subtotal: 0, notices: [] };

afterEach(() => vi.clearAllMocks());

describe("購物車 API 授權與所有權", () => {
  it("未登入時 GET 回 401，完全不讀資料庫購物車", async () => {
    vi.mocked(requireUser).mockRejectedValue(new AppError(401, "請先登入"));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(getCartView).not.toHaveBeenCalled();
  });

  it("加入商品只使用 session user，不接受 body 內偽造 userId", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: USER_ID } as never);
    vi.mocked(addCartItemForUser).mockResolvedValue(CART);
    const response = await ADD(new Request("http://localhost/api/cart/items", {
      method: "POST",
      body: JSON.stringify({ variantId: VARIANT_ID, quantity: 2, userId: "attacker-choice" }),
    }));
    expect(response.status).toBe(200);
    expect(addCartItemForUser).toHaveBeenCalledWith(USER_ID, VARIANT_ID, 2);
  });

  it("更新與刪除都把 session user 傳入所有權邊界", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: USER_ID } as never);
    vi.mocked(setCartItemForUser).mockResolvedValue(CART);
    vi.mocked(deleteCartItemForUser).mockResolvedValue(CART);
    const context = { params: Promise.resolve({ variantId: VARIANT_ID }) };

    expect((await PATCH(new Request("http://localhost", {
      method: "PATCH", body: JSON.stringify({ quantity: 3 }),
    }), context)).status).toBe(200);
    expect((await DELETE(new Request("http://localhost", { method: "DELETE" }), context)).status).toBe(200);
    expect(setCartItemForUser).toHaveBeenCalledWith(USER_ID, VARIANT_ID, 3);
    expect(deleteCartItemForUser).toHaveBeenCalledWith(USER_ID, VARIANT_ID);
  });

  it("登入合併使用 session user、guestCartId 與已正規化品項", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: USER_ID } as never);
    vi.mocked(mergeGuestCartForUser).mockResolvedValue(CART);
    const response = await MERGE(new Request("http://localhost/api/cart/merge", {
      method: "POST",
      body: JSON.stringify({
        guestCartId: GUEST_ID,
        userId: "attacker-choice",
        items: [
          { variantId: VARIANT_ID, quantity: 1 },
          { variantId: VARIANT_ID, quantity: 2 },
        ],
      }),
    }));
    expect(response.status).toBe(200);
    expect(mergeGuestCartForUser).toHaveBeenCalledWith(USER_ID, GUEST_ID, [
      { variantId: VARIANT_ID, quantity: 3 },
    ]);
  });
});

