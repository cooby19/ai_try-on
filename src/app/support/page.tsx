import { redirect } from "next/navigation";
import SupportCenter from "@/components/SupportCenter";
import { listSupportTicketsForUser } from "@/lib/support";
import { getCurrentUser } from "@/lib/user";

export const metadata = { title: "客服中心｜樣衣間" };
export const dynamic = "force-dynamic";

export default async function SupportPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?returnTo=/support");
  const tickets = await listSupportTicketsForUser(user.id);
  return (
    <div className="mx-auto max-w-4xl">
      <p className="text-sm font-medium text-stone-500">帳戶中心</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">客服中心</h1>
      <p className="mt-2 text-sm text-stone-500">建立案件、補充資訊並追蹤處理進度。</p>
      <SupportCenter initialTickets={tickets} />
    </div>
  );
}
