import { notFound, redirect } from "next/navigation";
import MockPaymentPanel from "@/components/MockPaymentPanel";
import { getOrderForUser } from "@/lib/orders";
import { getCurrentUser } from "@/lib/user";

export const metadata = { title: "模擬付款｜樣衣間" };
export const dynamic = "force-dynamic";

export default async function MockPaymentPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?returnTo=${encodeURIComponent(`/orders/${orderId}/payment`)}`);
  const order = await getOrderForUser(user.id, orderId);
  if (!order) notFound();
  if (order.status !== "pending_payment") redirect(`/orders/${orderId}`);

  return <MockPaymentPanel orderId={order.id} orderNumber={order.orderNumber} total={order.total} />;
}
