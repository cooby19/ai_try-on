import { redirect } from "next/navigation";
import AddressBookClient from "@/components/AddressBookClient";
import { getCurrentUser } from "@/lib/user";

export const metadata = { title: "地址簿｜樣衣間" };
export const dynamic = "force-dynamic";

export default async function AddressBookPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?returnTo=%2Faccount%2Faddresses");
  return <AddressBookClient />;
}
