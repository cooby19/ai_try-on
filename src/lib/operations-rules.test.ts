import { describe, expect, it } from "vitest";
import {
  CANCELLATION_WINDOW_MS,
  REFUND_WINDOW_MS,
  cancellationEligibility,
  refundEligibility,
  validateOperationReason,
} from "./operations-rules";

describe("取消與退款規則", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");

  it("未付款訂單可立即取消", () => {
    expect(cancellationEligibility({ status: "pending_payment", paidAt: null, now }))
      .toEqual({ eligible: true, mode: "immediate" });
  });

  it("已付款只在 30 分鐘內進人工審核", () => {
    expect(cancellationEligibility({
      status: "processing",
      paidAt: new Date(now - CANCELLATION_WINDOW_MS).toISOString(),
      now,
    })).toEqual({ eligible: true, mode: "review" });
    expect(cancellationEligibility({
      status: "processing",
      paidAt: new Date(now - CANCELLATION_WINDOW_MS - 1).toISOString(),
      now,
    })).toEqual({ eligible: false, reason: "window_closed" });
  });

  it("完成後 7 天內可申請退款", () => {
    expect(refundEligibility({
      status: "completed",
      completedAt: new Date(now - REFUND_WINDOW_MS + 1).toISOString(),
      now,
    })).toEqual({ eligible: true, mode: "review" });
  });

  it("拒絕空白與過長原因", () => {
    expect(validateOperationReason("  尺寸不合  ")).toBe("尺寸不合");
    expect(validateOperationReason("  ")).toBeNull();
    expect(validateOperationReason("x".repeat(1001))).toBeNull();
  });
});
