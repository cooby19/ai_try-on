import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOrdersForUser } from "./orders";

vi.mock("server-only", () => ({}));

const returns = vi.fn();
const query = {
  select: vi.fn(),
  eq: vi.fn(),
  order: vi.fn(),
  in: vi.fn(),
  returns,
};
for (const method of [query.select, query.eq, query.order, query.in]) method.mockReturnValue(query);
const from = vi.fn(() => query);

vi.mock("./supabase", () => ({ getSupabaseAdmin: vi.fn(() => ({ from })) }));

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of [query.select, query.eq, query.order, query.in]) method.mockReturnValue(query);
});

describe("歷史訂單", () => {
  it("只用目前使用者 ID 查詢並合併付款狀態", async () => {
    returns
      .mockResolvedValueOnce({
        data: [
          { id: "order-1", order_number: "ORD-1", status: "processing", total: "1280.00", created_at: "2026-07-15T04:00:00.000Z" },
          { id: "order-2", order_number: "ORD-2", status: "pending_payment", total: 980, created_at: "2026-07-14T04:00:00.000Z" },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: [{ order_id: "order-1", status: "succeeded" }], error: null });

    await expect(getOrdersForUser("session-user")).resolves.toEqual([
      expect.objectContaining({ id: "order-1", status: "processing", paymentStatus: "succeeded", total: 1280 }),
      expect.objectContaining({ id: "order-2", status: "pending_payment", paymentStatus: "pending", total: 980 }),
    ]);
    expect(query.eq).toHaveBeenCalledWith("user_id", "session-user");
    expect(query.in).toHaveBeenCalledWith("order_id", ["order-1", "order-2"]);
  });

  it("沒有訂單時不額外查詢付款表", async () => {
    returns.mockResolvedValueOnce({ data: [], error: null });
    await expect(getOrdersForUser("session-user")).resolves.toEqual([]);
    expect(from).toHaveBeenCalledTimes(1);
  });
});
