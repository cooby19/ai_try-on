import "server-only";

import { AppError } from "./http";
import { validateOperationReason } from "./operations-rules";
import { getSupabaseAdmin } from "./supabase";
import type { RefundRequestStatus, RefundRequestView } from "./types";

interface OperationRpcResult {
  status?: string;
  requestId?: string;
  reason?: string;
  refundRequired?: boolean;
}

interface RefundRow {
  id: string;
  order_id: string;
  request_type: "cancellation" | "refund";
  status: RefundRequestStatus;
  reason: string;
  requested_amount: number | string;
  approved_amount: number | string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

export async function requestOrderOperation(
  userId: string,
  orderId: string,
  kind: "cancellation" | "refund",
  rawReason: unknown
): Promise<{ outcome: "cancelled" | "requested"; requestId: string; refundRequired: boolean }> {
  const reason = validateOperationReason(rawReason);
  if (!isUuid(orderId) || !reason) throw new AppError(400, "請提供 3–1000 字的取消／退款原因。");

  const functionName = kind === "cancellation" ? "request_order_cancellation" : "request_order_refund";
  const { data, error } = await getSupabaseAdmin().rpc(functionName, {
    p_user_id: userId,
    p_order_id: orderId,
    p_reason: reason,
  });
  if (error) throw new AppError(500, `申請處理失敗：${error.message}`);
  const result = data as OperationRpcResult | null;
  switch (result?.status) {
    case "cancelled":
    case "requested":
      if (!result.requestId) throw new AppError(500, "申請處理回應不完整。");
      return {
        outcome: result.status,
        requestId: result.requestId,
        refundRequired: Boolean(result.refundRequired),
      };
    case "not_found":
      throw new AppError(404, "找不到這筆訂單。");
    case "already_requested":
      throw new AppError(409, "這筆訂單已有處理中的取消或退款申請。");
    case "not_eligible":
      throw new AppError(422, kind === "cancellation"
        ? "此訂單已超過取消期限，請改由客服協助。"
        : "此訂單不在可申請退款的期限或狀態內。");
    case "invalid_input":
      throw new AppError(400, "取消／退款申請資料不正確。");
    default:
      throw new AppError(500, "取消／退款申請失敗，請稍後再試。");
  }
}

export async function getRefundRequestsForOrder(userId: string, orderId: string): Promise<RefundRequestView[]> {
  if (!isUuid(orderId)) return [];
  const { data, error } = await getSupabaseAdmin()
    .from("refund_requests")
    .select("id, order_id, request_type, status, reason, requested_amount, approved_amount, review_note, created_at, updated_at")
    .eq("user_id", userId)
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .returns<RefundRow[]>();
  if (error) throw new AppError(500, `退款申請讀取失敗：${error.message}`);
  return (data ?? []).map((row) => ({
    id: row.id,
    orderId: row.order_id,
    requestType: row.request_type,
    status: row.status,
    reason: row.reason,
    requestedAmount: Number(row.requested_amount),
    approvedAmount: row.approved_amount === null ? null : Number(row.approved_amount),
    reviewNote: row.review_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
