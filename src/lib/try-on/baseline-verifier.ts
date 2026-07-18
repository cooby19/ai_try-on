import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import sharp from "sharp";

type BaselineStatus = "candidate" | "approved";
type ReviewDecision = "accept" | "reject" | "needs_rerun" | null;

interface FileReference {
  path: string;
  sha256: string;
}

interface ImageReference extends FileReference {
  mimeType: string;
  width: number;
  height: number;
}

interface WorkflowCaseReference {
  caseId: string;
  definitionSha256: string;
  expectedOutputSha256: string;
  traceSha256: string;
}

interface VisualReview {
  reviewer: string | null;
  reviewedAt: string | null;
  decision: ReviewDecision;
  notes: string | null;
}

interface VisualCase {
  caseId: string;
  inputs: ImageReference[];
  output: ImageReference;
  review: VisualReview;
}

interface BaselineManifest {
  schemaVersion: number;
  baselineId: string;
  status: BaselineStatus;
  approval: VisualReview;
  git: {
    commitSha: string;
    worktreeDirty: boolean;
  };
  workflowRegression: {
    fixture: FileReference & { caseCount: number };
    cases: WorkflowCaseReference[];
    embeddedRunnerInputs: Array<{
      identifier: string;
      encoding: "utf8";
      sha256: string;
    }>;
  };
  visualQuality: {
    status: "blocked_missing_real_outputs" | "candidate" | "approved";
    reviewDocument: FileReference;
    reviewArtifacts?: FileReference[];
    availableInputs: ImageReference[];
    cases: VisualCase[];
  };
  productionMetricsReference: {
    reports: FileReference[];
  };
}

export interface BaselineVerificationResult {
  baselineId: string | null;
  status: BaselineStatus | null;
  errors: string[];
  warnings: string[];
  checkedFiles: number;
  checkedWorkflowCases: number;
  checkedVisualCases: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function sha256Buffer(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalSha256(value: unknown): string {
  return sha256Buffer(JSON.stringify(stableValue(value)));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function resolveRepoFile(repoRoot: string, path: string): string | null {
  if (!path || path.startsWith("/") || path.includes("\\")) return null;
  const absolute = resolve(repoRoot, path);
  const fromRoot = relative(repoRoot, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return null;
  return absolute;
}

function parseManifest(value: unknown, errors: string[]): BaselineManifest | null {
  if (!isRecord(value)) {
    errors.push("manifest 必須是 JSON object");
    return null;
  }
  if (value.schemaVersion !== 1) errors.push("不支援的 baseline schemaVersion");
  if (typeof value.baselineId !== "string" || value.baselineId.length === 0) {
    errors.push("baselineId 不可為空");
  }
  if (value.status !== "candidate" && value.status !== "approved") {
    errors.push("status 必須是 candidate 或 approved");
  }
  if (!isRecord(value.approval) || !isRecord(value.git)) errors.push("approval／git 格式不合法");
  if (!isRecord(value.workflowRegression) || !isRecord(value.visualQuality)) {
    errors.push("workflowRegression／visualQuality 格式不合法");
  }
  if (!isRecord(value.productionMetricsReference)) {
    errors.push("productionMetricsReference 格式不合法");
  }
  if (isRecord(value.git)) {
    if (typeof value.git.worktreeDirty !== "boolean") errors.push("git.worktreeDirty 格式不合法");
    if (typeof value.git.commitSha !== "string" || !/^[a-f0-9]{40}$/u.test(value.git.commitSha)) {
      errors.push("git.commitSha 格式不合法");
    }
  }
  if (isRecord(value.workflowRegression)) {
    if (!isRecord(value.workflowRegression.fixture)) errors.push("Workflow fixture reference 格式不合法");
    if (!Array.isArray(value.workflowRegression.cases)) errors.push("Workflow cases 必須是 array");
    if (!Array.isArray(value.workflowRegression.embeddedRunnerInputs)) {
      errors.push("embeddedRunnerInputs 必須是 array");
    }
  }
  if (isRecord(value.visualQuality)) {
    if (
      value.visualQuality.status !== "blocked_missing_real_outputs" &&
      value.visualQuality.status !== "candidate" &&
      value.visualQuality.status !== "approved"
    ) {
      errors.push("visualQuality.status 格式不合法");
    }
    if (!isRecord(value.visualQuality.reviewDocument)) errors.push("reviewDocument 格式不合法");
    if (
      value.visualQuality.reviewArtifacts !== undefined &&
      !Array.isArray(value.visualQuality.reviewArtifacts)
    ) {
      errors.push("reviewArtifacts 必須是 array");
    }
    if (!Array.isArray(value.visualQuality.availableInputs)) {
      errors.push("visualQuality.availableInputs 必須是 array");
    }
    if (!Array.isArray(value.visualQuality.cases)) errors.push("visualQuality.cases 必須是 array");
  }
  if (
    isRecord(value.productionMetricsReference) &&
    !Array.isArray(value.productionMetricsReference.reports)
  ) {
    errors.push("productionMetricsReference.reports 必須是 array");
  }
  return errors.length === 0 ? (value as unknown as BaselineManifest) : null;
}

function verifyApproval(manifest: BaselineManifest, errors: string[], warnings: string[]) {
  const approval = manifest.approval;
  if (manifest.status === "candidate") {
    if (
      approval.reviewer !== null ||
      approval.reviewedAt !== null ||
      approval.decision !== null ||
      approval.notes !== null
    ) {
      errors.push("candidate 不得預填人工 approval 欄位");
    }
    warnings.push("baseline 仍是 candidate，尚未經人工核准");
    return;
  }

  if (manifest.git.worktreeDirty) errors.push("worktree dirty 的 baseline 不得標為 approved");
  if (!approval.reviewer || !approval.reviewedAt || approval.decision !== "accept") {
    errors.push("approved baseline 必須有 reviewer、reviewedAt 與 accept decision");
  }
  if (manifest.visualQuality.status !== "approved" || manifest.visualQuality.cases.length === 0) {
    errors.push("approved baseline 必須包含至少一個已核准的真實視覺案例");
  }
  for (const visualCase of manifest.visualQuality.cases) {
    if (
      !visualCase.review.reviewer ||
      !visualCase.review.reviewedAt ||
      visualCase.review.decision !== "accept"
    ) {
      errors.push(`視覺案例 ${visualCase.caseId} 尚未獲得明確 Accept`);
    }
  }
}

async function verifyImageMetadata(
  absolutePath: string,
  reference: ImageReference,
  errors: string[],
) {
  try {
    const metadata = await sharp(absolutePath).metadata();
    const detectedMime = metadata.format ? `image/${metadata.format}` : null;
    if (detectedMime !== reference.mimeType) {
      errors.push(`${reference.path} MIME 不符：預期 ${reference.mimeType}，實際 ${detectedMime ?? "unknown"}`);
    }
    if (metadata.width !== reference.width || metadata.height !== reference.height) {
      errors.push(
        `${reference.path} 尺寸不符：預期 ${reference.width}x${reference.height}，實際 ${metadata.width ?? "?"}x${metadata.height ?? "?"}`,
      );
    }
  } catch {
    errors.push(`${reference.path} 無法讀取圖片 metadata`);
  }
}

async function verifyFileReference(
  repoRoot: string,
  reference: FileReference,
  errors: string[],
  imageReference?: ImageReference,
): Promise<boolean> {
  if (!isRecord(reference) || typeof reference.path !== "string" || !isSha256(reference.sha256)) {
    errors.push("檔案 reference 格式不合法");
    return false;
  }
  const absolutePath = resolveRepoFile(repoRoot, reference.path);
  if (!absolutePath) {
    errors.push(`不安全的 repo-relative path：${reference.path}`);
    return false;
  }
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    errors.push(`缺少檔案：${reference.path}`);
    return false;
  }
  const actualHash = sha256Buffer(readFileSync(absolutePath));
  if (actualHash !== reference.sha256) {
    errors.push(`${reference.path} SHA-256 不符`);
  }
  if (imageReference) await verifyImageMetadata(absolutePath, imageReference, errors);
  return true;
}

function verifyWorkflowCases(
  fixtureValue: unknown,
  manifest: BaselineManifest,
  errors: string[],
) {
  if (!isRecord(fixtureValue) || !Array.isArray(fixtureValue.cases)) {
    errors.push("Workflow fixture 格式不合法");
    return;
  }
  const definitions = fixtureValue.cases.filter(isRecord);
  if (definitions.length !== manifest.workflowRegression.fixture.caseCount) {
    errors.push("Workflow fixture caseCount 與 manifest 不一致");
  }
  const references = new Map(
    manifest.workflowRegression.cases.map((entry) => [entry.caseId, entry]),
  );
  if (references.size !== manifest.workflowRegression.cases.length) {
    errors.push("Workflow baseline 有重複 case ID");
  }
  if (references.size !== definitions.length) {
    errors.push("Workflow baseline 案例數與 fixture 不一致");
  }
  for (const definition of definitions) {
    const caseId = definition.id;
    if (typeof caseId !== "string") {
      errors.push("Workflow fixture 含無效 case ID");
      continue;
    }
    const reference = references.get(caseId);
    if (!reference) {
      errors.push(`Workflow baseline 缺少案例：${caseId}`);
      continue;
    }
    const expected = isRecord(definition.expected) ? definition.expected : null;
    if (canonicalSha256(definition) !== reference.definitionSha256) {
      errors.push(`Workflow case ${caseId} definition hash 不符`);
    }
    if (canonicalSha256(expected?.results) !== reference.expectedOutputSha256) {
      errors.push(`Workflow case ${caseId} expected output hash 不符`);
    }
    if (canonicalSha256(expected?.trace) !== reference.traceSha256) {
      errors.push(`Workflow case ${caseId} trace hash 不符`);
    }
  }
}

function verifyEmbeddedInputs(manifest: BaselineManifest, errors: string[]) {
  for (const input of manifest.workflowRegression.embeddedRunnerInputs) {
    if (input.encoding !== "utf8" || sha256Buffer(input.identifier) !== input.sha256) {
      errors.push(`runner embedded input hash 不符：${input.identifier}`);
    }
  }
}

export async function verifyTryOnBaseline(options: {
  repoRoot: string;
  manifestPath: string;
  requireApproved?: boolean;
}): Promise<BaselineVerificationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let checkedFiles = 0;
  const absoluteManifestPath = resolve(options.manifestPath);
  const baseResult = {
    baselineId: null,
    status: null,
    errors,
    warnings,
    checkedFiles,
    checkedWorkflowCases: 0,
    checkedVisualCases: 0,
  } satisfies BaselineVerificationResult;

  if (!existsSync(absoluteManifestPath)) {
    errors.push(`找不到 manifest：${absoluteManifestPath}`);
    return baseResult;
  }
  const manifestBytes = readFileSync(absoluteManifestPath);
  const sealPath = resolve(dirname(absoluteManifestPath), "manifest.sha256");
  if (!existsSync(sealPath)) {
    errors.push("缺少 manifest.sha256 seal");
  } else {
    const seal = readFileSync(sealPath, "utf8").trim().match(/^([a-f0-9]{64})  manifest\.json$/u);
    if (!seal || seal[1] !== sha256Buffer(manifestBytes)) errors.push("manifest.sha256 seal 不符");
    checkedFiles += 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    errors.push("manifest 不是合法 JSON");
    return { ...baseResult, checkedFiles };
  }
  const manifest = parseManifest(parsed, errors);
  if (!manifest) return { ...baseResult, checkedFiles };

  verifyApproval(manifest, errors, warnings);
  if (options.requireApproved && manifest.status !== "approved") {
    errors.push("目前 baseline 不是 approved");
  }

  const fixture = manifest.workflowRegression.fixture;
  if (await verifyFileReference(options.repoRoot, fixture, errors)) checkedFiles += 1;
  const fixturePath = resolveRepoFile(options.repoRoot, fixture.path);
  if (fixturePath && existsSync(fixturePath)) {
    try {
      verifyWorkflowCases(JSON.parse(readFileSync(fixturePath, "utf8")), manifest, errors);
    } catch {
      errors.push("Workflow fixture 不是合法 JSON");
    }
  }
  verifyEmbeddedInputs(manifest, errors);

  for (const report of manifest.productionMetricsReference.reports) {
    if (await verifyFileReference(options.repoRoot, report, errors)) checkedFiles += 1;
  }
  if (
    await verifyFileReference(
      options.repoRoot,
      manifest.visualQuality.reviewDocument,
      errors,
    )
  ) {
    checkedFiles += 1;
  }
  for (const artifact of manifest.visualQuality.reviewArtifacts ?? []) {
    if (await verifyFileReference(options.repoRoot, artifact, errors)) checkedFiles += 1;
  }
  for (const input of manifest.visualQuality.availableInputs) {
    if (await verifyFileReference(options.repoRoot, input, errors, input)) checkedFiles += 1;
  }
  const visualIds = new Set<string>();
  for (const visualCase of manifest.visualQuality.cases) {
    if (visualIds.has(visualCase.caseId)) errors.push(`重複的視覺案例 ID：${visualCase.caseId}`);
    visualIds.add(visualCase.caseId);
    for (const input of visualCase.inputs) {
      if (await verifyFileReference(options.repoRoot, input, errors, input)) checkedFiles += 1;
    }
    if (await verifyFileReference(options.repoRoot, visualCase.output, errors, visualCase.output)) {
      checkedFiles += 1;
    }
  }

  return {
    baselineId: manifest.baselineId,
    status: manifest.status,
    errors,
    warnings,
    checkedFiles,
    checkedWorkflowCases: manifest.workflowRegression.cases.length,
    checkedVisualCases: manifest.visualQuality.cases.length,
  };
}
