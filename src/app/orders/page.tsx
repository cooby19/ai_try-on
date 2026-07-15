import Link from "next/link";
import { redirect } from "next/navigation";
import { orderStatusLabel, paymentStatusLabel, statusTone } from "@/lib/order-status";
import { getOrdersForUser } from "@/lib/orders";
import { getCurrentUser } from "@/lib/user";

const currency = new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" });

export const metadata = { title: "我的訂單｜樣衣間" };
export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?returnTo=/orders");
  const orders = await getOrdersForUser(user.id);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-stone-500">帳戶中心</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">我的訂單</h1>
          <p className="mt-2 text-sm text-stone-500">查看歷史訂單、付款結果與商品明細。</p>
        </div>
        <Link href="/" className="text-sm text-stone-500 hover:underline">繼續選購</Link>
      </div>

      {orders.length ? (
        <div className="mt-8 space-y-3">
          {orders.map((order) => (
            <Link key={order.id} href={`/orders/${order.id}`} className="block rounded-2xl border border-stone-200 bg-white p-5 transition hover:border-stone-400 hover:shadow-sm">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold">{order.orderNumber}</p>
                  <p className="mt-1 text-sm text-stone-500">{dateTime.format(new Date(order.createdAt))}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusTone(order.status)}`}>訂單：{orderStatusLabel(order.status)}</span>
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${statusTone(order.paymentStatus)}`}>付款：{paymentStatusLabel(order.paymentStatus)}</span>
                  <span className="ml-1 min-w-24 text-right font-semibold">{currency.format(order.total)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="mt-8 rounded-2xl border border-stone-200 bg-white px-6 py-16 text-center">
          <h2 className="text-xl font-semibold">還沒有訂單</h2>
          <p className="mt-2 text-sm text-stone-500">挑選商品並完成結帳後，訂單會顯示在這裡。</p>
          <Link href="/" className="mt-5 inline-block rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700">開始選購</Link>
        </div>
      )}
    </div>
  );
}
