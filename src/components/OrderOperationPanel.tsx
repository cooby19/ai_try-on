"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { OrderStatus, RefundRequestView } from "@/lib/types";

export default function OrderOperationPanel({
  orderId,
  orderStatus,
  requests,
}: {
  orderId: string;
  orderStatus: OrderStatus;
  requests: RefundRequestView[];
}) {
  const router = useRouter();
  const [kind, setKind] = useState<"cancellation" | "refund">("cancellation");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const hasActive = requests.some((item) => ["requested", "reviewing", "approved", "processing"].includes(item.status));
  const canCancel = ["pending_payment", "payment_failed", "processing"].includes(orderStatus);
  const canRefund = orderStatus === "completed";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const operationKind = canRefund && !canCancel ? "refund" : kind;
      const response = await fetch(`/api/orders/${orderId}/${operationKind}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const body = (await response.json()) as { message?: string; outcome?: string };
      if (!response.ok) throw new Error(body.message ?? "申請送出失敗。");
      setReason("");
      setMessage(body.outcome === "cancelled" ? "訂單已取消。" : "申請已送出，營運人員將進行審核。");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "申請送出失敗。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-stone-200 bg-white p-5">
      <h2 className="font-semibold">取消與退款</h2>
      <p className="mt-1 text-xs leading-5 text-stone-500">
        未付款可立即取消；付款後 30 分鐘內可申請取消；完成後 7 天內可申請退款。已付款款項一律由營運審核。
      </p>
      {requests.length > 0 && (
        <ul className="mt-4 space-y-2 text-sm">
          {requests.map((item) => (
            <li key={item.id} className="rounded-lg bg-stone-50 px-3 py-2">
              <span className="font-medium">{item.requestType === "cancellation" ? "取消" : "退款"}</span>
              <span className="ml-2 text-stone-500">狀態：{refundStatusLabel(item.status)}</span>
              {item.reviewNote && <p className="mt-1 text-xs text-stone-500">審核說明：{item.reviewNote}</p>}
            </li>
          ))}
        </ul>
      )}
      {!hasActive && (canCancel || canRefund) && (
        <form className="mt-4 space-y-3" onSubmit={submit}>
          {canCancel && canRefund && (
            <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className="rounded-lg border border-stone-300 px-3 py-2 text-sm">
              <option value="cancellation">取消訂單</option>
              <option value="refund">申請退款</option>
            </select>
          )}
          <textarea
            required
            minLength={3}
            maxLength={1000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="請說明原因（3–1000 字）"
            className="min-h-24 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
          <button disabled={busy || reason.trim().length < 3} className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-medium hover:bg-stone-50 disabled:opacity-50">
            {busy ? "送出中…" : canRefund && !canCancel ? "送出退款申請" : kind === "cancellation" ? "送出取消申請" : "送出退款申請"}
          </button>
        </form>
      )}
      {message && <p role="status" className="mt-3 text-sm text-stone-700">{message}</p>}
    </section>
  );
}

function refundStatusLabel(status: RefundRequestView["status"]): string {
  const labels: Record<RefundRequestView["status"], string> = {
    requested: "待審核", reviewing: "審核中", approved: "已核准", processing: "退款處理中",
    succeeded: "已完成", rejected: "未通過", failed: "處理失敗", cancelled: "已撤回",
  };
  return labels[status];
}
