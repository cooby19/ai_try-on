import "server-only";

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { AppError } from "./http";
import { getSupabaseAdmin } from "./supabase";
import type { MockPaymentOutcome, OrderStatus, PaymentStatus } from "./types";

export const MOCK_PAYMENT_SIGNATURE_HEADER = "x-mock-payment-signature";
const MAX_WEBHOOK_BYTES = 20_000;

type MockWebhookResult = Extract<PaymentStatus, "succeeded" | "failed" | "cancelled" | "expired">;

export interface MockPaymentWebhookPayload {
  eventId: string;
  orderId: string;
  transactionId: string;
  result: MockWebhookResult;
  failureReason: string | null;
  occurredAt: string;
}

export interface MockPaymentResult {
  orderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  reused: boolean;
  ignored: boolean;
}

interface ProcessPaymentRpcResult {
  status?: string;
  orderStatus?: OrderStatus;
  paymentStatus?: PaymentStatus;
  reused?: boolean;
  ignored?: boolean;
}

export class MockPaymentError extends AppError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "MockPaymentError";
  }
}

export function isMockPaymentEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ENABLE_MOCK_PAYMENTS_IN_PRODUCTION === "true";
}

function webhookSecret(): string {
  const secret = process.env.MOCK_PAYMENT_WEBHOOK_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV !== "production") return "local-mock-payment-webhook-secret-change-me";
  throw new MockPaymentError(500, "尚未設定 MOCK_PAYMENT_WEBHOOK_SECRET，無法驗證模擬付款結果。");
}

export function signMockPaymentWebhook(rawBody: string): string {
  return createHmac("sha256", webhookSecret()).update(rawBody).digest("hex");
}

export function verifyMockPaymentWebhook(rawBody: string, signature: string | null): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = signMockPaymentWebhook(rawBody);
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

export function buildMockPaymentWebhook(orderId: string, outcome: MockPaymentOutcome): MockPaymentWebhookPayload {
  if (!isUuid(orderId) || !isMockPaymentOutcome(outcome)) {
    throw new MockPaymentError(400, "模擬付款資料格式不正確。");
  }

  const resultByOutcome: Record<MockPaymentOutcome, MockWebhookResult> = {
    success: "succeeded",
    failure: "failed",
    cancelled: "cancelled",
    expired: "expired",
  };
  const reasonByOutcome: Record<MockPaymentOutcome, string | null> = {
    success: null,
    failure: "模擬交易遭拒",
    cancelled: "使用者取消模擬付款",
    expired: "模擬付款逾期",
  };

  return {
    eventId: randomUUID(),
    orderId,
    transactionId: `MOCK-${Date.now()}-${randomBytes(6).toString("hex").toUpperCase()}`,
    result: resultByOutcome[outcome],
    failureReason: reasonByOutcome[outcome],
    occurredAt: new Date().toISOString(),
  };
}

export async function processMockPaymentWebhook(rawBody: string, signature: string | null): Promise<MockPaymentResult> {
  if (!isMockPaymentEnabled()) {
    throw new MockPaymentError(403, "正式環境已停用模擬付款 Webhook。");
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) {
    throw new MockPaymentError(413, "模擬付款 Webhook 內容過大。");
  }
  if (!verifyMockPaymentWebhook(rawBody, signature)) {
    throw new MockPaymentError(401, "模擬付款 Webhook 簽章無效。");
  }

  const payload = parseWebhookPayload(rawBody);
  const { data, error } = await getSupabaseAdmin().rpc("process_mock_payment_webhook", {
    p_event_id: payload.eventId,
    p_order_id: payload.orderId,
    p_transaction_id: payload.transactionId,
    p_result: payload.result,
    p_failure_reason: payload.failureReason,
    p_payload: payload,
  });
  if (error) throw new MockPaymentError(500, `模擬付款結果處理失敗：${error.message}`);

  const result = data as ProcessPaymentRpcResult | null;
  switch (result?.status) {
    case "success":
      if (!result.orderStatus || !result.paymentStatus) {
        throw new MockPaymentError(500, "模擬付款處理回應不完整。");
      }
      return {
        orderStatus: result.orderStatus,
        paymentStatus: result.paymentStatus,
        reused: Boolean(result.reused),
        ignored: Boolean(result.ignored),
      };
    case "missing_order":
      throw new MockPaymentError(404, "找不到要付款的訂單。");
    case "event_conflict":
      throw new MockPaymentError(409, "Webhook 事件識別碼與既有付款事件衝突。");
    case "transaction_conflict":
      throw new MockPaymentError(409, "此訂單已有另一筆模擬交易結果。");
    case "reservation_unavailable":
      throw new MockPaymentError(409, "此訂單的庫存保留已失效，無法完成付款。");
    case "insufficient_stock":
      throw new MockPaymentError(409, "付款時庫存不足，請重新建立訂單。");
    case "invalid_input":
      throw new MockPaymentError(400, "模擬付款 Webhook 資料不正確。");
    default:
      throw new MockPaymentError(500, "模擬付款結果處理失敗，請稍後再試。");
  }
}

export async function simulateMockPaymentForUser(
  userId: string,
  orderId: string,
  outcome: unknown
): Promise<MockPaymentResult> {
  if (!isMockPaymentEnabled()) {
    throw new MockPaymentError(403, "正式環境已停用模擬付款；請先完成真實金流串接。");
  }
  if (!isUuid(orderId) || !isMockPaymentOutcome(outcome)) {
    throw new MockPaymentError(400, "模擬付款選項不正確。");
  }

  const { data: order, error } = await getSupabaseAdmin()
    .from("orders")
    .select("id, status")
    .eq("id", orderId)
    .eq("user_id", userId)
    .maybeSingle<{ id: string; status: OrderStatus }>();
  if (error) throw new MockPaymentError(500, `訂單讀取失敗：${error.message}`);
  if (!order) throw new MockPaymentError(404, "找不到要付款的訂單。");
  if (order.status !== "pending_payment") {
    throw new MockPaymentError(409, "這筆訂單已有付款結果，不能再次模擬付款。");
  }

  const payload = buildMockPaymentWebhook(orderId, outcome);
  const rawBody = JSON.stringify(payload);
  return processMockPaymentWebhook(rawBody, signMockPaymentWebhook(rawBody));
}

function parseWebhookPayload(rawBody: string): MockPaymentWebhookPayload {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new MockPaymentError(400, "模擬付款 Webhook 不是有效的 JSON。");
  }
  if (!value || typeof value !== "object") {
    throw new MockPaymentError(400, "模擬付款 Webhook 資料格式不正確。");
  }

  const body = value as Record<string, unknown>;
  const result = body.result;
  const failureReason = body.failureReason;
  if (
    typeof body.eventId !== "string" || !isUuid(body.eventId) ||
    typeof body.orderId !== "string" || !isUuid(body.orderId) ||
    typeof body.transactionId !== "string" || !/^MOCK-[0-9]{13}-[0-9A-F]{12}$/.test(body.transactionId) ||
    !isWebhookResult(result) ||
    (failureReason !== null && (typeof failureReason !== "string" || !failureReason.trim() || failureReason.length > 300)) ||
    typeof body.occurredAt !== "string" || !Number.isFinite(Date.parse(body.occurredAt))
  ) {
    throw new MockPaymentError(400, "模擬付款 Webhook 資料格式不正確。");
  }
  if (result === "succeeded" && failureReason !== null) {
    throw new MockPaymentError(400, "付款成功事件不可包含失敗原因。");
  }

  return {
    eventId: body.eventId,
    orderId: body.orderId,
    transactionId: body.transactionId,
    result,
    failureReason: failureReason as string | null,
    occurredAt: body.occurredAt,
  };
}

function isMockPaymentOutcome(value: unknown): value is MockPaymentOutcome {
  return value === "success" || value === "failure" || value === "cancelled" || value === "expired";
}

function isWebhookResult(value: unknown): value is MockWebhookResult {
  return value === "succeeded" || value === "failed" || value === "cancelled" || value === "expired";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
