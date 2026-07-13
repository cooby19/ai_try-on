const DEFAULT_RETURN_TO = "/";
export const AUTH_RETURN_COOKIE = "vto_auth_return_to";

/**
 * 只接受站內的 root-relative path。所有外部 URL、protocol-relative URL、
 * 反斜線與控制字元都退回首頁，避免 OAuth/login callback 形成 open redirect。
 */
export function safeReturnTo(value: unknown, fallback = DEFAULT_RETURN_TO): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return fallback;

  try {
    const base = new URL("https://local.invalid");
    const target = new URL(value, base);
    if (target.origin !== base.origin) return fallback;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return fallback;
  }
}

export function loginReturnTo(value: unknown): string {
  const returnTo = safeReturnTo(value);
  return returnTo === "/login" || returnTo.startsWith("/login?") ? "/" : returnTo;
}
