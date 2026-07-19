import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Product, TryOnJob } from "../types";
import type { VTOProvider, VTOStatusResult } from "../vto/provider";
import { VTOProviderError } from "../vto/provider";
import { resolveTryOnConfig } from "./config";
import {
  forceTryOnFeatureDecision,
  parseTryOnFeatureFlagConfig,
  TryOnFeatureFlagError,
  type TryOnFeatureFlagConfigV1,
  type TryOnVariantRole,
} from "./feature-flags-core";
import {
  createTryOnWorkflow,
  type StartTryOnInput,
  type TryOnWorkflowDependencies,
} from "./workflow-core";

const FIXTURE_PATH = resolve(process.cwd(), "fixtures/try-on-cases/cases.v1.json");
const PERSON_BYTES = Buffer.from("deterministic-person-image-v1", "utf8");
const GARMENT_BYTES = Buffer.from("deterministic-garment-image-v1", "utf8");
const RESULT_BYTES = Buffer.from("deterministic-result-image-v1", "utf8");
const GENERATED_SEED = 424242;

type ProductState = "active" | "missing";
type InitialJobState = "none" | "processing" | "conflict";
type QuotaBehavior = "allowed" | "rejected";
type ReadBehavior = "success" | "failure";
type SubmitBehavior = "success" | "http-503";
type PollBehavior = "processing" | "success" | "rejected";

export interface ScenarioIds {
  userId: string;
  productId: string;
  jobId: string;
  providerJobId: string;
  personImagePath: string;
  garmentImagePath: string;
}

export interface ScenarioDefinition {
  id: string;
  description: string;
  clock: { start: string; stepMs: number };
  ids: ScenarioIds;
  steps: Array<
    | { action: "start"; input: Omit<StartTryOnInput, "userId"> }
    | { action: "poll" }
  >;
  initialState: { product: ProductState; job: InitialJobState; provider: "fashn" | "fashn-max" };
  behavior: {
    ownedPersonImage: boolean;
    quota: QuotaBehavior;
    personRead: ReadBehavior;
    garmentRead: ReadBehavior;
    providerSubmit: SubmitBehavior;
    poll: PollBehavior[];
  };
  expected: ScenarioActual;
}

export interface ScenarioManifest {
  schemaVersion: 1;
  cases: ScenarioDefinition[];
}

export interface NormalizedJob {
  id: string;
  status: TryOnJob["status"];
  provider: string;
  providerJobId: string | null;
  resultImagePath: string | null;
  costEstimate: number;
  seed: number | null;
  configSnapshot: TryOnJob["config_snapshot"];
  startedAt: string | null;
  providerSubmittedAt: string | null;
  completedAt: string | null;
  lastPolledAt: string | null;
  errorType: TryOnJob["error_type"];
  errorCode: string | null;
  providerHttpStatus: number | null;
  idempotencyKey: string | null;
  requestFingerprint: string | null;
}

export interface ScenarioActual {
  results: unknown[];
  finalJob: NormalizedJob | null;
  trace: string[];
}

export interface ScenarioComparison {
  id: string;
  passed: boolean;
  actual?: ScenarioActual;
  expected?: ScenarioActual;
  difference?: string;
}

export interface ScenarioRunSummary {
  schemaVersion: 1;
  passed: number;
  failed: number;
  cases: ScenarioComparison[];
}

export interface CliResult {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

export interface ScenarioExecutionOptions {
  featureConfig: TryOnFeatureFlagConfigV1;
  forcedVariant: TryOnVariantRole;
}

class FixedClock {
  private nextMs: number;

  constructor(start: string, private readonly stepMs: number) {
    this.nextMs = Date.parse(start);
    if (!Number.isFinite(this.nextMs) || !Number.isInteger(stepMs) || stepMs <= 0) {
      throw new Error("案例 clock 設定不合法");
    }
  }

  now(): string {
    const value = new Date(this.nextMs).toISOString();
    this.nextMs += this.stepMs;
    return value;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function prettyCanonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeJob(job: TryOnJob | null): NormalizedJob | null {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    provider: job.provider,
    providerJobId: job.provider_job_id,
    resultImagePath: job.result_image_url,
    costEstimate: Number(job.cost_estimate),
    seed: job.seed,
    configSnapshot: job.config_snapshot,
    startedAt: job.started_at,
    providerSubmittedAt: job.provider_submitted_at,
    completedAt: job.completed_at,
    lastPolledAt: job.last_polled_at,
    errorType: job.error_type,
    errorCode: job.error_code,
    providerHttpStatus: job.provider_http_status,
    idempotencyKey: job.idempotency_key,
    requestFingerprint: job.request_fingerprint,
  };
}

function deterministicConfig(
  providerName: string,
  seed: number,
  featureDecision?: Parameters<typeof resolveTryOnConfig>[2],
) {
  const previous = process.env.ENHANCE_PROVIDER;
  process.env.ENHANCE_PROVIDER = "none";
  try {
    return resolveTryOnConfig(providerName, seed, featureDecision);
  } finally {
    if (previous === undefined) delete process.env.ENHANCE_PROVIDER;
    else process.env.ENHANCE_PROVIDER = previous;
  }
}

function makeProduct(ids: ScenarioIds): Product {
  return {
    id: ids.productId,
    name: "固定案例上衣",
    price: 1200,
    image_url: "/garments/scenario.svg",
    garment_image_url: ids.garmentImagePath,
    category: "tops",
    color: "navy",
    fit: null,
    material: null,
    size_chart: null,
    is_active: true,
    created_at: "2026-07-01T00:00:00.000Z",
  };
}

function makeInitialJob(definition: ScenarioDefinition): TryOnJob | null {
  if (definition.initialState.job === "none") return null;
  const { ids } = definition;
  const snapshot = deterministicConfig(definition.initialState.provider, 777).snapshot;
  return {
    id: ids.jobId,
    user_id: ids.userId,
    source_hash: null,
    product_id: ids.productId,
    person_image_url: ids.personImagePath,
    garment_image_url: ids.garmentImagePath,
    result_image_url: null,
    provider: definition.initialState.provider,
    provider_job_id: ids.providerJobId,
    status: "processing",
    cost_estimate: definition.initialState.provider === "fashn-max" ? 0.15 : 0.075,
    budget_reservation: definition.initialState.provider === "fashn-max" ? 0.15 : 0.075,
    retry_count: 0,
    error_message: null,
    config_snapshot: snapshot,
    seed: 777,
    started_at: definition.clock.start,
    provider_submitted_at: definition.clock.start,
    completed_at: null,
    last_polled_at: null,
    error_type: null,
    error_code: null,
    provider_http_status: null,
    idempotency_key:
      definition.initialState.job === "conflict" ? "fixed-idempotency-key" : null,
    request_fingerprint:
      definition.initialState.job === "conflict" ? "f".repeat(64) : null,
    created_at: definition.clock.start,
    updated_at: definition.clock.start,
  };
}

function updateStoredJob(
  job: TryOnJob,
  fields: Parameters<TryOnWorkflowDependencies["updateJobStatus"]>[1],
  eventAt: string,
): TryOnJob {
  const updated: TryOnJob = { ...job, ...fields, updated_at: eventAt };
  if (fields.status === "processing" && fields.provider_job_id) {
    updated.provider_submitted_at = eventAt;
  }
  if (fields.status === "success" || fields.status === "failed") {
    updated.completed_at = eventAt;
  }
  if (fields.status === "success") {
    updated.error_message = null;
    updated.error_type = null;
    updated.error_code = null;
    updated.provider_http_status = null;
  }
  return updated;
}

export const scenarioWorkflowFactory = createTryOnWorkflow;

export async function executeScenario(
  definition: ScenarioDefinition,
  options?: ScenarioExecutionOptions,
): Promise<ScenarioActual> {
  const clock = new FixedClock(definition.clock.start, definition.clock.stepMs);
  const trace: string[] = [];
  const jobs = new Map<string, TryOnJob>();
  const initialJob = makeInitialJob(definition);
  if (initialJob) jobs.set(initialJob.id, initialJob);
  let pollIndex = 0;

  const provider: VTOProvider = {
    providerName: definition.initialState.provider,
    costEstimate: definition.initialState.provider === "fashn-max" ? 0.15 : 0.075,
    requiresImagesOnPoll: false,
    async submit(input) {
      trace.push(
        `provider.submit:${this.providerName}:seed=${input.generationConfig.seed}:person=${sha256(input.personImage)}:garment=${sha256(input.garmentImage)}`,
      );
      if (definition.behavior.providerSubmit === "http-503") {
        throw new VTOProviderError("provider unavailable", "provider_submit", 503);
      }
      return { providerJobId: definition.ids.providerJobId };
    },
    async checkStatus(providerJobId): Promise<VTOStatusResult> {
      const behavior = definition.behavior.poll[pollIndex] ?? "processing";
      trace.push(`provider.checkStatus:${providerJobId}:${pollIndex}:${behavior}`);
      pollIndex += 1;
      if (behavior === "success") return { status: "success", resultImage: RESULT_BYTES };
      if (behavior === "rejected") {
        return {
          status: "failed",
          errorMessage: "provider rejected the image",
          errorCode: "CONTENT_REJECTED",
          providerHttpStatus: 422,
        };
      }
      return { status: "processing" };
    },
  };

  const deps: TryOnWorkflowDependencies = {
    now: () => clock.now(),
    generateSeed() {
      trace.push(`seed.generate:${GENERATED_SEED}`);
      return GENERATED_SEED;
    },
    resolveProviderName(requestedModel) {
      if (requestedModel === undefined || requestedModel === "v1.6") return "fashn";
      if (requestedModel === "max") return "fashn-max";
      return null;
    },
    resolveFeatureDecision: options
      ? ({ requestedModel, requestedProviderName }) =>
          forceTryOnFeatureDecision({
            config: options.featureConfig,
            role: options.forcedVariant,
            requestedModel,
            requestedProviderName,
          })
      : undefined,
    resolveConfig: deterministicConfig,
    isOwnedPersonImagePath() {
      return definition.behavior.ownedPersonImage;
    },
    async findJobByIdempotency(userId, idempotencyKey) {
      trace.push(`idempotency.find:${userId}:${idempotencyKey}`);
      return (
        [...jobs.values()].find(
          (job) => job.user_id === userId && job.idempotency_key === idempotencyKey,
        ) ?? null
      );
    },
    async checkQuota(userId, productId) {
      trace.push(`quota.check:${userId}:${productId}:${definition.behavior.quota}`);
      if (definition.behavior.quota === "rejected") {
        return {
          allowed: false,
          isUnlimited: false,
          reason: "你今天的 AI 試穿額度（3 次）已用完，明天會自動恢復。",
          usedToday: 3,
          remainingToday: 0,
          productAttemptsToday: 1,
          remainingRetriesForProduct: 2,
        };
      }
      return {
        allowed: true,
        isUnlimited: false,
        usedToday: jobs.size,
        remainingToday: Math.max(0, 3 - jobs.size),
        productAttemptsToday: jobs.size,
        remainingRetriesForProduct: Math.max(0, 3 - jobs.size),
      };
    },
    async loadProduct(productId) {
      trace.push(`product.load:${productId}:${definition.initialState.product}`);
      return definition.initialState.product === "active" ? makeProduct(definition.ids) : null;
    },
    getProvider(providerName) {
      return {
        ...provider,
        providerName,
        costEstimate: providerName === "fashn-max" ? 0.15 : providerName === "mock" ? 0 : 0.075,
      };
    },
    getEnhancementCostEstimate(providerName) {
      trace.push(`enhancement.estimate:${providerName}:0`);
      return 0;
    },
    async recordJob(input) {
      trace.push(
        `job.record:${input.provider}:seed=${input.seed}:startedAt=${input.startedAt}:key=${input.idempotencyKey ?? "null"}`,
      );
      const job: TryOnJob = {
        id: definition.ids.jobId,
        user_id: input.userId,
        source_hash: null,
        product_id: input.productId,
        person_image_url: input.personImagePath,
        garment_image_url: input.garmentImageUrl,
        result_image_url: null,
        provider: input.provider,
        provider_job_id: null,
        status: "pending",
        cost_estimate: input.costEstimate,
        budget_reservation: input.budgetReservation,
        retry_count: 0,
        error_message: null,
        config_snapshot: input.configSnapshot,
        seed: input.seed,
        started_at: input.startedAt,
        provider_submitted_at: null,
        completed_at: null,
        last_polled_at: null,
        error_type: null,
        error_code: null,
        provider_http_status: null,
        idempotency_key: input.idempotencyKey ?? null,
        request_fingerprint: input.requestFingerprint ?? null,
        created_at: input.startedAt,
        updated_at: input.startedAt,
      };
      jobs.set(job.id, job);
      return { outcome: "created" as const, remainingToday: 2, job };
    },
    async updateJobStatus(jobId, fields, eventAt) {
      const timestamp = eventAt ?? clock.now();
      trace.push(`job.update:${jobId}:${canonicalJson(fields)}:at=${timestamp}`);
      const job = jobs.get(jobId);
      if (!job) throw new Error(`unknown scenario job: ${jobId}`);
      jobs.set(jobId, updateStoredJob(job, fields, timestamp));
    },
    async downloadPersonImage(path) {
      trace.push(`person.download:${path}:${definition.behavior.personRead}`);
      if (definition.behavior.personRead === "failure") {
        throw new Error("讀取不到剛上傳的照片，請重新上傳一次。");
      }
      return PERSON_BYTES;
    },
    async loadGarmentImage(path) {
      trace.push(`garment.load:${path}:${definition.behavior.garmentRead}`);
      if (definition.behavior.garmentRead === "failure") {
        throw new Error("商品圖片讀取失敗");
      }
      return GARMENT_BYTES;
    },
    async loadOwnedJob(jobId, userId) {
      trace.push(`job.loadOwned:${jobId}:${userId}`);
      const job = jobs.get(jobId);
      return job?.user_id === userId ? job : null;
    },
    async enhanceResultImage(image, providerName) {
      trace.push(`enhancement.run:${providerName}:${sha256(image)}:skipped`);
      return { image, enhanced: false, extraCost: 0 };
    },
    async uploadResultImage(path, image) {
      trace.push(`result.upload:${path}:${sha256(image)}:${image.byteLength}`);
      return null;
    },
    async updateJobCost(jobId, costEstimate, updatedAt) {
      trace.push(`job.cost:${jobId}:${costEstimate}:at=${updatedAt}`);
      const job = jobs.get(jobId);
      if (job) jobs.set(jobId, { ...job, cost_estimate: costEstimate, updated_at: updatedAt });
      return null;
    },
    async createPersonSignedUrl(path) {
      trace.push(`signed.person:${path}`);
      return `signed://person/${path}`;
    },
    async createResultSignedUrl(path) {
      trace.push(`signed.result:${path}`);
      return `signed://result/${path}`;
    },
    logCostUpdateError(jobId, message) {
      trace.push(`job.cost.error:${jobId}:${message}`);
    },
  };

  const workflow = scenarioWorkflowFactory(deps);
  const results: unknown[] = [];
  for (const step of definition.steps) {
    if (step.action === "start") {
      results.push(
        await workflow.startTryOnWorkflow({ userId: definition.ids.userId, ...step.input }),
      );
    } else {
      results.push(
        await workflow.getAndAdvanceTryOnWorkflow({
          userId: definition.ids.userId,
          jobId: definition.ids.jobId,
        }),
      );
    }
  }

  return {
    results,
    finalJob: normalizeJob(jobs.get(definition.ids.jobId) ?? null),
    trace,
  };
}

export function loadScenarioManifest(path = FIXTURE_PATH): ScenarioManifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ScenarioManifest;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.cases)) {
    throw new Error("固定案例 manifest 格式不合法");
  }
  const ids = parsed.cases.map((entry) => entry.id);
  if (ids.length !== 16 || new Set(ids).size !== ids.length) {
    throw new Error("固定案例必須恰好 16 個，且 ID 不可重複");
  }
  return parsed;
}

function firstDifference(actual: unknown, expected: unknown): string {
  const actualJson = canonicalJson(actual);
  const expectedJson = canonicalJson(expected);
  let index = 0;
  while (
    index < actualJson.length &&
    index < expectedJson.length &&
    actualJson[index] === expectedJson[index]
  ) {
    index += 1;
  }
  const start = Math.max(0, index - 50);
  const end = index + 120;
  return `first difference at byte ${index}; expected=${JSON.stringify(expectedJson.slice(start, end))}; actual=${JSON.stringify(actualJson.slice(start, end))}`;
}

export async function runScenarios(
  definitions: ScenarioDefinition[],
  options?: ScenarioExecutionOptions,
): Promise<ScenarioRunSummary> {
  const comparisons: ScenarioComparison[] = [];
  for (const definition of definitions) {
    try {
      const actual = await executeScenario(definition, options);
      const passed = canonicalJson(actual) === canonicalJson(definition.expected);
      comparisons.push(
        passed
          ? { id: definition.id, passed: true }
          : {
              id: definition.id,
              passed: false,
              actual,
              expected: definition.expected,
              difference: firstDifference(actual, definition.expected),
            },
      );
    } catch (cause) {
      comparisons.push({
        id: definition.id,
        passed: false,
        difference: cause instanceof Error ? cause.message : "unknown scenario error",
      });
    }
  }
  const passed = comparisons.filter((entry) => entry.passed).length;
  return { schemaVersion: 1, passed, failed: comparisons.length - passed, cases: comparisons };
}

export async function runScenarioObservations(
  definitions: ScenarioDefinition[],
  options: ScenarioExecutionOptions,
) {
  const cases: Array<{ id: string; actual?: ScenarioActual; error?: string }> = [];
  for (const definition of definitions) {
    try {
      cases.push({ id: definition.id, actual: await executeScenario(definition, options) });
    } catch (cause) {
      cases.push({
        id: definition.id,
        error: cause instanceof Error ? cause.message : "unknown scenario error",
      });
    }
  }
  return {
    schemaVersion: 1 as const,
    mode: "feature-observation" as const,
    experimentId: options.featureConfig.experimentId,
    variantRole: options.forcedVariant,
    failed: cases.filter((entry) => entry.error).length,
    cases,
  };
}

export function installNetworkGuard(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("deterministic scenario runner forbids external network access");
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function usageError(message: string): CliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${message}\nUsage: npm run try-on:cases -- [--list] [--case <id>] [--json] [--feature-config <path> --variant <control|candidate>]\n`,
  };
}

export async function runScenarioCli(args: string[]): Promise<CliResult> {
  let list = false;
  let json = false;
  let caseId: string | undefined;
  let featureConfigPath: string | undefined;
  let forcedVariant: TryOnVariantRole | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--list") list = true;
    else if (argument === "--json") json = true;
    else if (argument === "--case") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return usageError("--case 需要案例 ID");
      caseId = value;
      index += 1;
    } else if (argument === "--feature-config") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) return usageError("--feature-config 需要 JSON path");
      featureConfigPath = value;
      index += 1;
    } else if (argument === "--variant") {
      const value = args[index + 1];
      if (value !== "control" && value !== "candidate") {
        return usageError("--variant 必須是 control 或 candidate");
      }
      forcedVariant = value;
      index += 1;
    } else {
      return usageError(`未知參數：${argument}`);
    }
  }
  if (list && caseId) return usageError("--list 與 --case 不可同時使用");
  if (Boolean(featureConfigPath) !== Boolean(forcedVariant)) {
    return usageError("--feature-config 與 --variant 必須一起使用");
  }
  if (list && featureConfigPath) return usageError("--list 不接受 Feature Flag 注入");

  let manifest: ScenarioManifest;
  try {
    manifest = loadScenarioManifest();
  } catch (cause) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${cause instanceof Error ? cause.message : "無法載入固定案例"}\n`,
    };
  }

  if (list) {
    const ids = manifest.cases.map((entry) => entry.id);
    return {
      exitCode: 0,
      stdout: json ? prettyCanonicalJson({ schemaVersion: 1, cases: ids }) : `${ids.join("\n")}\n`,
      stderr: "",
    };
  }
  const selected = caseId
    ? manifest.cases.filter((definition) => definition.id === caseId)
    : manifest.cases;
  if (caseId && selected.length === 0) return usageError(`未知案例：${caseId}`);

  const restoreNetwork = installNetworkGuard();
  try {
    if (featureConfigPath && forcedVariant) {
      let featureConfig: TryOnFeatureFlagConfigV1;
      try {
        featureConfig = parseTryOnFeatureFlagConfig(
          JSON.parse(readFileSync(resolve(process.cwd(), featureConfigPath), "utf8")),
        );
      } catch (cause) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `${cause instanceof TryOnFeatureFlagError ? cause.diagnostic : cause instanceof Error ? cause.message : "無法載入 Feature Flag config"}\n`,
        };
      }
      const observation = await runScenarioObservations(selected, {
        featureConfig,
        forcedVariant,
      });
      if (json) {
        return {
          exitCode: observation.failed === 0 ? 0 : 1,
          stdout: prettyCanonicalJson(observation),
          stderr: "",
        };
      }
      const lines = observation.cases.map((entry) =>
        entry.error ? `[FAIL] ${entry.id}\n  ${entry.error}` : `[OBSERVED] ${entry.id}`,
      );
      lines.push(
        `${observation.cases.length - observation.failed} observed, ${observation.failed} failed`,
      );
      return {
        exitCode: observation.failed === 0 ? 0 : 1,
        stdout: `${lines.join("\n")}\n`,
        stderr: "",
      };
    }
    const summary = await runScenarios(selected);
    if (json) {
      return {
        exitCode: summary.failed === 0 ? 0 : 1,
        stdout: prettyCanonicalJson(summary),
        stderr: "",
      };
    }
    const lines = summary.cases.map((entry) =>
      entry.passed ? `[PASS] ${entry.id}` : `[FAIL] ${entry.id}\n  ${entry.difference}`,
    );
    lines.push(`${summary.passed} passed, ${summary.failed} failed`);
    return {
      exitCode: summary.failed === 0 ? 0 : 1,
      stdout: `${lines.join("\n")}\n`,
      stderr: "",
    };
  } finally {
    restoreNetwork();
  }
}
