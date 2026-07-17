import { NextResponse } from "next/server";
import { authAttemptAllowed, recordAuthAttempt } from "@/lib/risk";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return NextResponse.json({ status: "failed", message: "Email 格式不正確。" }, { status: 400 });
  if (!(await authAttemptAllowed(request, email))) {
    await recordAuthAttempt({ request, provider: "email_otp", action: "request", outcome: "blocked", email });
    return NextResponse.json({ status: "failed", message: "嘗試次數過多，請 15 分鐘後再試。" }, { status: 429 });
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  await recordAuthAttempt({ request, provider: "email_otp", action: "request", outcome: error ? "failed" : "requested", email });
  if (error) return NextResponse.json({ status: "failed", message: "驗證碼暫時無法寄送，請稍後再試。" }, { status: 400 });
  return NextResponse.json({ status: "success" });
}
