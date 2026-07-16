import type { OrderStatus } from "./types";

export const CANCELLATION_WINDOW_MS = 30 * 60 * 1000;
export const REFUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_OPERATION_REASON_LENGTH = 3;
export const MAX_OPERATION_REASON_LENGTH = 1000;

export type Eligibility =
  | { eligible: true; mode: "immediate" | "review" }
  | { eligible: false; reason: "already_terminal" | "window_closed" | "wrong_status" | "missing_timestamp" };

export function cancellationEligibility(input: {
  status: OrderStatus;
  paidAt: string | null;
  now?: number;
}): Eligibility {
  if (input.status === "pending_payment" || input.status === "payment_failed") {
    return { eligible: true, mode: "immediate" };
  }
  if (["cancelled", "expired", "refunded"].includes(input.status)) {
    return { eligible: false, reason: "already_terminal" };
  }
  if (input.status !== "processing") return { eligible: false, reason: "wrong_status" };
  const paidAt = input.paidAt ? Date.parse(input.paidAt) : Number.NaN;
  if (!Number.isFinite(paidAt)) return { eligible: false, reason: "missing_timestamp" };
  return (input.now ?? Date.now()) - paidAt <= CANCELLATION_WINDOW_MS
    ? { eligible: true, mode: "review" }
    : { eligible: false, reason: "window_closed" };
}

export function refundEligibility(input: {
  status: OrderStatus;
  completedAt: string | null;
  now?: number;
}): Eligibility {
  if (["cancelled", "expired", "refunded"].includes(input.status)) {
    return { eligible: false, reason: "already_terminal" };
  }
  if (input.status !== "completed") return { eligible: false, reason: "wrong_status" };
  const completedAt = input.completedAt ? Date.parse(input.completedAt) : Number.NaN;
  if (!Number.isFinite(completedAt)) return { eligible: false, reason: "missing_timestamp" };
  return (input.now ?? Date.now()) - completedAt <= REFUND_WINDOW_MS
    ? { eligible: true, mode: "review" }
    : { eligible: false, reason: "window_closed" };
}

export function validateOperationReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return reason.length >= MIN_OPERATION_REASON_LENGTH && reason.length <= MAX_OPERATION_REASON_LENGTH
    ? reason
    : null;
}
