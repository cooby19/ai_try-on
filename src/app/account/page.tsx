import { redirect } from "next/navigation";
import { getCurrentUser, userDisplayName } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?returnTo=/account");

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-semibold">帳戶設定</h1>
      <div className="mt-6 rounded-xl border border-stone-200 bg-white p-6">
        <dl className="space-y-4 text-sm">
          <div>
            <dt className="text-stone-400">顯示名稱</dt>
            <dd className="mt-1 font-medium">{userDisplayName(user)}</dd>
          </div>
          <div>
            <dt className="text-stone-400">Email</dt>
            <dd className="mt-1 font-medium">{user.email ?? "未提供"}</dd>
          </div>
        </dl>
        <p className="mt-6 text-xs leading-5 text-stone-500">
          V0.2 帳戶由 Google 或 Email 一次性驗證碼管理，不使用密碼。
        </p>
      </div>
    </div>
  );
}
