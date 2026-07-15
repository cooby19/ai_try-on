import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderFromCart } from "./orders";

vi.mock("server-only", () => ({}));

const rpc = vi.fn();

vi.mock("./supabase", () => ({ getSupabaseAdmin: vi.fn(() => ({ rpc })) }));

const validInput = {
  shippingMethodCode: "standard_delivery",
  recipientName: "王小明",
  recipientPhone: "0912345678",
  recipientAddress: "台北市信義區市府路 1 號",
  idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

beforeEach(() => vi.clearAllMocks());

describe("建立訂單 RPC 結果處理", () => {
  it("只將伺服器確認的訂單識別碼回傳給呼叫端", async () => {
    rpc.mockResolvedValue({ data: { status: "success", orderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", orderNumber: "ORD-123", reused: false }, error: null });
    await expect(createOrderFromCart("user-id", validInput)).resolves.toEqual({
      orderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      orderNumber: "ORD-123",
      reused: false,
    });
    expect(rpc).toHaveBeenCalledWith("create_order_from_cart", expect.objectContaining({
      p_user_id: "user-id",
      p_shipping_method_code: "standard_delivery",
      p_recipient_phone: "0912345678",
    }));
  });

  it("將庫存不足轉為可處理的衝突錯誤", async () => {
    rpc.mockResolvedValue({ data: { status: "insufficient_stock", availableQuantity: 0 }, error: null });
    await expect(createOrderFromCart("user-id", validInput)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("庫存不足"),
    });
  });

  it("網路重送同一冪等識別碼時採用已建立的訂單", async () => {
    rpc.mockResolvedValue({ data: { status: "success", orderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", orderNumber: "ORD-123", reused: true }, error: null });
    await expect(createOrderFromCart("user-id", validInput)).resolves.toMatchObject({ reused: true, orderNumber: "ORD-123" });
  });

  it("不接受偽造的運送方式、金額或冪等識別碼", async () => {
    await expect(createOrderFromCart("user-id", { ...validInput, shippingMethodCode: "bad code", total: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(createOrderFromCart("user-id", { ...validInput, idempotencyKey: "not-a-uuid" })).rejects.toMatchObject({ status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });
});
