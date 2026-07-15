"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { MockPaymentOutcome } from "@/lib/types";

const currency = new Intl.NumberFormat("zh-TW", {
  style: "currency",
  currency: "TWD",
  maximumFractionDigits: 0,
});

const options: Array<{
  outcome: MockPaymentOutcome;
  label: string;
  description: string;
  className: string;
}> = [
  {
    outcome: "success",
    label: "模擬付款成功",
    description: "訂單將進入處理中，並記錄模擬交易編號與付款時間。",
    className: "border-green-300 bg-green-50 text-green-800 hover:bg-green-100",
  },
  {
    outcome: "failure",
    label: "模擬付款失敗",
    description: "訂單將標示付款失敗，並保存模擬拒絕原因。",
    className: "border-red-300 bg-red-50 text-red-700 hover:bg-red-100",
  },
  {
    outcome: "cancelled",
    label: "模擬使用者取消",
    description: "訂單與付款狀態將更新為已取消。",
    className: "border-stone-300 bg-white text-stone-700 hover:bg-stone-100",
  },
  {
    outcome: "expired",
    label: "模擬付款逾期",
    description: "訂單與付款狀態將更新為已逾期。",
    className: "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100",
  },
];

export default function MockPaymentPanel({
  orderId,
  orderNumber,
  total,
}: {
  orderId: string;
  orderNumber: string;
  total: number;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState<MockPaymentOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function simulate(outcome: MockPaymentOutcome) {
    setSubmitting(outcome);
    setError(null);
    try {
      const response = await fetch(`/api/orders/${orderId}/mock-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      const body = (await response.json().catch(() => null)) as {
        paymentStatus?: string;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(body?.message ?? "模擬付款失敗，請稍後再試。");
      router.replace(`/orders/${orderId}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模擬付款失敗，請稍後再試。");
      setSubmitting(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5 text-blue-900">
        <p className="text-xs font-semibold uppercase tracking-widest">Mock Payment Sandbox</p>
        <h1 className="mt-2 text-2xl font-semibold">選擇要模擬的付款結果</h1>
        <p className="mt-2 text-sm leading-6">
          此頁只測試訂單與 Webhook 流程，不會連線至第三方金流，也不會進行實際扣款。
        </p>
      </div>

      <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-6">
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div><dt className="text-stone-500">訂單編號</dt><dd className="mt-1 font-medium">{orderNumber}</dd></div>
          <div><dt className="text-stone-500">模擬付款金額</dt><dd className="mt-1 text-lg font-semibold">{currency.format(total)}</dd></div>
        </dl>

        {error && <div role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {options.map((option) => (
            <button
              key={option.outcome}
              type="button"
              disabled={submitting !== null}
              onClick={() => void simulate(option.outcome)}
              className={`rounded-xl border p-4 text-left transition disabled:cursor-wait disabled:opacity-50 ${option.className}`}
            >
              <span className="block font-semibold">
                {submitting === option.outcome ? "正在處理 Webhook…" : option.label}
              </span>
              <span className="mt-1 block text-xs leading-5 opacity-80">{option.description}</span>
            </button>
          ))}
        </div>

        <div className="mt-6 border-t border-stone-200 pt-4 text-center">
          <Link href={`/orders/${orderId}`} className="text-sm text-stone-500 hover:underline">暫不付款，查看訂單</Link>
        </div>
      </section>
    </div>
  );
}
