import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { orderStatusLabel, paymentStatusLabel, statusTone } from "@/lib/order-status";
import { getOrderForUser } from "@/lib/orders";
import { getCurrentUser } from "@/lib/user";
import type { OrderStatus } from "@/lib/types";

const currency = new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" });

export const metadata = { title: "訂單詳情｜樣衣間" };
export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?returnTo=${encodeURIComponent(`/orders/${orderId}`)}`);
  const order = await getOrderForUser(user.id, orderId);
  if (!order) notFound();

  const paymentStatus = order.payment?.status ?? "pending";

  return (
    <div className="mx-auto max-w-3xl">
      <div className={`rounded-xl border p-5 ${statusTone(order.status)}`}>
        <p className="text-lg font-semibold">{orderBannerTitle(order.status)}</p>
        <p className="mt-1 text-sm">訂單編號：{order.orderNumber}。{orderBannerMessage(order.status)}</p>
        {order.status === "pending_payment" && (
          <Link href={`/orders/${order.id}/payment`} className="mt-4 inline-block rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700">
            前往模擬付款
          </Link>
        )}
      </div>

      <div className="mt-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">訂單詳情</h1>
          <p className="mt-1 text-sm text-stone-500">建立時間：{dateTime.format(new Date(order.createdAt))}</p>
        </div>
        <Link href="/orders" className="text-sm text-stone-500 hover:underline">返回我的訂單</Link>
      </div>

      <section className="mt-6 rounded-xl border border-stone-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">商品明細</h2>
          <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusTone(order.status)}`}>訂單狀態：{orderStatusLabel(order.status)}</span>
        </div>
        <ul className="mt-4 divide-y divide-stone-100">
          {order.items.map((item) => (
            <li key={item.id} className="flex gap-4 py-4 first:pt-0 last:pb-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.imageUrl} alt={item.productName} className="h-16 w-16 rounded-lg border border-stone-200 object-cover" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{item.productName}</p>
                <p className="mt-1 text-sm text-stone-500">尺寸：{item.variantSize} · {currency.format(item.unitPrice)} × {item.quantity}</p>
              </div>
              <span className="shrink-0 font-medium">{currency.format(item.lineSubtotal)}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <section className="rounded-xl border border-stone-200 bg-white p-5">
          <h2 className="font-semibold">收件資訊</h2>
          <p className="mt-3 text-sm">{order.recipientName} · {order.recipientPhone}</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">{order.recipientAddress}</p>
        </section>

        <section className="rounded-xl border border-stone-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">付款與運送</h2>
            <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusTone(paymentStatus)}`}>{paymentStatusLabel(paymentStatus)}</span>
          </div>
          <p className="mt-3 text-sm text-stone-600">運送方式：{order.shippingMethodName}</p>
          {order.reservation && (
            <p className="mt-3 text-xs leading-5 text-stone-500">
              庫存保留：{reservationLabel(order.reservation.status)}
              {order.reservation.status === "active" && `（保留至 ${dateTime.format(new Date(order.reservation.expiresAt))}）`}
            </p>
          )}
          {order.payment && (
            <div className="mt-3 space-y-1 text-xs leading-5 text-stone-500">
              <p className="break-all">模擬交易編號：{order.payment.transactionId}</p>
              {order.payment.paidAt && <p>付款時間：{dateTime.format(new Date(order.payment.paidAt))}</p>}
              {order.payment.failureReason && <p className="text-red-600">結果原因：{order.payment.failureReason}</p>}
            </div>
          )}
          <div className="mt-4 space-y-2 border-t border-stone-200 pt-4 text-sm">
            <p className="flex justify-between"><span>商品小計</span><span>{currency.format(order.subtotal)}</span></p>
            <p className="flex justify-between"><span>運費</span><span>{currency.format(order.shippingFee)}</span></p>
            <p className="flex justify-between text-base font-semibold"><span>訂單總額</span><span>{currency.format(order.total)}</span></p>
          </div>
        </section>
      </div>

      {order.payment?.events.length ? (
        <section className="mt-6 rounded-xl border border-stone-200 bg-white p-5">
          <h2 className="font-semibold">付款 Webhook 紀錄</h2>
          <p className="mt-1 text-xs text-stone-500">此為 Mock 金流事件紀錄；重複或晚到的事件不會覆寫既有付款結果。</p>
          <ul className="mt-4 divide-y divide-stone-100 text-sm">
            {order.payment.events.map((event) => (
              <li key={event.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{paymentStatusLabel(event.result)}</span>
                  <span className="text-xs text-stone-500">{dateTime.format(new Date(event.processedAt))}</span>
                </div>
                <p className="mt-1 break-all font-mono text-xs text-stone-400">Event ID：{event.eventId}</p>
                {event.ignored && <p className="mt-1 text-xs text-amber-700">此事件已保留，但未覆寫先前付款結果。</p>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function reservationLabel(status: "active" | "completed" | "released"): string {
  if (status === "active") return "已保留，尚未扣減實際庫存";
  if (status === "completed") return "付款成功後已完成扣庫存";
  return "已釋放，未扣減實際庫存";
}

function orderBannerTitle(status: OrderStatus): string {
  switch (status) {
    case "pending_payment": return "訂單已成立，等待付款";
    case "processing": return "模擬付款成功";
    case "payment_failed": return "模擬付款失敗";
    case "cancelled": return "訂單已取消";
    case "expired": return "付款已逾期";
  }
}

function orderBannerMessage(status: OrderStatus): string {
  switch (status) {
    case "pending_payment": return "可進入 Mock 付款頁選擇測試結果，不會實際扣款。";
    case "processing": return "訂單已正確更新為處理中。";
    case "payment_failed": return "系統已保存失敗結果與原因。";
    case "cancelled": return "系統已保存取消結果。";
    case "expired": return "系統已保存逾期結果。";
  }
}
