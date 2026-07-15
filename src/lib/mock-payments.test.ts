import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMockPaymentWebhook,
  processMockPaymentWebhook,
  signMockPaymentWebhook,
  simulateMockPaymentForUser,
} from "./mock-payments";

vi.mock("server-only", () => ({}));

const rpc = vi.fn();
const maybeSingle = vi.fn();
const query = {
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle,
};
query.select.mockReturnValue(query);
query.eq.mockReturnValue(query);
const from = vi.fn(() => query);

vi.mock("./supabase", () => ({ getSupabaseAdmin: vi.fn(() => ({ rpc, from })) }));

const orderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  vi.stubEnv("MOCK_PAYMENT_WEBHOOK_SECRET", "test-secret-with-at-least-thirty-two-characters");
});

describe("Mock payment Webhook", () => {
  it("簽章正確時把 provider 事件交給原子 RPC", async () => {
    const payload = buildMockPaymentWebhook(orderId, "success");
    const rawBody = JSON.stringify(payload);
    rpc.mockResolvedValue({
      data: { status: "success", orderStatus: "processing", paymentStatus: "succeeded", reused: false, ignored: false },
      error: null,
    });

    await expect(processMockPaymentWebhook(rawBody, signMockPaymentWebhook(rawBody))).resolves.toEqual({
      orderStatus: "processing",
      paymentStatus: "succeeded",
      reused: false,
      ignored: false,
    });
    expect(rpc).toHaveBeenCalledWith("process_mock_payment_webhook", expect.objectContaining({
      p_event_id: payload.eventId,
      p_order_id: orderId,
      p_transaction_id: payload.transactionId,
      p_result: "succeeded",
    }));
  });

  it("拒絕無效簽章，不接觸資料庫", async () => {
    const rawBody = JSON.stringify(buildMockPaymentWebhook(orderId, "failure"));
    await expect(processMockPaymentWebhook(rawBody, "0".repeat(64))).rejects.toMatchObject({ status: 401 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("相同事件重送時回傳 RPC 的冪等結果", async () => {
    const rawBody = JSON.stringify(buildMockPaymentWebhook(orderId, "cancelled"));
    rpc.mockResolvedValue({
      data: { status: "success", orderStatus: "cancelled", paymentStatus: "cancelled", reused: true, ignored: false },
      error: null,
    });
    await expect(processMockPaymentWebhook(rawBody, signMockPaymentWebhook(rawBody))).resolves.toMatchObject({ reused: true });
  });

  it("模擬入口只允許目前使用者的待付款訂單", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(simulateMockPaymentForUser("session-user", orderId, "success")).rejects.toMatchObject({ status: 404 });
    expect(rpc).not.toHaveBeenCalled();

    maybeSingle.mockResolvedValue({ data: { id: orderId, status: "processing" }, error: null });
    await expect(simulateMockPaymentForUser("session-user", orderId, "success")).rejects.toMatchObject({ status: 409 });
    expect(query.eq).toHaveBeenCalledWith("user_id", "session-user");
  });

  it("不接受前端自訂付款結果", async () => {
    await expect(simulateMockPaymentForUser("session-user", orderId, "paid-but-forged")).rejects.toMatchObject({ status: 400 });
    expect(from).not.toHaveBeenCalled();
  });
});
