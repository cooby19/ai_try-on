import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { normalizePersonImage } from "../src/lib/validation";
import { FashnVTOProvider } from "../src/lib/vto/fashn";
import { VTOProviderError } from "../src/lib/vto/provider";
import { resolveTryOnConfig } from "../src/lib/try-on/config";

const POLL_INTERVAL_MS = 4_000;
const CASE_POLL_TIMEOUT_MS = 4 * 60 * 1000;
const EXPECTED_PROVIDER_COST_USD = 0.075;
const USAGE = "Usage: npm run try-on:baseline:capture -- --execute [--plan <path>]";

interface CapturePlan {
  schemaVersion: 1;
  baselineId: string;
  provider: "fashn";
  modelName: "tryon-v1.6";
  maxSubmissions: number;
  estimatedCostUsd: number;
  enhancement: "none";
  persons: Array<{ id: string; path: string }>;
  excludedPersons: Array<{ id: string; path: string; reason: string }>;
  garments: Array<{ id: string; path: string }>;
  cases: Array<{ id: string; personId: string; garmentId: string; seed: number }>;
}

type CaptureCaseStatus =
  | "pending"
  | "submit_attempted"
  | "submitted"
  | "success"
  | "provider_failed"
  | "submit_error";

interface CaptureCaseState {
  caseId: string;
  status: CaptureCaseStatus;
  seed: number;
  submitAttemptedAt: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  providerJobId: string | null;
  resultPath: string | null;
  resultSha256: string | null;
  resultMimeType: string | null;
  resultWidth: number | null;
  resultHeight: number | null;
  configSnapshot: ReturnType<typeof resolveTryOnConfig>["snapshot"];
  error: { stage: string; httpStatus: number | null; code: string | null } | null;
}

interface CaptureState {
  schemaVersion: 1;
  baselineId: string;
  startedAt: string;
  updatedAt: string;
  submissionAttempts: number;
  estimatedSubmittedCostUsd: number;
  cases: Record<string, CaptureCaseState>;
}

function now(): string {
  return new Date().toISOString();
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeEnvValue(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadLocalEnvironment() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = decodeEnvValue(match[2]);
    }
  }
}

function repoFile(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\")) {
    throw new Error(`不安全的 repo-relative path：${path}`);
  }
  const root = process.cwd();
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`路徑超出 repo：${path}`);
  }
  return absolute;
}

function writeJsonAtomic(path: string, value: unknown) {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}

function writeBinaryOnce(path: string, value: Buffer) {
  if (existsSync(path)) {
    if (sha256(readFileSync(path)) !== sha256(value)) {
      throw new Error(`既有檔案內容不同，拒絕覆寫：${path}`);
    }
    return;
  }
  writeFileSync(path, value, { flag: "wx" });
}

function readPlan(path: string): CapturePlan {
  const plan = JSON.parse(readFileSync(path, "utf8")) as CapturePlan;
  const ids = plan.cases?.map((entry) => entry.id) ?? [];
  if (
    plan.schemaVersion !== 1 ||
    plan.provider !== "fashn" ||
    plan.modelName !== "tryon-v1.6" ||
    plan.enhancement !== "none" ||
    ids.length === 0 ||
    ids.length > 12 ||
    ids.length > plan.maxSubmissions ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("capture plan 格式、Provider 或案例上限不合法");
  }
  return plan;
}

function initialState(plan: CapturePlan): CaptureState {
  const timestamp = now();
  const cases = Object.fromEntries(
    plan.cases.map((entry) => {
      process.env.ENHANCE_PROVIDER = "none";
      const configSnapshot = resolveTryOnConfig("fashn", entry.seed).snapshot;
      return [
        entry.id,
        {
          caseId: entry.id,
          status: "pending",
          seed: entry.seed,
          submitAttemptedAt: null,
          submittedAt: null,
          completedAt: null,
          providerJobId: null,
          resultPath: null,
          resultSha256: null,
          resultMimeType: null,
          resultWidth: null,
          resultHeight: null,
          configSnapshot,
          error: null,
        } satisfies CaptureCaseState,
      ];
    }),
  );
  return {
    schemaVersion: 1,
    baselineId: plan.baselineId,
    startedAt: timestamp,
    updatedAt: timestamp,
    submissionAttempts: 0,
    estimatedSubmittedCostUsd: 0,
    cases,
  };
}

function saveState(path: string, state: CaptureState) {
  state.updatedAt = now();
  state.estimatedSubmittedCostUsd = Number(
    (state.submissionAttempts * EXPECTED_PROVIDER_COST_USD).toFixed(6),
  );
  writeJsonAtomic(path, state);
}

async function preprocessPerson(inputPath: string, outputPath: string): Promise<Buffer> {
  const normalized = await normalizePersonImage(readFileSync(inputPath));
  if (!normalized.ok) throw new Error(normalized.message);
  writeBinaryOnce(outputPath, normalized.buffer);
  return normalized.buffer;
}

async function preprocessGarment(inputPath: string, outputPath: string): Promise<Buffer> {
  const buffer = await sharp(readFileSync(inputPath))
    .rotate()
    .resize({ width: 1024, withoutEnlargement: true })
    .png()
    .toBuffer();
  writeBinaryOnce(outputPath, buffer);
  return buffer;
}

function providerError(cause: unknown): CaptureCaseState["error"] {
  if (cause instanceof VTOProviderError) {
    return {
      stage: cause.stage,
      httpStatus: cause.httpStatus ?? null,
      code: cause.name,
    };
  }
  return { stage: "unknown", httpStatus: null, code: cause instanceof Error ? cause.name : null };
}

async function wait(milliseconds: number) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function captureCase(options: {
  plan: CapturePlan;
  planPath: string;
  state: CaptureState;
  statePath: string;
  definition: CapturePlan["cases"][number];
  provider: FashnVTOProvider;
}) {
  const { plan, state, statePath, definition, provider } = options;
  const caseState = state.cases[definition.id];
  if (caseState.status === "success" || caseState.status === "provider_failed") return;
  if (caseState.status === "submit_attempted" || caseState.status === "submit_error") {
    throw new Error(
      `${definition.id} 曾送出但沒有可安全 resume 的 Provider job ID；為避免重複計費，停止。`,
    );
  }

  const person = plan.persons.find((entry) => entry.id === definition.personId);
  const garment = plan.garments.find((entry) => entry.id === definition.garmentId);
  if (!person || !garment) throw new Error(`${definition.id} 引用不存在的輸入`);

  const candidateDirectory = dirname(options.planPath);
  const personOutput = resolve(candidateDirectory, "preprocessed/models", `${person.id}.jpg`);
  const garmentOutput = resolve(candidateDirectory, "preprocessed/garments", `${garment.id}.png`);
  const personBuffer = await preprocessPerson(repoFile(person.path), personOutput);
  const garmentBuffer = await preprocessGarment(repoFile(garment.path), garmentOutput);

  if (!caseState.providerJobId) {
    if (state.submissionAttempts >= plan.maxSubmissions) {
      throw new Error(`已達 ${plan.maxSubmissions} 次 submission 上限`);
    }
    caseState.status = "submit_attempted";
    caseState.submitAttemptedAt = now();
    state.submissionAttempts += 1;
    saveState(statePath, state);
    console.log(`[${state.submissionAttempts}/${plan.maxSubmissions}] submit ${definition.id}`);
    try {
      const resolved = resolveTryOnConfig("fashn", definition.seed);
      const submitted = await provider.submit({
        personImage: personBuffer,
        garmentImage: garmentBuffer,
        garmentType: "tops",
        generationConfig: resolved.provider,
      });
      caseState.providerJobId = submitted.providerJobId;
      caseState.submittedAt = now();
      caseState.status = "submitted";
      saveState(statePath, state);
    } catch (cause) {
      caseState.status = "submit_error";
      caseState.error = providerError(cause);
      saveState(statePath, state);
      throw cause;
    }
  }

  const pollStartedAt = Date.now();
  while (Date.now() - pollStartedAt < CASE_POLL_TIMEOUT_MS) {
    const result = await provider.checkStatus(caseState.providerJobId);
    if (result.status === "processing") {
      await wait(POLL_INTERVAL_MS);
      continue;
    }
    caseState.completedAt = now();
    if (result.status === "failed") {
      caseState.status = "provider_failed";
      caseState.error = {
        stage: "provider_terminal",
        httpStatus: result.providerHttpStatus ?? null,
        code: result.errorCode ?? null,
      };
      saveState(statePath, state);
      console.log(`[FAILED] ${definition.id} ${result.errorCode ?? "provider rejection"}`);
      return;
    }

    const metadata = await sharp(result.resultImage).metadata();
    if (metadata.format !== "jpeg" || !metadata.width || !metadata.height) {
      throw new Error(`${definition.id} 回傳的結果不是有效 JPEG`);
    }
    const resultRelativePath = `fixtures/try-on-baselines/v1.0.0-candidate.2/results/${definition.id}.jpg`;
    writeBinaryOnce(repoFile(resultRelativePath), result.resultImage);
    caseState.status = "success";
    caseState.resultPath = resultRelativePath;
    caseState.resultSha256 = sha256(result.resultImage);
    caseState.resultMimeType = "image/jpeg";
    caseState.resultWidth = metadata.width;
    caseState.resultHeight = metadata.height;
    caseState.error = null;
    saveState(statePath, state);
    console.log(`[SUCCESS] ${definition.id} ${metadata.width}x${metadata.height}`);
    return;
  }
  throw new Error(`${definition.id} 輪詢超過 ${CASE_POLL_TIMEOUT_MS / 1000} 秒；可安全重新執行以繼續 poll。`);
}

async function main() {
  const args = process.argv.slice(2);
  let execute = false;
  let planArgument = "fixtures/try-on-baselines/v1.0.0-candidate.2/capture-plan.json";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--execute") execute = true;
    else if (argument === "--plan") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`--plan 需要路徑\n${USAGE}`);
      planArgument = value;
      index += 1;
    } else throw new Error(`未知參數：${argument}\n${USAGE}`);
  }
  if (!execute) throw new Error(`付費 capture 必須明確加上 --execute\n${USAGE}`);

  loadLocalEnvironment();
  process.env.ENHANCE_PROVIDER = "none";
  if (!process.env.FASHN_API_KEY) throw new Error("缺少 FASHN_API_KEY");

  const planPath = repoFile(planArgument);
  const plan = readPlan(planPath);
  const statePath = resolve(dirname(planPath), "capture-state.json");
  const state = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as CaptureState)
    : initialState(plan);
  if (state.baselineId !== plan.baselineId) throw new Error("capture state 與 plan baselineId 不一致");
  saveState(statePath, state);

  const provider = new FashnVTOProvider();
  for (const definition of plan.cases) {
    await captureCase({ plan, planPath, state, statePath, definition, provider });
  }
  const successful = Object.values(state.cases).filter((entry) => entry.status === "success").length;
  const failed = Object.values(state.cases).filter((entry) => entry.status === "provider_failed").length;
  console.log(
    `Capture complete: ${successful} success, ${failed} provider failed, ${state.submissionAttempts} submissions, estimated USD ${state.estimatedSubmittedCostUsd.toFixed(4)}`,
  );
}

void main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : "capture 失敗");
  process.exitCode = 1;
});
