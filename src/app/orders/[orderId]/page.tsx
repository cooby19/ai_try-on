import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getOrderForUser } from "@/lib/orders";
import { getCurrentUser } from "@/lib/user";

const currency = new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 });

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?returnTo=${encodeURIComponent(`/orders/${orderId}`)}`);
  const order = await getOrderForUser(user.id, orderId);
  if (!order) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-xl border border-green-200 bg-green-50 p-5 text-green-900"><p className="text-lg font-semibold">訂單已成立</p><p className="mt-1 text-sm">訂單編號：{order.orderNumber}。目前狀態為「待付款」，本版本尚未串接付款服務。</p></div>
      <div className="mt-6 flex items-end justify-between gap-4"><div><h1 className="text-2xl font-semibold">訂單明細</h1><p className="mt-1 text-sm text-stone-500">建立時間：{new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(order.createdAt))}</p></div><Link href="/" className="text-sm text-stone-500 hover:underline">繼續選購</Link></div>
      <section className="mt-6 rounded-xl border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">商品明細</h2>
        <ul className="mt-4 divide-y divide-stone-100">
          {order.items.map((item) => (
            <li key={item.id} className="flex gap-4 py-4 first:pt-0 last:pb-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.imageUrl} alt={item.productName} className="h-16 w-16 rounded-lg border border-stone-200 object-cover" />
              <div className="min-w-0 flex-1"><p className="font-medium">{item.productName}</p><p className="mt-1 text-sm text-stone-500">尺寸：{item.variantSize} · {currency.format(item.unitPrice)} × {item.quantity}</p></div>
              <span className="shrink-0 font-medium">{currency.format(item.lineSubtotal)}</span>
            </li>
          ))}
        </ul>
      </section>
      <div className="mt-6 grid gap-6 sm:grid-cols-2"><section className="rounded-xl border border-stone-200 bg-white p-5"><h2 className="font-semibold">收件資訊</h2><p className="mt-3 text-sm">{order.recipientName} · {order.recipientPhone}</p><p className="mt-1 text-sm leading-6 text-stone-600">{order.recipientAddress}</p></section><section className="rounded-xl border border-stone-200 bg-white p-5"><h2 className="font-semibold">付款與運送</h2><p className="mt-3 text-sm">付款狀態：<span className="font-medium text-amber-700">待付款</span></p><p className="mt-1 text-sm text-stone-600">運送方式：{order.shippingMethodName}</p><div className="mt-4 space-y-2 border-t border-stone-200 pt-4 text-sm"><p className="flex justify-between"><span>商品小計</span><span>{currency.format(order.subtotal)}</span></p><p className="flex justify-between"><span>運費</span><span>{currency.format(order.shippingFee)}</span></p><p className="flex justify-between text-base font-semibold"><span>應付總額</span><span>{currency.format(order.total)}</span></p></div></section></div>
    </div>
  );
}
