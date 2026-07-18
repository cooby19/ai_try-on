import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import {
  AI_JUDGE_OUTPUT_SCHEMA,
  AI_JUDGE_PROMPT_HASH,
  AI_JUDGE_PROMPT_VERSION,
  AI_JUDGE_SYSTEM_PROMPT,
  AI_JUDGE_TASK_PROMPT,
  parseAiJudgeResult,
  type AiJudgeResult,
  type AiJudgeVerdict,
} from "./ai-judge-prompt";

const DEFAULT_MODEL = "gpt-5.6";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

export interface BlindJudgePairDefinition {
  id: string;
  personImagePath: string;
  garmentImagePath: string;
  baselineOutputPath: string;
  challengerOutputPath: string;
}

export interface BlindJudgePlan {
  schemaVersion: 1;
  experimentId: string;
  baselineId: string;
  challengerId: string;
  pairs: BlindJudgePairDefinition[];
}

export type BlindJudgeContender = "baseline" | "challenger";
export type BlindJudgeConsensus = BlindJudgeContender | "tie" | "inconclusive";

export interface BlindJudgeAssignment {
  A: BlindJudgeContender;
  B: BlindJudgeContender;
}

export interface BlindJudgePassResult {
  pass: 1 | 2;
  assignment: BlindJudgeAssignment;
  responseId: string;
  responseModel: string;
  latencyMs: number;
  usage: OpenAiUsage | null;
  judgment: AiJudgeResult;
  mappedVerdict: BlindJudgeContender | "tie" | "abstain";
}

export interface BlindJudgePairResult {
  id: string;
  imageHashes: {
    personSha256: string;
    garmentSha256: string;
    baselineSha256: string;
    challengerSha256: string;
  };
  consensus: BlindJudgeConsensus;
  positionBiasDetected: boolean;
  passes: BlindJudgePassResult[];
  errors: string[];
}

export interface BlindJudgeReport {
  schemaVersion: 1;
  experimentId: string;
  baselineId: string;
  challengerId: string;
  judge: {
    model: string;
    reasoningEffort: "medium";
    imageDetail: "high";
    promptVersion: string;
    promptHash: string;
    passesPerPair: 2;
    responseStore: false;
  };
  planHash: string;
  imageManifestHash: string;
  startedAt: string;
  completedAt: string;
  summary: Record<BlindJudgeConsensus, number> & { total: number; positionBias: number };
  pairs: BlindJudgePairResult[];
}

export interface BlindJudgeDryRun {
  mode: "dry-run";
  experimentId: string;
  pairCount: number;
  apiCalls: number;
  model: string;
  promptVersion: string;
  promptHash: string;
  planHash: string;
  imageManifestHash: string;
  note: string;
}

interface OpenAiUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

interface OpenAiResponse {
  id?: string;
  model?: string;
  status?: string;
  error?: { message?: string } | null;
  usage?: OpenAiUsage | null;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
}

interface ImageData {
  dataUrl: string;
  hash: string;
}

export interface BlindJudgeRunOptions {
  repoRoot: string;
  plan: BlindJudgePlan;
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Judge plan 的 ${key} 不可為空`);
  }
  return value;
}

export function parseBlindJudgePlan(value: unknown): BlindJudgePlan {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Judge plan 必須是 schemaVersion 1 的 JSON object");
  }
  if (!Array.isArray(value.pairs) || value.pairs.length === 0) {
    throw new Error("Judge plan 至少需要一組 A/B pair");
  }

  const pairs = value.pairs.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Judge plan pairs[${index}] 格式不合法`);
    return {
      id: requireText(entry, "id"),
      personImagePath: requireText(entry, "personImagePath"),
      garmentImagePath: requireText(entry, "garmentImagePath"),
      baselineOutputPath: requireText(entry, "baselineOutputPath"),
      challengerOutputPath: requireText(entry, "challengerOutputPath"),
    };
  });
  if (new Set(pairs.map((pair) => pair.id)).size !== pairs.length) {
    throw new Error("Judge plan 的 pair id 不可重複");
  }

  return {
    schemaVersion: 1,
    experimentId: requireText(value, "experimentId"),
    baselineId: requireText(value, "baselineId"),
    challengerId: requireText(value, "challengerId"),
    pairs,
  };
}

export function loadBlindJudgePlan(path: string): BlindJudgePlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`無法讀取 Judge plan：${error instanceof Error ? error.message : String(error)}`);
  }
  return parseBlindJudgePlan(parsed);
}

function resolveLocalImage(repoRoot: string, path: string): ImageData {
  const absoluteRoot = realpathSync(resolve(repoRoot));
  const absolutePath = resolve(absoluteRoot, path);
  let realPath: string;
  try {
    realPath = realpathSync(absolutePath);
  } catch (error) {
    throw new Error(`無法解析 Judge 圖片 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
  const relativePath = relative(absoluteRoot, realPath);
  if (relativePath.startsWith("..") || relativePath === "") {
    throw new Error(`Judge 圖片路徑必須是 repo 內的明確檔案：${path}`);
  }

  const mime =
    ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" } as const)[
      extname(realPath).toLowerCase() as ".jpg" | ".jpeg" | ".png" | ".webp"
    ];
  if (!mime) throw new Error(`Judge 不支援此圖片格式：${path}`);

  let bytes: Buffer;
  try {
    bytes = readFileSync(realPath);
  } catch (error) {
    throw new Error(`無法讀取 Judge 圖片 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Judge 圖片必須介於 1 byte 與 20 MiB：${path}`);
  }
  return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, hash: sha256(bytes) };
}

export function assignmentForPair(experimentId: string, pairId: string, pass: 1 | 2): BlindJudgeAssignment {
  const baselineFirst = Number.parseInt(sha256(`${experimentId}:${pairId}`).slice(0, 2), 16) % 2 === 0;
  const passOne: BlindJudgeAssignment = baselineFirst
    ? { A: "baseline", B: "challenger" }
    : { A: "challenger", B: "baseline" };
  return pass === 1 ? passOne : { A: passOne.B, B: passOne.A };
}

function imageContent(label: string, image: ImageData) {
  return [
    { type: "input_text" as const, text: label },
    { type: "input_image" as const, image_url: image.dataUrl, detail: "high" as const },
  ];
}

export function buildBlindJudgeRequest(args: {
  model: string;
  person: ImageData;
  garment: ImageData;
  candidateA: ImageData;
  candidateB: ImageData;
}) {
  return {
    model: args.model,
    store: false,
    reasoning: { effort: "medium" },
    max_output_tokens: 3000,
    instructions: AI_JUDGE_SYSTEM_PROMPT,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text" as const, text: AI_JUDGE_TASK_PROMPT },
          ...imageContent("PERSON REFERENCE", args.person),
          ...imageContent("GARMENT REFERENCE", args.garment),
          ...imageContent("CANDIDATE A", args.candidateA),
          ...imageContent("CANDIDATE B", args.candidateB),
        ],
      },
    ],
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "try_on_blind_ab_judgment",
        strict: true,
        schema: AI_JUDGE_OUTPUT_SCHEMA,
      },
    },
  };
}

function extractOutput(response: OpenAiResponse): AiJudgeResult {
  if (response.status !== "completed") {
    throw new Error(response.error?.message || `OpenAI Judge 未完成（status=${response.status ?? "unknown"}）`);
  }
  for (const output of response.output ?? []) {
    if (output.type !== "message") continue;
    for (const content of output.content ?? []) {
      if (content.type === "refusal") throw new Error(`OpenAI Judge 拒絕評測：${content.refusal ?? "未提供原因"}`);
      if (content.type === "output_text" && content.text) {
        try {
          return parseAiJudgeResult(JSON.parse(content.text));
        } catch (error) {
          throw new Error(`OpenAI Judge 結構化輸出無效：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  throw new Error("OpenAI Judge 沒有回傳結構化結果");
}

function mapVerdict(verdict: AiJudgeVerdict, assignment: BlindJudgeAssignment) {
  if (verdict === "A" || verdict === "B") return assignment[verdict];
  return verdict;
}

export function reconcileBlindJudgePasses(
  passes: BlindJudgePassResult[],
): Pick<BlindJudgePairResult, "consensus" | "positionBiasDetected"> {
  if (passes.length !== 2) return { consensus: "inconclusive", positionBiasDetected: false };
  const [first, second] = passes;
  const decisiveConflict =
    (first.mappedVerdict === "baseline" || first.mappedVerdict === "challenger") &&
    (second.mappedVerdict === "baseline" || second.mappedVerdict === "challenger") &&
    first.mappedVerdict !== second.mappedVerdict;

  if (first.mappedVerdict === second.mappedVerdict) {
    if (first.mappedVerdict === "baseline" || first.mappedVerdict === "challenger" || first.mappedVerdict === "tie") {
      return { consensus: first.mappedVerdict, positionBiasDetected: decisiveConflict };
    }
  }
  return { consensus: "inconclusive", positionBiasDetected: decisiveConflict };
}

async function judgePass(args: {
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  pair: BlindJudgePairDefinition;
  repoRoot: string;
  experimentId: string;
  pass: 1 | 2;
}): Promise<BlindJudgePassResult> {
  const person = resolveLocalImage(args.repoRoot, args.pair.personImagePath);
  const garment = resolveLocalImage(args.repoRoot, args.pair.garmentImagePath);
  const baseline = resolveLocalImage(args.repoRoot, args.pair.baselineOutputPath);
  const challenger = resolveLocalImage(args.repoRoot, args.pair.challengerOutputPath);
  const assignment = assignmentForPair(args.experimentId, args.pair.id, args.pass);
  const candidateA = assignment.A === "baseline" ? baseline : challenger;
  const candidateB = assignment.B === "baseline" ? baseline : challenger;
  const request = buildBlindJudgeRequest({ model: args.model, person, garment, candidateA, candidateB });

  const started = performance.now();
  const httpResponse = await args.fetchImpl(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const latencyMs = Math.round(performance.now() - started);
  const body = (await httpResponse.json()) as OpenAiResponse;
  if (!httpResponse.ok) {
    throw new Error(`OpenAI Judge HTTP ${httpResponse.status}：${body.error?.message ?? "未提供錯誤原因"}`);
  }
  const judgment = extractOutput(body);
  return {
    pass: args.pass,
    assignment,
    responseId: body.id ?? "unknown",
    responseModel: body.model ?? args.model,
    latencyMs,
    usage: body.usage ?? null,
    judgment,
    mappedVerdict: mapVerdict(judgment.overall_verdict, assignment),
  };
}

function validateAllImages(repoRoot: string, plan: BlindJudgePlan) {
  for (const pair of plan.pairs) {
    resolveLocalImage(repoRoot, pair.personImagePath);
    resolveLocalImage(repoRoot, pair.garmentImagePath);
    resolveLocalImage(repoRoot, pair.baselineOutputPath);
    resolveLocalImage(repoRoot, pair.challengerOutputPath);
  }
}

function pairImageHashes(repoRoot: string, pair: BlindJudgePairDefinition) {
  return {
    personSha256: resolveLocalImage(repoRoot, pair.personImagePath).hash,
    garmentSha256: resolveLocalImage(repoRoot, pair.garmentImagePath).hash,
    baselineSha256: resolveLocalImage(repoRoot, pair.baselineOutputPath).hash,
    challengerSha256: resolveLocalImage(repoRoot, pair.challengerOutputPath).hash,
  };
}

function imageManifestHash(repoRoot: string, plan: BlindJudgePlan): string {
  return sha256(
    canonicalJson(plan.pairs.map((pair) => ({ id: pair.id, imageHashes: pairImageHashes(repoRoot, pair) }))),
  );
}

export function createBlindJudgeDryRun(args: {
  repoRoot: string;
  plan: BlindJudgePlan;
  model?: string;
}): BlindJudgeDryRun {
  validateAllImages(args.repoRoot, args.plan);
  return {
    mode: "dry-run",
    experimentId: args.plan.experimentId,
    pairCount: args.plan.pairs.length,
    apiCalls: args.plan.pairs.length * 2,
    model: args.model ?? DEFAULT_MODEL,
    promptVersion: AI_JUDGE_PROMPT_VERSION,
    promptHash: AI_JUDGE_PROMPT_HASH,
    planHash: sha256(canonicalJson(args.plan)),
    imageManifestHash: imageManifestHash(args.repoRoot, args.plan),
    note: "未呼叫外部 API；加上 --execute 才會送出圖片並產生費用。",
  };
}

export async function runBlindJudgeExperiment(options: BlindJudgeRunOptions): Promise<BlindJudgeReport> {
  if (!options.apiKey.trim()) throw new Error("執行 AI Judge 前必須設定 OPENAI_API_KEY");
  validateAllImages(options.repoRoot, options.plan);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_MODEL;
  const pairs: BlindJudgePairResult[] = [];

  for (const pair of options.plan.pairs) {
    const passes: BlindJudgePassResult[] = [];
    const errors: string[] = [];
    for (const pass of [1, 2] as const) {
      try {
        passes.push(
          await judgePass({
            apiKey: options.apiKey,
            model,
            fetchImpl,
            pair,
            repoRoot: options.repoRoot,
            experimentId: options.plan.experimentId,
            pass,
          }),
        );
      } catch (error) {
        errors.push(`pass ${pass}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const reconciled = reconcileBlindJudgePasses(passes);
    pairs.push({
      id: pair.id,
      imageHashes: pairImageHashes(options.repoRoot, pair),
      ...reconciled,
      passes,
      errors,
    });
  }

  const summary = {
    total: pairs.length,
    baseline: pairs.filter((pair) => pair.consensus === "baseline").length,
    challenger: pairs.filter((pair) => pair.consensus === "challenger").length,
    tie: pairs.filter((pair) => pair.consensus === "tie").length,
    inconclusive: pairs.filter((pair) => pair.consensus === "inconclusive").length,
    positionBias: pairs.filter((pair) => pair.positionBiasDetected).length,
  };
  return {
    schemaVersion: 1,
    experimentId: options.plan.experimentId,
    baselineId: options.plan.baselineId,
    challengerId: options.plan.challengerId,
    judge: {
      model,
      reasoningEffort: "medium",
      imageDetail: "high",
      promptVersion: AI_JUDGE_PROMPT_VERSION,
      promptHash: AI_JUDGE_PROMPT_HASH,
      passesPerPair: 2,
      responseStore: false,
    },
    planHash: sha256(canonicalJson(options.plan)),
    imageManifestHash: imageManifestHash(options.repoRoot, options.plan),
    startedAt,
    completedAt: now().toISOString(),
    summary,
    pairs,
  };
}
