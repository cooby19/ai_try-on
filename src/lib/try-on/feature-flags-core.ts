import { createHmac } from "node:crypto";
import type { TryOnFeatureFlagSnapshotV1, TryOnModel } from "../types";

export const TRY_ON_FEATURE_FLAG_SCHEMA_VERSION = 1 as const;
export const TRY_ON_ASSIGNMENT_VERSION = "hmac-sha256-v1" as const;

export type TryOnRolloutMode = "off" | "evaluation" | "canary" | "on";
export type TryOnVariantRole = "control" | "candidate";
export type TryOnFeatureProvider = "fashn" | "fashn-max" | "mock";
export type TryOnFeatureEnhancement = "none" | "realesrgan";

export interface TryOnFeatureVariant {
  id: string;
  provider: TryOnFeatureProvider;
  enhancement: TryOnFeatureEnhancement;
  generationConfigVersion: "generation-v1";
  prompt: { version: "none"; hash: null };
}

export interface TryOnFeatureFlagConfigV1 {
  schemaVersion: 1;
  experimentId: string;
  mode: TryOnRolloutMode;
  rolloutPercentage: number;
  saltVersion: string;
  control: TryOnFeatureVariant;
  candidate: TryOnFeatureVariant;
}

export interface TryOnFeatureMatrixEntry {
  provider: TryOnFeatureProvider;
  enhancement: TryOnFeatureEnhancement;
  status: "supported" | "evaluation-only" | "unsupported";
  productionEligible: boolean;
  externalCost: boolean;
  requiredEnvironmentVariables: string[];
  reason: string;
}

export interface ResolvedTryOnFeatureDecision {
  variant: TryOnFeatureVariant;
  variantRole: TryOnVariantRole;
  snapshot: TryOnFeatureFlagSnapshotV1;
}

export class TryOnFeatureFlagError extends Error {
  constructor(
    readonly code:
      | "invalid_config"
      | "invalid_matrix_combination"
      | "production_ineligible"
      | "missing_assignment_secret"
      | "missing_runtime_dependency",
    readonly diagnostic: string,
  ) {
    // Route 的既有 generic error handler 會直接回傳 Error.message，因此這裡只放可操作文案；
    // diagnostic 僅供離線 CLI／測試，不把 env 名稱或實驗細節洩漏給使用者。
    super("AI 試穿服務設定暫時不可用，請稍後再試；若持續發生請聯絡客服。");
    this.name = "TryOnFeatureFlagError";
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export const TRY_ON_FEATURE_MATRIX: readonly TryOnFeatureMatrixEntry[] = [
  {
    provider: "fashn",
    enhancement: "none",
    status: "supported",
    productionEligible: true,
    externalCost: true,
    requiredEnvironmentVariables: ["FASHN_API_KEY"],
    reason: "既有 tryon-v1.6 control。",
  },
  {
    provider: "fashn",
    enhancement: "realesrgan",
    status: "supported",
    productionEligible: true,
    externalCost: true,
    requiredEnvironmentVariables: ["FASHN_API_KEY", "REPLICATE_API_TOKEN"],
    reason: "v1.6 結果可選擇 2× 放大。",
  },
  {
    provider: "fashn-max",
    enhancement: "none",
    status: "supported",
    productionEligible: true,
    externalCost: true,
    requiredEnvironmentVariables: ["FASHN_API_KEY"],
    reason: "Max 已提供高解析輸出，不再做額外放大。",
  },
  {
    provider: "fashn-max",
    enhancement: "realesrgan",
    status: "unsupported",
    productionEligible: false,
    externalCost: true,
    requiredEnvironmentVariables: ["FASHN_API_KEY", "REPLICATE_API_TOKEN"],
    reason: "Max 沒有現有的解析度缺口；禁止重複增加成本。",
  },
  {
    provider: "mock",
    enhancement: "none",
    status: "evaluation-only",
    productionEligible: false,
    externalCost: false,
    requiredEnvironmentVariables: [],
    reason: "Mock 只用於離線或封閉流程驗證。",
  },
  {
    provider: "mock",
    enhancement: "realesrgan",
    status: "unsupported",
    productionEligible: false,
    externalCost: true,
    requiredEnvironmentVariables: ["REPLICATE_API_TOKEN"],
    reason: "不得對示範結果增加外部成本。",
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TryOnFeatureFlagError("invalid_config", `${field} 格式不合法`);
  }
  return value;
}

function parseVariant(value: unknown, field: string): TryOnFeatureVariant {
  if (!isRecord(value)) {
    throw new TryOnFeatureFlagError("invalid_config", `${field} 必須是 object`);
  }
  const provider = value.provider;
  const enhancement = value.enhancement;
  if (provider !== "fashn" && provider !== "fashn-max" && provider !== "mock") {
    throw new TryOnFeatureFlagError("invalid_config", `${field}.provider 不合法`);
  }
  if (enhancement !== "none" && enhancement !== "realesrgan") {
    throw new TryOnFeatureFlagError("invalid_config", `${field}.enhancement 不合法`);
  }
  if (value.generationConfigVersion !== "generation-v1") {
    throw new TryOnFeatureFlagError("invalid_config", `${field}.generationConfigVersion 不支援`);
  }
  if (!isRecord(value.prompt) || value.prompt.version !== "none" || value.prompt.hash !== null) {
    throw new TryOnFeatureFlagError("invalid_config", `${field}.prompt 版本尚未支援`);
  }
  const variant = {
    id: requireId(value.id, `${field}.id`),
    provider,
    enhancement,
    generationConfigVersion: "generation-v1",
    prompt: { version: "none", hash: null },
  } satisfies TryOnFeatureVariant;
  assertMatrixCombination(variant);
  return variant;
}

export function matrixEntryFor(
  provider: TryOnFeatureProvider,
  enhancement: TryOnFeatureEnhancement,
): TryOnFeatureMatrixEntry {
  const entry = TRY_ON_FEATURE_MATRIX.find(
    (candidate) => candidate.provider === provider && candidate.enhancement === enhancement,
  );
  if (!entry) {
    throw new TryOnFeatureFlagError("invalid_matrix_combination", `${provider}+${enhancement}`);
  }
  return entry;
}

export function assertMatrixCombination(variant: TryOnFeatureVariant): TryOnFeatureMatrixEntry {
  const entry = matrixEntryFor(variant.provider, variant.enhancement);
  if (entry.status === "unsupported") {
    throw new TryOnFeatureFlagError(
      "invalid_matrix_combination",
      `${variant.id}: ${entry.reason}`,
    );
  }
  return entry;
}

export function parseTryOnFeatureFlagConfig(value: unknown): TryOnFeatureFlagConfigV1 {
  if (!isRecord(value) || value.schemaVersion !== TRY_ON_FEATURE_FLAG_SCHEMA_VERSION) {
    throw new TryOnFeatureFlagError("invalid_config", "schemaVersion 必須是 1");
  }
  const mode = value.mode;
  if (mode !== "off" && mode !== "evaluation" && mode !== "canary" && mode !== "on") {
    throw new TryOnFeatureFlagError("invalid_config", "mode 不合法");
  }
  if (
    typeof value.rolloutPercentage !== "number" ||
    !Number.isInteger(value.rolloutPercentage) ||
    value.rolloutPercentage < 0 ||
    value.rolloutPercentage > 100
  ) {
    throw new TryOnFeatureFlagError("invalid_config", "rolloutPercentage 必須是 0–100 整數");
  }
  if (mode === "off" && value.rolloutPercentage !== 0) {
    throw new TryOnFeatureFlagError("invalid_config", "off 必須使用 0% rollout");
  }
  if ((mode === "evaluation" || mode === "on") && value.rolloutPercentage !== 100) {
    throw new TryOnFeatureFlagError("invalid_config", `${mode} 必須使用 100% rollout`);
  }
  const config = {
    schemaVersion: 1,
    experimentId: requireId(value.experimentId, "experimentId"),
    mode,
    rolloutPercentage: value.rolloutPercentage,
    saltVersion: requireId(value.saltVersion, "saltVersion"),
    control: parseVariant(value.control, "control"),
    candidate: parseVariant(value.candidate, "candidate"),
  } satisfies TryOnFeatureFlagConfigV1;
  if (config.control.id === config.candidate.id) {
    throw new TryOnFeatureFlagError("invalid_config", "control/candidate ID 不可相同");
  }
  return config;
}

export function parseTryOnFeatureFlagJson(raw: string): TryOnFeatureFlagConfigV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TryOnFeatureFlagError("invalid_config", "TRY_ON_FEATURE_FLAG_CONFIG 不是合法 JSON");
  }
  return parseTryOnFeatureFlagConfig(value);
}

function normalizedRequestedModel(value: unknown): TryOnModel | null {
  return value === "v1.6" || value === "max" ? value : null;
}

function assignmentBucket(secret: string, config: TryOnFeatureFlagConfigV1, key: string): number {
  const digest = createHmac("sha256", secret)
    .update(config.experimentId, "utf8")
    .update("\0", "utf8")
    .update(config.saltVersion, "utf8")
    .update("\0", "utf8")
    .update(key, "utf8")
    .digest();
  return (digest.readUInt32BE(0) / 2 ** 32) * 100;
}

function assertRuntimeDependencies(
  entry: TryOnFeatureMatrixEntry,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const missing = entry.requiredEnvironmentVariables.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new TryOnFeatureFlagError(
      "missing_runtime_dependency",
      `缺少 ${missing.join(", ")}`,
    );
  }
}

function makeDecision(input: {
  config: TryOnFeatureFlagConfigV1;
  role: TryOnVariantRole;
  assignmentVersion: TryOnFeatureFlagSnapshotV1["assignmentVersion"];
  requestedModel?: unknown;
  requestedProviderName: TryOnFeatureProvider;
}): ResolvedTryOnFeatureDecision {
  const variant = input.config[input.role];
  return {
    variant,
    variantRole: input.role,
    snapshot: {
      schemaVersion: 1,
      experimentId: input.config.experimentId,
      variantId: variant.id,
      variantRole: input.role,
      rolloutMode: input.config.mode,
      rolloutPercentage: input.config.rolloutPercentage,
      assignmentVersion: input.assignmentVersion,
      saltVersion: input.config.saltVersion,
      requestedModel: normalizedRequestedModel(input.requestedModel),
      requestedProviderName: input.requestedProviderName,
    },
  };
}

export function createDeploymentControlDecision(input: {
  requestedModel?: unknown;
  requestedProviderName: TryOnFeatureProvider;
  enhancement: TryOnFeatureEnhancement;
}): ResolvedTryOnFeatureDecision {
  const config: TryOnFeatureFlagConfigV1 = {
    schemaVersion: 1,
    experimentId: "deployment-control",
    mode: "off",
    rolloutPercentage: 0,
    saltVersion: "deployment-v1",
    control: {
      id: "control",
      provider: input.requestedProviderName,
      enhancement: input.enhancement,
      generationConfigVersion: "generation-v1",
      prompt: { version: "none", hash: null },
    },
    candidate: {
      id: "inactive-candidate",
      provider: input.requestedProviderName,
      enhancement: input.enhancement,
      generationConfigVersion: "generation-v1",
      prompt: { version: "none", hash: null },
    },
  };
  return makeDecision({
    config,
    role: "control",
    assignmentVersion: "deployment-control-v1",
    requestedModel: input.requestedModel,
    requestedProviderName: input.requestedProviderName,
  });
}

export function resolveTryOnFeatureDecision(input: {
  config: TryOnFeatureFlagConfigV1;
  assignmentKey: string;
  assignmentSecret?: string;
  executionContext: "runtime" | "evaluation";
  isProduction: boolean;
  requestedModel?: unknown;
  requestedProviderName: TryOnFeatureProvider;
  environment?: Readonly<Record<string, string | undefined>>;
  enforceRuntimeDependencies?: boolean;
}): ResolvedTryOnFeatureDecision {
  const { config } = input;
  let role: TryOnVariantRole = "control";
  if (config.mode === "evaluation" || config.mode === "canary") {
    if (!input.assignmentSecret || input.assignmentSecret.length < 32) {
      throw new TryOnFeatureFlagError(
        "missing_assignment_secret",
        "evaluation/canary 需要至少 32 字元的後端 HMAC secret",
      );
    }
  }
  if (config.mode === "evaluation") {
    role = input.executionContext === "evaluation" ? "candidate" : "control";
  } else if (config.mode === "canary") {
    if (config.rolloutPercentage === 100) role = "candidate";
    else if (config.rolloutPercentage > 0) {
      role = assignmentBucket(input.assignmentSecret!, config, input.assignmentKey) < config.rolloutPercentage
        ? "candidate"
        : "control";
    }
  } else if (config.mode === "on") {
    role = "candidate";
  }

  const selectedEntry = assertMatrixCombination(config[role]);
  if (input.isProduction && !selectedEntry.productionEligible) {
    throw new TryOnFeatureFlagError(
      "production_ineligible",
      `${config[role].id} 不得進入 production`,
    );
  }
  if (input.enforceRuntimeDependencies) {
    assertRuntimeDependencies(selectedEntry, input.environment ?? {});
  }
  return makeDecision({
    config,
    role,
    assignmentVersion: TRY_ON_ASSIGNMENT_VERSION,
    requestedModel: input.requestedModel,
    requestedProviderName: input.requestedProviderName,
  });
}

// Deterministic runner／單元測試的最高優先序注入；不讀 env、不做抽樣，也不得供 Route 使用。
export function forceTryOnFeatureDecision(input: {
  config: TryOnFeatureFlagConfigV1;
  role: TryOnVariantRole;
  requestedModel?: unknown;
  requestedProviderName: TryOnFeatureProvider;
}): ResolvedTryOnFeatureDecision {
  assertMatrixCombination(input.config[input.role]);
  return makeDecision({
    ...input,
    assignmentVersion: "forced-test-v1",
  });
}
