import { NextResponse } from "next/server";
import { authAttemptAllowed, recordAuthAttempt } from "@/lib/risk";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: unknown; token?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(token)) return NextResponse.json({ status: "failed", message: "Email 或驗證碼格式不正確。" }, { status: 400 });
  if (!(await authAttemptAllowed(request, email))) {
    await recordAuthAttempt({ request, provider: "email_otp", action: "verify", outcome: "blocked", email });
    return NextResponse.json({ status: "failed", message: "嘗試次數過多，請 15 分鐘後再試。" }, { status: 429 });
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  await recordAuthAttempt({ request, provider: "email_otp", action: "verify", outcome: error ? "failed" : "succeeded", email, userId: data.user?.id });
  if (error) return NextResponse.json({ status: "failed", message: "驗證碼錯誤或已逾時。" }, { status: 400 });
  return NextResponse.json({ status: "success" });
}
