import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_RETURN_COOKIE, safeReturnTo } from "@/lib/return-url";
import { createClient } from "@/lib/supabase/server";
import { recordAuthAttempt } from "@/lib/risk";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnCookie = (await cookies()).get(AUTH_RETURN_COOKIE)?.value;
  const next = safeReturnTo(returnCookie);

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const { data } = await supabase.auth.getUser();
      await recordAuthAttempt({ request, provider: "google", action: "callback", outcome: "succeeded", userId: data.user?.id });
      const response = NextResponse.redirect(new URL(next, url.origin));
      response.cookies.delete(AUTH_RETURN_COOKIE);
      return response;
    }
  }

  await recordAuthAttempt({ request, provider: "google", action: "callback", outcome: "failed" });

  const loginUrl = new URL("/login", url.origin);
  loginUrl.searchParams.set("error", "登入連結無效或已逾時，請重新登入。");
  loginUrl.searchParams.set("returnTo", next);
  const response = NextResponse.redirect(loginUrl);
  response.cookies.delete(AUTH_RETURN_COOKIE);
  return response;
}
