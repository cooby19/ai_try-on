import { redirect } from "next/navigation";
import AccountDeletionPanel from "@/components/AccountDeletionPanel";
import AccountTryOnHistory from "@/components/AccountTryOnHistory";
import { getAccountOverview } from "@/lib/account";
import { getCurrentUser, userDisplayName, userLoginMethod } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?returnTo=/account");

  const { tryOnItems, pendingDeletionRequest } = await getAccountOverview(user.id);

  return (
    <div className="mx-auto max-w-4xl">
      <div>
        <p className="text-sm font-medium text-stone-500">帳戶中心</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">管理你的帳戶與試穿資料</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500">
          查看登入資料、管理每次試穿照片，或提交帳戶刪除申請。
        </p>
      </div>

      <div className="mt-8 space-y-6">
        <section className="rounded-2xl border border-stone-200 bg-white p-6" aria-labelledby="profile-heading">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-stone-400">基本資料</p>
              <h2 id="profile-heading" className="mt-1 text-xl font-semibold">你的登入資料</h2>
            </div>
            <p className="text-xs text-stone-400">V0.4 僅供查看，暫不支援修改</p>
          </div>
          <dl className="mt-6 grid gap-5 text-sm sm:grid-cols-3">
            <ProfileField label="顯示名稱" value={userDisplayName(user)} />
            <ProfileField label="Email" value={user.email ?? "未提供"} />
            <ProfileField label="登入方式" value={userLoginMethod(user)} />
          </dl>
        </section>

        <AccountTryOnHistory initialItems={tryOnItems} />

        <section className="rounded-2xl border border-stone-200 bg-white p-6" aria-labelledby="privacy-heading">
          <p className="text-xs font-medium uppercase tracking-widest text-stone-400">隱私與資料</p>
          <h2 id="privacy-heading" className="mt-1 text-xl font-semibold">照片與紀錄如何處理</h2>
          <div className="mt-5 grid gap-4 text-sm leading-6 text-stone-600 md:grid-cols-2">
            <PrivacyItem title="私有照片儲存">
              人物照與試穿結果存放在 Supabase 私有 Storage，不提供公開瀏覽；頁面只在你通過登入驗證後取得短效存取網址。
            </PrivacyItem>
            <PrivacyItem title="可刪除個別照片">
              你可以隨時刪除自己的單次試穿照片。照片刪除後無法復原；若人物照仍被你的其他試穿紀錄共用，會在最後一筆引用刪除時一併移除。
            </PrivacyItem>
            <PrivacyItem title="必要紀錄可能保留">
              刪除照片不會刪除該次 job。商品、狀態、時間、用量與必要成本資訊可能為防止重複取得額度及成本稽核而保留。
            </PrivacyItem>
            <PrivacyItem title="帳戶刪除申請">
              本版送出後只建立待處理申請，不會立即刪除 Auth 帳戶、照片或資料列。後續會依申請狀態進行審核與處理，不保證即時完成。
            </PrivacyItem>
          </div>
        </section>

        <AccountDeletionPanel initialRequest={pendingDeletionRequest} />
      </div>
    </div>
  );
}

function ProfileField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-stone-50 px-4 py-3">
      <dt className="text-xs text-stone-400">{label}</dt>
      <dd className="mt-1 break-words font-medium text-stone-800">{value}</dd>
    </div>
  );
}

function PrivacyItem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-stone-50 p-4">
      <h3 className="font-medium text-stone-800">{title}</h3>
      <p className="mt-1">{children}</p>
    </div>
  );
}
