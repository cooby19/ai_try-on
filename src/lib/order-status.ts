import type { OrderStatus, PaymentStatus } from "./types";

export function orderStatusLabel(status: OrderStatus): string {
  switch (status) {
    case "pending_payment":
      return "待付款";
    case "processing":
      return "處理中";
    case "payment_failed":
      return "付款失敗";
    case "cancellation_requested":
      return "取消審核中";
    case "cancelled":
      return "已取消";
    case "shipped":
      return "已出貨";
    case "completed":
      return "已完成";
    case "refund_pending":
      return "退款處理中";
    case "partially_refunded":
      return "部分退款";
    case "refunded":
      return "已退款";
    case "expired":
      return "已逾期";
  }
}

export function paymentStatusLabel(status: PaymentStatus): string {
  switch (status) {
    case "pending":
      return "待付款";
    case "succeeded":
      return "付款成功";
    case "failed":
      return "付款失敗";
    case "cancelled":
      return "已取消";
    case "expired":
      return "已逾期";
    case "refund_pending":
      return "退款處理中";
    case "partially_refunded":
      return "部分退款";
    case "refunded":
      return "已退款";
  }
}

export function statusTone(status: OrderStatus | PaymentStatus): string {
  if (status === "processing" || status === "succeeded" || status === "shipped" || status === "completed") {
    return "border-green-200 bg-green-50 text-green-800";
  }
  if (status === "payment_failed" || status === "failed") {
    return "border-red-200 bg-red-50 text-red-700";
  }
  if (status === "cancelled" || status === "expired") {
    return "border-stone-200 bg-stone-100 text-stone-600";
  }
  if (status === "refunded" || status === "partially_refunded") {
    return "border-blue-200 bg-blue-50 text-blue-700";
  }
  return "border-amber-200 bg-amber-50 text-amber-700";
}
