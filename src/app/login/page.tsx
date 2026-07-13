import Link from "next/link";
import { redirect } from "next/navigation";
import LoginForm from "@/components/LoginForm";
import { loginReturnTo } from "@/lib/return-url";
import { isSupabaseAuthConfigured } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[]; error?: string | string[] }>;
}) {
  const query = await searchParams;
  const returnTo = loginReturnTo(Array.isArray(query.returnTo) ? query.returnTo[0] : query.returnTo);
  const user = await getCurrentUser();
  if (user) redirect(returnTo);

  const error = Array.isArray(query.error) ? query.error[0] : query.error;
  return (
    <div className="mx-auto max-w-md">
      <Link href={returnTo} className="text-sm text-stone-500 hover:underline">← 返回商品</Link>
      <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold">登入／註冊</h1>
        <p className="mt-2 mb-6 text-sm leading-6 text-stone-500">
          登入後即可上傳照片、查看額度並保存 AI 試穿結果；不需要設定密碼。
        </p>
        <LoginForm
          returnTo={returnTo}
          initialError={error}
          configured={isSupabaseAuthConfigured()}
        />
      </div>
    </div>
  );
}
