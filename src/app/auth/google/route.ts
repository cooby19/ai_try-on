import { NextResponse } from "next/server";
import { AUTH_RETURN_COOKIE, safeReturnTo } from "@/lib/return-url";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const callbackUrl = new URL("/auth/callback", url.origin);
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: callbackUrl.toString(),
        skipBrowserRedirect: true,
      },
    });

    if (error || !data.url) return googleLoginError(url.origin, returnTo);

    const response = NextResponse.redirect(data.url);
    response.cookies.set(AUTH_RETURN_COOKIE, returnTo, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 10 * 60,
      path: "/",
    });
    return response;
  } catch {
    return googleLoginError(url.origin, returnTo);
  }
}

function googleLoginError(origin: string, returnTo: string) {
  const loginUrl = new URL("/login", origin);
  loginUrl.searchParams.set("error", "暫時無法連接 Google 登入，請稍後再試。");
  loginUrl.searchParams.set("returnTo", returnTo);
  return NextResponse.redirect(loginUrl);
}
