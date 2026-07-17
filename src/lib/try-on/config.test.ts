import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_GENERATION_SEED,
  generateGenerationSeed,
  resolveGenerationSeed,
  resolveTryOnConfig,
} from "./config";
import {
  createIdempotentGenerationSeed,
  createTryOnRequestFingerprint,
  isValidIdempotencyKey,
} from "./idempotency";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Try-On config snapshot V1", () => {
  it("v1.6 snapshot 與 Provider resolved request 共用相同參數", () => {
    vi.stubEnv("ENHANCE_PROVIDER", "none");
    const config = resolveTryOnConfig("fashn", 123456789);

    expect(config.provider).toEqual({
      providerName: "fashn",
      modelName: "tryon-v1.6",
      seed: 123456789,
      inputs: {
        category: "tops",
        mode: "quality",
        garmentPhotoType: "flat-lay",
        outputFormat: "jpeg",
        outputCount: 1,
      },
    });
    expect(config.snapshot).toMatchObject({
      schemaVersion: 1,
      provider: {
        name: "fashn",
        modelName: "tryon-v1.6",
        mode: "quality",
        resolution: null,
        outputFormat: "jpeg",
        outputCount: 1,
      },
      generation: {
        seed: 123456789,
        garmentType: "tops",
        garmentPhotoType: "flat-lay",
      },
      enhancement: { provider: "none", modelVersion: null, scale: null },
    });
  });

  it("Max snapshot 精確記錄 balanced/1k/單張/jpeg 與空 prompt", () => {
    const config = resolveTryOnConfig("fashn-max", 42);
    expect(config.provider).toMatchObject({
      providerName: "fashn-max",
      modelName: "tryon-max",
      seed: 42,
      inputs: {
        generationMode: "balanced",
        resolution: "1k",
        outputFormat: "jpeg",
        outputCount: 1,
        prompt: "",
      },
    });
    expect(config.snapshot).toMatchObject({
      schemaVersion: 1,
      provider: { name: "fashn-max", modelName: "tryon-max", mode: "balanced", resolution: "1k" },
      generation: { seed: 42, garmentType: null, garmentPhotoType: null },
      prompt: { version: "none", hash: null, value: "" },
    });
  });

  it("只有 fashn + realesrgan 啟用時記錄固定模型版本與 2x", () => {
    vi.stubEnv("ENHANCE_PROVIDER", "realesrgan");
    const enabled = resolveTryOnConfig("fashn", 1).snapshot.enhancement;
    const skippedForMax = resolveTryOnConfig("fashn-max", 1).snapshot.enhancement;

    expect(enabled.provider).toBe("realesrgan");
    expect(enabled.modelVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(enabled.scale).toBe(2);
    expect(skippedForMax).toEqual({ provider: "none", modelVersion: null, scale: null });
  });

  it("snapshot 固定 preprocessing 版本且不含 secret、圖片內容或 URL", () => {
    vi.stubEnv("FASHN_API_KEY", "must-not-leak");
    const serialized = JSON.stringify(resolveTryOnConfig("fashn", 7).snapshot);
    expect(serialized).toContain('"schemaVersion":1');
    expect(serialized).toContain('"maxWidth":1440');
    expect(serialized).toContain('"jpegQuality":92');
    expect(serialized).toContain('"maxWidth":1024');
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("base64");
    expect(serialized).not.toContain("signed");
    expect(serialized).not.toContain("Authorization");
  });
});

describe("generation seed", () => {
  it.each([0, MAX_GENERATION_SEED])("接受 unsigned 32-bit 邊界 %i", (seed) => {
    expect(resolveGenerationSeed(seed)).toBe(seed);
  });

  it.each([-1, MAX_GENERATION_SEED + 1, 1.5, Number.NaN])("拒絕非法 seed %s", (seed) => {
    expect(() => resolveGenerationSeed(seed)).toThrow(/seed 必須/);
  });

  it("未指定時由後端 crypto 產生合法 seed", () => {
    for (let index = 0; index < 20; index += 1) {
      const seed = generateGenerationSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(MAX_GENERATION_SEED);
    }
  });
});

describe("idempotency canonical fingerprint", () => {
  const input = {
    userId: "user-a",
    productId: "product-a",
    personImagePath: "user-a/person.jpg",
    providerName: "fashn",
    configSnapshot: resolveTryOnConfig("fashn", 0).snapshot,
  };

  it("相同語意輸入穩定產生同一 SHA-256", () => {
    const first = createTryOnRequestFingerprint(input);
    const second = createTryOnRequestFingerprint({ ...input });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    { productId: "product-b" },
    { personImagePath: "user-a/other.jpg" },
    {
      providerName: "fashn-max",
      configSnapshot: resolveTryOnConfig("fashn-max", 0).snapshot,
    },
    { userId: "user-b" },
    { explicitSeed: 42 },
  ])("生成語意不同時 fingerprint 不同：%o", (change) => {
    expect(createTryOnRequestFingerprint({ ...input, ...change })).not.toBe(
      createTryOnRequestFingerprint(input),
    );
  });

  it("key 僅接受 1–128 個安全字元，拒絕空白、換行與超長輸入", () => {
    expect(isValidIdempotencyKey("request_1234-abc:def.test")).toBe(true);
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("contains space")).toBe(false);
    expect(isValidIdempotencyKey("line\nbreak")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(129))).toBe(false);
  });

  it("相同 key/fingerprint 併發解析同 seed，不同新 key 解析不同 seed", () => {
    const fingerprint = createTryOnRequestFingerprint(input);
    const first = createIdempotentGenerationSeed("request-a", fingerprint);
    expect(createIdempotentGenerationSeed("request-a", fingerprint)).toBe(first);
    expect(createIdempotentGenerationSeed("request-b", fingerprint)).not.toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(MAX_GENERATION_SEED);
  });
});
