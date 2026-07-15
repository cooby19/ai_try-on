import { describe, expect, it } from "vitest";
import { orderStatusLabel, paymentStatusLabel } from "./order-status";

describe("訂單與付款狀態顯示", () => {
  it("顯示成功付款後的處理中狀態", () => {
    expect(orderStatusLabel("processing")).toBe("處理中");
    expect(paymentStatusLabel("succeeded")).toBe("付款成功");
  });

  it("區分失敗、取消與逾期", () => {
    expect(orderStatusLabel("payment_failed")).toBe("付款失敗");
    expect(paymentStatusLabel("cancelled")).toBe("已取消");
    expect(paymentStatusLabel("expired")).toBe("已逾期");
  });
});
