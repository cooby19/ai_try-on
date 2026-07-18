import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTryOnConfig } from "./config";
import {
  TRY_ON_FEATURE_MATRIX,
  TryOnFeatureFlagError,
  createDeploymentControlDecision,
  forceTryOnFeatureDecision,
  parseTryOnFeatureFlagConfig,
  resolveTryOnFeatureDecision,
  type TryOnFeatureFlagConfigV1,
} from "./feature-flags-core";

const variant = (
  id: string,
  provider: "fashn" | "fashn-max" | "mock",
  enhancement: "none" | "realesrgan" = "none",
) => ({
  id,
  provider,
  enhancement,
  generationConfigVersion: "generation-v1" as const,
  prompt: { version: "none" as const, hash: null },
});

const config = (overrides: Partial<TryOnFeatureFlagConfigV1> = {}): TryOnFeatureFlagConfigV1 => ({
  schemaVersion: 1,
  experimentId: "max-quality-v1",
  mode: "canary",
  rolloutPercentage: 10,
  saltVersion: "salt-v1",
  control: variant("control-v16", "fashn"),
  candidate: variant("candidate-max", "fashn-max"),
  ...overrides,
});

const decision = (overrides: Partial<Parameters<typeof resolveTryOnFeatureDecision>[0]> = {}) =>
  resolveTryOnFeatureDecision({
    config: config(),
    assignmentKey: "user-123",
    assignmentSecret: "test-only-secret-at-least-32-characters",
    executionContext: "runtime",
    isProduction: false,
    requestedModel: "v1.6",
    requestedProviderName: "fashn",
    ...overrides,
  });

afterEach(() => vi.unstubAllEnvs());

describe("Try-On Feature Flag matrix／parser", () => {
  it("完整列出 3 providers × 2 enhancements，並標示成本、production 與 env", () => {
    expect(TRY_ON_FEATURE_MATRIX).toHaveLength(6);
    expect(
      TRY_ON_FEATURE_MATRIX.find(
        (entry) => entry.provider === "fashn" && entry.enhancement === "realesrgan",
      ),
    ).toMatchObject({
      status: "supported",
      productionEligible: true,
      externalCost: true,
      requiredEnvironmentVariables: ["FASHN_API_KEY", "REPLICATE_API_TOKEN"],
    });
  });

  it("拒絕 Max+Real-ESRGAN 與未知 prompt version", () => {
    expect(() =>
      parseTryOnFeatureFlagConfig({
        ...config(),
        candidate: variant("bad", "fashn-max", "realesrgan"),
      }),
    ).toThrow(TryOnFeatureFlagError);
    expect(() =>
      parseTryOnFeatureFlagConfig({
        ...config(),
        candidate: { ...variant("bad", "fashn"), prompt: { version: "prompt-v2", hash: "x" } },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_config" }));
  });

  it("rollout mode 與百分比必須一致", () => {
    expect(() =>
      parseTryOnFeatureFlagConfig(config({ mode: "off", rolloutPercentage: 1 })),
    ).toThrowError(expect.objectContaining({ code: "invalid_config" }));
    expect(() =>
      parseTryOnFeatureFlagConfig(config({ mode: "evaluation", rolloutPercentage: 50 })),
    ).toThrowError(expect.objectContaining({ code: "invalid_config" }));
  });
});

describe("Try-On Feature Flag stable assignment", () => {
  it("未設定實驗時保留 deployment provider／enhancement，並明確記為 off control", () => {
    expect(
      createDeploymentControlDecision({
        requestedModel: "v1.6",
        requestedProviderName: "fashn",
        enhancement: "none",
      }),
    ).toMatchObject({
      variantRole: "control",
      variant: { provider: "fashn", enhancement: "none" },
      snapshot: {
        experimentId: "deployment-control",
        rolloutMode: "off",
        rolloutPercentage: 0,
        requestedModel: "v1.6",
        requestedProviderName: "fashn",
      },
    });
  });

  it("相同 experiment、salt、key 永遠得到相同 variant", () => {
    const first = decision();
    const second = decision();
    expect(second).toEqual(first);
    expect(first.snapshot).not.toHaveProperty("userId");
    expect(first.snapshot).not.toHaveProperty("assignmentKey");
  });

  it("canary 0% 永遠 control，100% 永遠 candidate", () => {
    expect(decision({ config: config({ rolloutPercentage: 0 }) }).variantRole).toBe("control");
    expect(decision({ config: config({ rolloutPercentage: 100 }) }).variantRole).toBe("candidate");
  });

  it("evaluation 在 runtime 保持 control，只有明確 evaluation context 才用 candidate", () => {
    const evaluation = config({ mode: "evaluation", rolloutPercentage: 100 });
    expect(decision({ config: evaluation }).variantRole).toBe("control");
    expect(decision({ config: evaluation, executionContext: "evaluation" }).variantRole).toBe(
      "candidate",
    );
  });

  it("evaluation／canary 缺少 HMAC secret 時 fail-closed", () => {
    expect(() => decision({ assignmentSecret: "" })).toThrowError(
      expect.objectContaining({ code: "missing_assignment_secret" }),
    );
  });

  it("production 禁止 mock candidate", () => {
    expect(() =>
      decision({
        config: config({ mode: "on", rolloutPercentage: 100, candidate: variant("mock", "mock") }),
        isProduction: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "production_ineligible" }));
  });

  it("選中 candidate 但缺少必要 runtime env 時 fail-closed", () => {
    let caught: unknown;
    try {
      decision({
        config: config({ rolloutPercentage: 100 }),
        enforceRuntimeDependencies: true,
        environment: {},
      });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toMatchObject({ code: "missing_runtime_dependency" });
    expect((caught as Error).message).not.toContain("FASHN_API_KEY");
    expect((caught as TryOnFeatureFlagError).diagnostic).toContain("FASHN_API_KEY");
  });

  it("forced test injection 寫入完整快照且 config 使用相同 provider/enhancement", () => {
    const experiment = config({
      mode: "evaluation",
      rolloutPercentage: 100,
      candidate: variant("upscaled", "fashn", "realesrgan"),
    });
    const forced = forceTryOnFeatureDecision({
      config: experiment,
      role: "candidate",
      requestedModel: "v1.6",
      requestedProviderName: "fashn",
    });
    const resolved = resolveTryOnConfig(forced.variant.provider, 123, forced);
    expect(resolved.snapshot).toMatchObject({
      experiment: {
        schemaVersion: 1,
        experimentId: "max-quality-v1",
        variantId: "upscaled",
        variantRole: "candidate",
        assignmentVersion: "forced-test-v1",
        requestedModel: "v1.6",
        requestedProviderName: "fashn",
      },
      provider: { name: "fashn" },
      generation: { seed: 123 },
      enhancement: { provider: "realesrgan", scale: 2 },
      prompt: { version: "none", hash: null },
    });
  });
});
