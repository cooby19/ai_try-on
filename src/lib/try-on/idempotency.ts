import { createHash } from "node:crypto";
import type { TryOnConfigSnapshotV1 } from "../types";

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const IDEMPOTENCY_KEY_ERROR_MESSAGE =
  "Idempotency-Key 格式不合法，請使用 1–128 個英數字元或 . _ : -。";
export const IDEMPOTENCY_CONFLICT_MESSAGE =
  "此 Idempotency-Key 已用於不同的試穿請求，請更換 key 後重試。";

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value);
}

function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical number 必須是有限數值");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("不支援的 canonical value");
}

export function createTryOnRequestFingerprint(input: {
  userId: string;
  productId: string;
  personImagePath: string;
  providerName: string;
  configSnapshot: TryOnConfigSnapshotV1;
  explicitSeed?: number;
}): string {
  const semanticConfig = {
    ...input.configSnapshot,
    generation: {
      ...input.configSnapshot.generation,
      seed:
        input.explicitSeed === undefined
          ? { mode: "server-generated" }
          : { mode: "explicit", value: input.explicitSeed },
    },
  };
  const canonicalIntent = canonicalSerialize({
    schemaVersion: 1,
    userId: input.userId,
    productId: input.productId,
    personImagePath: input.personImagePath,
    providerName: input.providerName,
    generationConfig: semanticConfig,
  });
  return createHash("sha256").update(canonicalIntent, "utf8").digest("hex");
}

// 同 key 的併發請求即使都在 preflight 時尚未看到 row，也會解析出同一 seed；
// 不同 key（新的生成意圖）則會得到不同的 32-bit 值，且不需在 replay 再抽一次隨機數。
export function createIdempotentGenerationSeed(
  idempotencyKey: string,
  requestFingerprint: string,
): number {
  const digest = createHash("sha256")
    .update(idempotencyKey, "utf8")
    .update("\0", "utf8")
    .update(requestFingerprint, "utf8")
    .digest();
  return digest.readUInt32BE(0);
}
