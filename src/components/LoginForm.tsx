"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

function authErrorMessage(message: string): string {
  const value = message.toLowerCase();
  if (value.includes("rate") || value.includes("seconds")) {
    return "請稍候約 60 秒再重新寄送驗證碼。";
  }
  if (value.includes("expired") || value.includes("invalid")) {
    return "驗證碼錯誤或已逾時，請確認後再試一次。";
  }
  return "登入暫時失敗，請稍後再試。";
}

export default function LoginForm({
  returnTo,
  initialError,
  configured,
}: {
  returnTo: string;
  initialError?: string;
  configured: boolean;
}) {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState<"google" | "send" | "verify" | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [notice, setNotice] = useState<string | null>(null);

  async function signInWithGoogle() {
    if (!configured) return;
    setBusy("google");
    setError(null);
    window.location.assign(`/auth/google?returnTo=${encodeURIComponent(returnTo)}`);
  }

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured) return;
    setBusy("send");
    setError(null);
    setNotice(null);
    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: true },
      });
      if (authError) {
        setError(authErrorMessage(authError.message));
      } else {
        setCodeSent(true);
        setNotice("6 位數驗證碼已寄出，請查看信箱；若沒看到，也請檢查垃圾郵件。");
      }
    } catch {
      setError("網路連線異常，請確認網路後再試一次。");
    } finally {
      setBusy(null);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured) return;
    setBusy("verify");
    setError(null);
    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: otp.trim(),
        type: "email",
      });
      if (authError) {
        setError(authErrorMessage(authError.message));
        setBusy(null);
        return;
      }
      window.location.assign(returnTo);
    } catch {
      setError("網路連線異常，請確認網路後再試一次。");
      setBusy(null);
    }
  }

  if (!configured) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        尚未設定 Supabase Auth 公開環境變數，請先依 README 完成設定。
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {notice}
        </div>
      )}

      <button
        type="button"
        onClick={signInWithGoogle}
        disabled={busy !== null}
        className="w-full rounded-lg border border-stone-300 bg-white px-4 py-3 text-sm font-medium hover:bg-stone-50 disabled:opacity-50"
      >
        {busy === "google" ? "前往 Google…" : "使用 Google 登入"}
      </button>

      <div className="flex items-center gap-3 text-xs text-stone-400">
        <span className="h-px flex-1 bg-stone-200" />或使用 Email<span className="h-px flex-1 bg-stone-200" />
      </div>

      <form onSubmit={sendCode} className="space-y-3">
        <label className="block text-sm font-medium" htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={busy !== null || codeSent}
          placeholder="you@example.com"
          className="w-full rounded-lg border border-stone-300 px-3 py-2.5 text-sm outline-none focus:border-stone-600 disabled:bg-stone-50"
        />
        {!codeSent && (
          <button
            type="submit"
            disabled={busy !== null}
            className="w-full rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
          >
            {busy === "send" ? "寄送中…" : "寄送一次性驗證碼"}
          </button>
        )}
      </form>

      {codeSent && (
        <form onSubmit={verifyCode} className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="otp">6 位數驗證碼</label>
          <input
            id="otp"
            name="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={otp}
            onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            className="w-full rounded-lg border border-stone-300 px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-stone-600"
          />
          <button
            type="submit"
            disabled={busy !== null || otp.length !== 6}
            className="w-full rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50"
          >
            {busy === "verify" ? "驗證中…" : "驗證並登入"}
          </button>
          <button
            type="button"
            onClick={() => {
              setCodeSent(false);
              setOtp("");
              setNotice(null);
            }}
            className="w-full text-sm text-stone-500 hover:underline"
          >
            更換 Email 或重新寄送
          </button>
        </form>
      )}

      <p className="text-xs leading-5 text-stone-500">
        登入即代表你同意照片只用於本次 AI 試穿。人物照與結果圖存放於私有空間，不會公開瀏覽。
      </p>
    </div>
  );
}
