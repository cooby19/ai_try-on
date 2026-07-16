import "server-only";

import { createHmac } from "crypto";
import { getSupabaseAdmin } from "./supabase";

type AuthProvider = "email_otp" | "google";
type AuthAction = "request" | "verify" | "callback";
type AuthOutcome = "requested" | "succeeded" | "failed" | "blocked";

export async function authAttemptAllowed(request: Request, email?: string): Promise<boolean> {
  const fingerprints = requestFingerprints(request, email);
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const supabase = getSupabaseAdmin();
  const [emailResult, ipResult] = await Promise.all([
    fingerprints.emailHash
      ? supabase.from("auth_attempt_events").select("id", { head: true, count: "exact" }).eq("email_hash", fingerprints.emailHash).gte("created_at", since)
      : Promise.resolve({ count: 0, error: null }),
    supabase.from("auth_attempt_events").select("id", { head: true, count: "exact" }).eq("ip_hash", fingerprints.ipHash).gte("created_at", since),
  ]);
  if (emailResult.error || ipResult.error) return false;
  return (emailResult.count ?? 0) < 10 && (ipResult.count ?? 0) < 20;
}

export async function recordAuthAttempt(input: {
  request: Request;
  provider: AuthProvider;
  action: AuthAction;
  outcome: AuthOutcome;
  email?: string;
  userId?: string | null;
}): Promise<void> {
  const fingerprints = requestFingerprints(input.request, input.email);
  const supabase = getSupabaseAdmin();
  await supabase.from("auth_attempt_events").insert({
    user_id: input.userId ?? null,
    provider: input.provider,
    action: input.action,
    outcome: input.outcome,
    email_hash: fingerprints.emailHash,
    ip_hash: fingerprints.ipHash,
    user_agent_hash: fingerprints.userAgentHash,
  });
  if (input.outcome !== "failed" && input.outcome !== "blocked") return;
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { count } = await supabase.from("auth_attempt_events").select("id", { head: true, count: "exact" }).eq("ip_hash", fingerprints.ipHash).in("outcome", ["failed", "blocked"]).gte("created_at", since);
  if ((count ?? 0) < 5) return;
  const fingerprint = `auth:${fingerprints.ipHash}`;
  const { data: existing } = await supabase.from("risk_events").select("id").eq("fingerprint", fingerprint).eq("event_type", "authentication_failure_velocity").in("status", ["open", "investigating"]).limit(1);
  if (existing?.length) return;
  await supabase.from("risk_events").insert({
    user_id: input.userId ?? null,
    event_type: "authentication_failure_velocity",
    severity: "high",
    fingerprint,
    details: { failuresIn15Minutes: count, provider: input.provider },
  });
}

function requestFingerprints(request: Request, email?: string): { emailHash: string | null; ipHash: string; userAgentHash: string | null } {
  const ip = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown";
  const userAgent = request.headers.get("user-agent")?.slice(0, 500) ?? null;
  return {
    emailHash: email ? hash(`email:${email.trim().toLowerCase()}`) : null,
    ipHash: hash(`ip:${ip}`),
    userAgentHash: userAgent ? hash(`ua:${userAgent}`) : null,
  };
}

function hash(value: string): string {
  const secret = process.env.RISK_HASH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("尚未設定風險指紋雜湊金鑰。");
  return createHmac("sha256", secret).update(value).digest("hex");
}
