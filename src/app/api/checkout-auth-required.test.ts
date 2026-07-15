import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/http";
import { requireUser } from "@/lib/user";
import { GET as addressesGet } from "./addresses/route";
import { GET as shippingGet } from "./shipping-methods/route";
import { GET as ordersGet, POST as ordersPost } from "./orders/route";
import { POST as mockPaymentPost } from "./orders/[orderId]/mock-payment/route";
import { PATCH as addressPatch } from "./addresses/[addressId]/route";
import { getAddressesForUser, updateAddressForUser } from "@/lib/addresses";
import { getShippingMethods, createOrderFromCart, getOrdersForUser } from "@/lib/orders";
import { simulateMockPaymentForUser } from "@/lib/mock-payments";

vi.mock("@/lib/user", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/addresses", () => ({ getAddressesForUser: vi.fn(), createAddressForUser: vi.fn(), updateAddressForUser: vi.fn(), deleteAddressForUser: vi.fn() }));
vi.mock("@/lib/orders", () => ({ getShippingMethods: vi.fn(), createOrderFromCart: vi.fn(), getOrdersForUser: vi.fn() }));
vi.mock("@/lib/mock-payments", () => ({ simulateMockPaymentForUser: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockRejectedValue(new AppError(401, "請先登入後再結帳。"));
});

describe("結帳 API 登入保護", () => {
  it("未登入不能讀取地址、運送方式、訂單或建立訂單", async () => {
    const responses = await Promise.all([
      addressesGet(),
      shippingGet(),
      ordersGet(),
      ordersPost(new Request("https://shop.test/api/orders", { method: "POST", body: "{}" })),
      mockPaymentPost(
        new Request("https://shop.test/api/orders/order-id/mock-payment", { method: "POST", body: "{}" }),
        { params: Promise.resolve({ orderId: "order-id" }) }
      ),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ status: "failed" });
    }
    expect(getAddressesForUser).not.toHaveBeenCalled();
    expect(getShippingMethods).not.toHaveBeenCalled();
    expect(createOrderFromCart).not.toHaveBeenCalled();
    expect(getOrdersForUser).not.toHaveBeenCalled();
    expect(simulateMockPaymentForUser).not.toHaveBeenCalled();
  });

  it("地址更新只會使用目前 session 的使用者 ID", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "session-user" } as never);
    vi.mocked(updateAddressForUser).mockResolvedValue({ id: "address-id" } as never);
    const response = await addressPatch(new Request("https://shop.test/api/addresses/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      method: "PATCH",
      body: JSON.stringify({ userId: "attacker-choice", label: "住家" }),
    }), { params: Promise.resolve({ addressId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }) });
    expect(response.status).toBe(200);
    expect(updateAddressForUser).toHaveBeenCalledWith(
      "session-user",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ userId: "attacker-choice" })
    );
  });
});
