import { redirect } from "next/navigation";
import CheckoutPageClient from "@/components/CheckoutPageClient";
import { getCurrentUser } from "@/lib/user";

export const metadata = { title: "結帳｜樣衣間" };
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?returnTo=%2Fcheckout");
  return <CheckoutPageClient />;
}
