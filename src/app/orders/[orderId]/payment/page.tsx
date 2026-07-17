import { notFound, redirect } from "next/navigation";
import MockPaymentPanel from "@/components/MockPaymentPanel";
import { getOrderForUser } from "@/lib/orders";
import { getCurrentUser } from "@/lib/user";
import { isMockPaymentEnabled } from "@/lib/mock-payments";

export const metadata = { title: "模擬付款｜樣衣間" };
export const dynamic = "force-dynamic";

export default async function MockPaymentPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?returnTo=${encodeURIComponent(`/orders/${orderId}/payment`)}`);
  const order = await getOrderForUser(user.id, orderId);
  if (!order) notFound();
  if (order.status !== "pending_payment") redirect(`/orders/${orderId}`);

  if (!isMockPaymentEnabled()) {
    return <div className="mx-auto max-w-xl rounded-2xl border border-amber-300 bg-amber-50 p-6"><h1 className="text-xl font-semibold">付款服務尚未啟用</h1><p className="mt-2 text-sm leading-6 text-amber-900">正式環境不允許使用 Mock 金流。請由營運完成真實支付供應商、Webhook 與退款 API 的上線驗證後再開放付款。</p></div>;
  }
  return <MockPaymentPanel orderId={order.id} orderNumber={order.orderNumber} total={order.total} />;
}
