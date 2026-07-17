import type { JobStatus, TryOnErrorType } from "../types";

export const REPORT_SCHEMA_VERSION = 1;
export const PERSON_BUCKET = "person-uploads";
export const RESULT_BUCKET = "try-on-results";
export const NON_TERMINAL_TIMEOUT_MS = 120 * 60 * 1000;

export interface ReportJobRow {
  provider: string;
  status: JobStatus;
  cost_estimate: number;
  budget_reservation: number;
  config_snapshot: unknown;
  seed: number | null;
  started_at: string | null;
  provider_submitted_at: string | null;
  completed_at: string | null;
  last_polled_at: string | null;
  error_type: TryOnErrorType | null;
  error_code: string | null;
  provider_http_status: number | null;
  idempotency_key: string | null;
  created_at: string;
  person_image_url: string | null;
  result_image_url: string | null;
}

export interface ReportStorageObject {
  bucketId: string;
  name: string;
  sizeBytes: number | null;
}

export interface RelationMetric {
  name: string;
  rowCount: number | null;
  tableBytes: number | null;
  indexBytes: number | null;
  totalBytes: number | null;
}

export interface ReportAvailability {
  jobs: boolean;
  storage: boolean;
  relationCounts: boolean;
  relationSizes: boolean;
  databaseSize: boolean;
  requestEvents: false;
  actualProviderCost: false;
}

export interface DeterministicCaseSummary {
  total: number;
  passed: number;
  failed: number;
}

export interface BaselineReportInput {
  generatedAt: string;
  from: string;
  to: string;
  source: "postgres" | "supabase-api" | "supabase-api+readonly-sql" | "unavailable";
  availability: ReportAvailability;
  unavailableReasons: string[];
  jobs: ReportJobRow[] | null;
  storageObjects: ReportStorageObject[] | null;
  relations: RelationMetric[];
  databaseSizeBytes: number | null;
  deterministicCases: DeterministicCaseSummary;
}

export interface CountRate {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface StatusCounts {
  pending: number;
  processing: number;
  success: number;
  failed: number;
}

export interface StatusGroup extends StatusCounts {
  key: string;
  created: number;
  terminal: number;
  terminalSuccessRate: number | null;
}

export interface SuccessMetrics {
  created: number;
  statuses: StatusCounts;
  terminal: number;
  terminalSuccessRate: number | null;
  endToEndSuccessRate: number | null;
  completionRate: number | null;
  nonTerminalAge: {
    under5Minutes: number;
    from5To15Minutes: number;
    from15To120Minutes: number;
    atLeast120Minutes: number;
    invalidOrFutureTimestamp: number;
    timeoutCandidates: number;
  };
  byProvider: StatusGroup[];
  byUtcDay: StatusGroup[];
  byConfigSchemaVersion: StatusGroup[];
}

export interface ErrorGroup {
  errorType: string;
  errorCode: string;
  providerHttpStatus: number | null;
  provider: string;
  status: JobStatus;
  count: number;
  shareOfFailedJobs: number | null;
}

export interface LatencyStats {
  candidateCount: number;
  validSampleCount: number;
  excludedCount: number;
  minMs: number | null;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface LatencyGroup {
  provider: string;
  status: JobStatus | "all";
  submission: LatencyStats;
  postSubmitTerminal: LatencyStats;
  totalTerminal: LatencyStats;
}

export interface CostGroup {
  key: string;
  jobs: number;
  recordedCostEstimate: number;
  budgetReservation: number;
}

export interface CostMetrics {
  recordedCostEstimate: number;
  budgetReservation: number;
  averagePerCreatedJob: number | null;
  averageSuccessfulJobEstimate: number | null;
  estimatedCostPerSuccessfulResult: number | null;
  actualProviderCost: null;
  byProvider: CostGroup[];
  byStatus: CostGroup[];
  byUtcDay: CostGroup[];
  byProviderClass: CostGroup[];
}

export interface StorageBucketMetrics {
  bucketId: string;
  objectCount: number;
  totalKnownBytes: number;
  averageKnownObjectBytes: number | null;
  missingSizeMetadataCount: number;
  formalJpgCount: number;
  rawUploadOrTombstoneCount: number;
  otherObjectCount: number;
  referencedObjectCount: number;
  referencedKnownBytes: number;
  unreferencedCandidateCount: number;
  unreferencedCandidateKnownBytes: number;
  missingReferencedObjectCount: number;
}

export interface FieldCoverage {
  field: string;
  present: number;
  total: number;
  rate: number | null;
}

export interface DatabaseMetrics {
  overallSizeBytes: number | null;
  relations: RelationMetric[];
  allTimeJobCount: number;
  allTimeStatuses: StatusCounts;
  legacyJobCount: number;
  lifecycleFieldCoverage: FieldCoverage[];
  structuredErrorCoverage: CountRate;
  configSnapshotCoverage: CountRate;
  seedCoverage: CountRate;
  idempotencyUsage: CountRate;
}

export interface BaselineReport {
  schemaVersion: 1;
  generatedAt: string;
  window: {
    fromUtc: string;
    toUtc: string;
    fromTaipei: string;
    toTaipei: string;
    interval: "[from, to)";
  };
  source: BaselineReportInput["source"];
  availability: ReportAvailability;
  unavailableReasons: string[];
  coverage: {
    windowJobCount: number | null;
    allTimeJobCount: number | null;
    excludedFromWindow: number | null;
  };
  success: SuccessMetrics | null;
  errors: ErrorGroup[] | null;
  latency: LatencyGroup[] | null;
  cost: CostMetrics | null;
  storage: StorageBucketMetrics[] | null;
  database: DatabaseMetrics | null;
  deterministicRegressionCases: DeterministicCaseSummary;
  limitations: string[];
  recommendedNextActions: string[];
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

export function canonicalReportJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusCounts(jobs: ReportJobRow[]): StatusCounts {
  const counts: StatusCounts = { pending: 0, processing: 0, success: 0, failed: 0 };
  for (const job of jobs) counts[job.status] += 1;
  return counts;
}

function snapshotSchemaVersion(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== "object") return "legacy";
  const value = (snapshot as Record<string, unknown>).schemaVersion;
  return value === undefined || value === null ? "legacy" : String(value);
}

function groupStatuses(
  jobs: ReportJobRow[],
  keyFor: (job: ReportJobRow) => string,
): StatusGroup[] {
  const grouped = new Map<string, ReportJobRow[]>();
  for (const job of jobs) {
    const key = keyFor(job);
    grouped.set(key, [...(grouped.get(key) ?? []), job]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entries]) => {
      const statuses = statusCounts(entries);
      const terminal = statuses.success + statuses.failed;
      return {
        key,
        created: entries.length,
        ...statuses,
        terminal,
        terminalSuccessRate: rate(statuses.success, terminal),
      };
    });
}

function buildSuccess(jobs: ReportJobRow[], generatedAt: string): SuccessMetrics {
  const statuses = statusCounts(jobs);
  const terminal = statuses.success + statuses.failed;
  const age = {
    under5Minutes: 0,
    from5To15Minutes: 0,
    from15To120Minutes: 0,
    atLeast120Minutes: 0,
    invalidOrFutureTimestamp: 0,
    timeoutCandidates: 0,
  };
  const generatedAtMs = Date.parse(generatedAt);
  for (const job of jobs.filter((entry) => entry.status === "pending" || entry.status === "processing")) {
    const start = parseTime(job.started_at) ?? parseTime(job.created_at);
    const duration = start === null ? Number.NaN : generatedAtMs - start;
    if (!Number.isFinite(duration) || duration < 0) age.invalidOrFutureTimestamp += 1;
    else if (duration < 5 * 60 * 1000) age.under5Minutes += 1;
    else if (duration < 15 * 60 * 1000) age.from5To15Minutes += 1;
    else if (duration < NON_TERMINAL_TIMEOUT_MS) age.from15To120Minutes += 1;
    else {
      age.atLeast120Minutes += 1;
      age.timeoutCandidates += 1;
    }
  }
  return {
    created: jobs.length,
    statuses,
    terminal,
    terminalSuccessRate: rate(statuses.success, terminal),
    endToEndSuccessRate: rate(statuses.success, jobs.length),
    completionRate: rate(terminal, jobs.length),
    nonTerminalAge: age,
    byProvider: groupStatuses(jobs, (job) => job.provider),
    byUtcDay: groupStatuses(jobs, (job) => job.created_at.slice(0, 10)),
    byConfigSchemaVersion: groupStatuses(jobs, (job) => snapshotSchemaVersion(job.config_snapshot)),
  };
}

function buildErrors(jobs: ReportJobRow[]): ErrorGroup[] {
  const failedCount = jobs.filter((job) => job.status === "failed").length;
  const groups = new Map<string, Omit<ErrorGroup, "count" | "shareOfFailedJobs"> & { count: number }>();
  for (const job of jobs.filter((entry) => entry.status === "failed")) {
    const entry = {
      errorType: job.error_type ?? "unclassified",
      errorCode: job.error_code ?? "unclassified",
      providerHttpStatus: job.provider_http_status,
      provider: job.provider,
      status: job.status,
    };
    const key = JSON.stringify(entry);
    const existing = groups.get(key);
    groups.set(key, { ...entry, count: (existing?.count ?? 0) + 1 });
  }
  return [...groups.values()]
    .map((entry) => ({ ...entry, shareOfFailedJobs: rate(entry.count, failedCount) }))
    .sort((left, right) => right.count - left.count || JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  if (quantile < 0 || quantile > 1) throw new Error("quantile 必須介於 0 與 1");
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function latencyStats(candidates: Array<[string | null, string | null]>): LatencyStats {
  const values: number[] = [];
  for (const [startValue, endValue] of candidates) {
    const start = parseTime(startValue);
    const end = parseTime(endValue);
    if (start !== null && end !== null && end >= start) values.push(end - start);
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    candidateCount: candidates.length,
    validSampleCount: values.length,
    excludedCount: candidates.length - values.length,
    minMs: values.length ? Math.min(...values) : null,
    averageMs: values.length ? round(sum / values.length, 3) : null,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

function latencyGroup(jobs: ReportJobRow[], provider: string, status: JobStatus | "all"): LatencyGroup {
  const terminal = jobs.filter((job) => job.status === "success" || job.status === "failed");
  return {
    provider,
    status,
    submission: latencyStats(jobs.map((job) => [job.started_at, job.provider_submitted_at])),
    postSubmitTerminal: latencyStats(
      terminal.map((job) => [job.provider_submitted_at, job.completed_at]),
    ),
    totalTerminal: latencyStats(terminal.map((job) => [job.started_at, job.completed_at])),
  };
}

function buildLatency(jobs: ReportJobRow[]): LatencyGroup[] {
  const groups: LatencyGroup[] = [latencyGroup(jobs, "all", "all")];
  const providers = [...new Set(jobs.map((job) => job.provider))].sort();
  for (const provider of providers) {
    const providerJobs = jobs.filter((job) => job.provider === provider);
    groups.push(latencyGroup(providerJobs, provider, "all"));
    for (const status of ["pending", "processing", "success", "failed"] as const) {
      const entries = providerJobs.filter((job) => job.status === status);
      if (entries.length) groups.push(latencyGroup(entries, provider, status));
    }
  }
  return groups;
}

function costGroup(jobs: ReportJobRow[], key: string): CostGroup {
  return {
    key,
    jobs: jobs.length,
    recordedCostEstimate: round(jobs.reduce((sum, job) => sum + (finiteNumber(job.cost_estimate) ?? 0), 0)),
    budgetReservation: round(jobs.reduce((sum, job) => sum + (finiteNumber(job.budget_reservation) ?? 0), 0)),
  };
}

function groupCosts(jobs: ReportJobRow[], keyFor: (job: ReportJobRow) => string): CostGroup[] {
  const grouped = new Map<string, ReportJobRow[]>();
  for (const job of jobs) {
    const key = keyFor(job);
    grouped.set(key, [...(grouped.get(key) ?? []), job]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entries]) => costGroup(entries, key));
}

function buildCost(jobs: ReportJobRow[]): CostMetrics {
  const total = costGroup(jobs, "all");
  const successes = jobs.filter((job) => job.status === "success");
  const successfulCost = successes.reduce((sum, job) => sum + (finiteNumber(job.cost_estimate) ?? 0), 0);
  return {
    recordedCostEstimate: total.recordedCostEstimate,
    budgetReservation: total.budgetReservation,
    averagePerCreatedJob: jobs.length ? round(total.recordedCostEstimate / jobs.length) : null,
    averageSuccessfulJobEstimate: successes.length ? round(successfulCost / successes.length) : null,
    estimatedCostPerSuccessfulResult: successes.length
      ? round(total.recordedCostEstimate / successes.length)
      : null,
    actualProviderCost: null,
    byProvider: groupCosts(jobs, (job) => job.provider),
    byStatus: groupCosts(jobs, (job) => job.status),
    byUtcDay: groupCosts(jobs, (job) => job.created_at.slice(0, 10)),
    byProviderClass: groupCosts(jobs, (job) => (job.provider === "mock" ? "mock" : "paid-provider")),
  };
}

function objectSize(object: ReportStorageObject): number {
  return object.sizeBytes ?? 0;
}

function buildStorage(jobs: ReportJobRow[], objects: ReportStorageObject[]): StorageBucketMetrics[] {
  const references = new Map<string, Set<string>>([
    [PERSON_BUCKET, new Set(jobs.flatMap((job) => job.person_image_url ? [job.person_image_url] : []))],
    [RESULT_BUCKET, new Set(jobs.flatMap((job) => job.result_image_url ? [job.result_image_url] : []))],
  ]);
  return [PERSON_BUCKET, RESULT_BUCKET].map((bucketId) => {
    const bucketObjects = objects.filter((object) => object.bucketId === bucketId);
    const names = new Set(bucketObjects.map((object) => object.name));
    const refs = references.get(bucketId) ?? new Set<string>();
    const referenced = bucketObjects.filter((object) => refs.has(object.name));
    const candidates = bucketObjects.filter((object) => {
      if (refs.has(object.name)) return false;
      if (bucketId === PERSON_BUCKET) return object.name.endsWith(".jpg");
      return true;
    });
    const known = bucketObjects.filter((object) => object.sizeBytes !== null);
    return {
      bucketId,
      objectCount: bucketObjects.length,
      totalKnownBytes: bucketObjects.reduce((sum, object) => sum + objectSize(object), 0),
      averageKnownObjectBytes: known.length
        ? round(known.reduce((sum, object) => sum + objectSize(object), 0) / known.length, 3)
        : null,
      missingSizeMetadataCount: bucketObjects.length - known.length,
      formalJpgCount: bucketObjects.filter((object) => object.name.endsWith(".jpg")).length,
      rawUploadOrTombstoneCount: bucketObjects.filter((object) => object.name.endsWith(".upload")).length,
      otherObjectCount: bucketObjects.filter(
        (object) => !object.name.endsWith(".jpg") && !object.name.endsWith(".upload"),
      ).length,
      referencedObjectCount: referenced.length,
      referencedKnownBytes: referenced.reduce((sum, object) => sum + objectSize(object), 0),
      unreferencedCandidateCount: candidates.length,
      unreferencedCandidateKnownBytes: candidates.reduce((sum, object) => sum + objectSize(object), 0),
      missingReferencedObjectCount: [...refs].filter((name) => !names.has(name)).length,
    };
  });
}

function coverage(field: string, jobs: ReportJobRow[], present: (job: ReportJobRow) => boolean): FieldCoverage {
  const count = jobs.filter(present).length;
  return { field, present: count, total: jobs.length, rate: rate(count, jobs.length) };
}

function buildDatabase(
  jobs: ReportJobRow[],
  relations: RelationMetric[],
  databaseSizeBytes: number | null,
): DatabaseMetrics {
  const failed = jobs.filter((job) => job.status === "failed");
  const structured = failed.filter((job) => job.error_type && job.error_code).length;
  const configRows = jobs.filter((job) => snapshotSchemaVersion(job.config_snapshot) !== "legacy").length;
  const seedRows = jobs.filter((job) => job.seed !== null).length;
  const idempotentRows = jobs.filter((job) => job.idempotency_key !== null).length;
  return {
    overallSizeBytes: databaseSizeBytes,
    relations: [...relations].sort((left, right) => left.name.localeCompare(right.name)),
    allTimeJobCount: jobs.length,
    allTimeStatuses: statusCounts(jobs),
    legacyJobCount: jobs.length - configRows,
    lifecycleFieldCoverage: [
      coverage("started_at", jobs, (job) => job.started_at !== null),
      coverage("provider_submitted_at", jobs, (job) => job.provider_submitted_at !== null),
      coverage("completed_at", jobs, (job) => job.completed_at !== null),
      coverage("last_polled_at", jobs, (job) => job.last_polled_at !== null),
    ],
    structuredErrorCoverage: { numerator: structured, denominator: failed.length, rate: rate(structured, failed.length) },
    configSnapshotCoverage: { numerator: configRows, denominator: jobs.length, rate: rate(configRows, jobs.length) },
    seedCoverage: { numerator: seedRows, denominator: jobs.length, rate: rate(seedRows, jobs.length) },
    idempotencyUsage: { numerator: idempotentRows, denominator: jobs.length, rate: rate(idempotentRows, jobs.length) },
  };
}

function taipeiTime(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso)).replace(" ", "T") + "+08:00";
}

function buildRecommendations(report: Omit<BaselineReport, "recommendedNextActions">): string[] {
  const actions: string[] = [];
  if (!report.availability.jobs) actions.push("補上可讀取營運資料的 Supabase 設定後重跑報表。");
  else if (report.success?.created === 0) actions.push("目前區間沒有 job；累積實際流量後再判斷成功率與延遲。");
  if ((report.success?.nonTerminalAge.timeoutCandidates ?? 0) > 0) {
    actions.push("檢查超過 120 分鐘仍未終止的 job 與輪詢／終態寫入流程。");
  }
  if (report.success?.terminalSuccessRate !== null && report.success && report.success.terminalSuccessRate < 0.9) {
    const classifiedErrors = report.errors?.some((entry) => entry.errorType !== "unclassified");
    actions.push(classifiedErrors
      ? "依錯誤分布優先調查 terminal success rate 低於 90% 的主要失敗類型。"
      : "Terminal success rate 低於 90%，但失敗尚未分類；先確認新版 structured error 寫入後再定位原因。");
  }
  const totalP95 = report.latency?.[0]?.totalTerminal.p95Ms;
  if (totalP95 !== null && totalP95 !== undefined && totalP95 > NON_TERMINAL_TIMEOUT_MS) {
    actions.push("總延遲 P95 超過前端 120 分鐘候選門檻，需先拆解輪詢與後處理耗時。");
  }
  if (report.storage?.some((bucket) => bucket.unreferencedCandidateCount > 0 || bucket.missingReferencedObjectCount > 0)) {
    actions.push("人工複核 Storage 未引用／缺失候選；本報表不會自動刪除任何物件。");
  }
  if (report.database && report.database.configSnapshotCoverage.rate !== null && report.database.configSnapshotCoverage.rate < 1) {
    actions.push("確認 reproducibility migration 已部署，並用新建 job 驗證 config snapshot、seed、生命週期時間與結構化錯誤開始寫入。");
  }
  if (!report.availability.relationSizes || !report.availability.databaseSize) {
    actions.push("設定唯讀 DB_URL 後補齊 relation size 與 database size；目前 API fallback 無法取得實體容量。");
  }
  if (!report.availability.requestEvents) {
    actions.push("若要涵蓋建 job 前的驗證、授權與 quota 拒絕，需另設 request-level event／log 指標。");
  }
  return [...new Set(actions)];
}

export function buildBaselineReport(input: BaselineReportInput): BaselineReport {
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  const generatedMs = Date.parse(input.generatedAt);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new Error("報表區間必須是合法且 from 早於 to 的 ISO 時間");
  }
  if (!Number.isFinite(generatedMs)) throw new Error("generatedAt 必須是合法 ISO 時間");

  const allJobs = input.jobs;
  const windowJobs = allJobs?.filter((job) => {
    const created = Date.parse(job.created_at);
    return Number.isFinite(created) && created >= fromMs && created < toMs;
  }) ?? null;
  const success = windowJobs ? buildSuccess(windowJobs, input.generatedAt) : null;
  const database = allJobs
    ? buildDatabase(allJobs, input.relations, input.databaseSizeBytes)
    : null;
  const reportWithoutRecommendations: Omit<BaselineReport, "recommendedNextActions"> = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    window: {
      fromUtc: new Date(fromMs).toISOString(),
      toUtc: new Date(toMs).toISOString(),
      fromTaipei: taipeiTime(new Date(fromMs).toISOString()),
      toTaipei: taipeiTime(new Date(toMs).toISOString()),
      interval: "[from, to)",
    },
    source: input.source,
    availability: input.availability,
    unavailableReasons: [...input.unavailableReasons].sort(),
    coverage: {
      windowJobCount: windowJobs?.length ?? null,
      allTimeJobCount: allJobs?.length ?? null,
      excludedFromWindow: allJobs && windowJobs ? allJobs.length - windowJobs.length : null,
    },
    success,
    errors: windowJobs ? buildErrors(windowJobs) : null,
    latency: windowJobs ? buildLatency(windowJobs) : null,
    cost: windowJobs ? buildCost(windowJobs) : null,
    storage: allJobs && input.storageObjects ? buildStorage(allJobs, input.storageObjects) : null,
    database,
    deterministicRegressionCases: input.deterministicCases,
    limitations: [
      "固定案例只代表離線 Workflow 回歸結果，不是 production 成功率、延遲或成本。",
      "post-submit terminal latency 包含輪詢間隔、結果下載、enhancement 與 Storage 寫入，不是純 provider execution time。",
      "cost_estimate 與 budget_reservation 是程式記錄的估算／預留，不是 provider 實際帳單；pre-submit failure 也可能已有估算值。",
      "try_on_jobs 不涵蓋建 job 前的 authentication、input validation、product lookup 或 quota rejection。",
      "Storage 未引用與缺失數字只是 aggregate 候選；.upload 是 raw upload／tombstone，沒有被當作 orphan。",
    ],
  };
  return {
    ...reportWithoutRecommendations,
    recommendedNextActions: buildRecommendations(reportWithoutRecommendations),
  };
}

function percent(value: number | null): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(2)}%`;
}

function money(value: number | null): string {
  return value === null ? "N/A" : `USD ${value.toFixed(4)}`;
}

export function humanBytes(value: number | null): string {
  if (value === null) return "N/A";
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let current = value;
  let index = -1;
  do {
    current /= 1024;
    index += 1;
  } while (current >= 1024 && index < units.length - 1);
  return `${current.toFixed(2)} ${units[index]}`;
}

function duration(value: number | null): string {
  if (value === null) return "N/A";
  if (value < 1000) return `${value.toFixed(0)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function markdownTable(headers: string[], rows: Array<Array<string | number>>): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

export function renderBaselineMarkdown(report: BaselineReport): string {
  const success = report.success;
  const totalLatency = report.latency?.[0]?.totalTerminal ?? null;
  const storageBytes = report.storage?.reduce((sum, bucket) => sum + bucket.totalKnownBytes, 0) ?? null;
  const lines = [
    "# Try-On Baseline Report",
    "",
    "## Executive summary",
    "",
    `- 資料區間：${report.window.fromUtc} 至 ${report.window.toUtc}（${report.window.interval}，UTC）`,
    `- 資料來源：${report.source}`,
    `- Jobs：${success?.created ?? "N/A"}；terminal success rate：${percent(success?.terminalSuccessRate ?? null)}`,
    `- Total terminal latency P95：${duration(totalLatency?.p95Ms ?? null)}`,
    `- Recorded cost estimate：${money(report.cost?.recordedCostEstimate ?? null)}；actual provider cost：N/A`,
    `- Storage 已知容量：${humanBytes(storageBytes)}`,
    `- Database size：${humanBytes(report.database?.overallSizeBytes ?? null)}`,
    "",
    "## Coverage／資料品質",
    "",
    `- 產生時間：${report.generatedAt}`,
    `- 台北區間：${report.window.fromTaipei} 至 ${report.window.toTaipei}`,
    `- Window jobs：${report.coverage.windowJobCount ?? "N/A"}；all-time jobs：${report.coverage.allTimeJobCount ?? "N/A"}`,
  ];
  if (report.unavailableReasons.length) {
    lines.push("", "Unavailable：", "", ...report.unavailableReasons.map((reason) => `- ${reason}`));
  }
  lines.push("", "## Success", "");
  if (!success) lines.push("N/A：job 資料不可用。");
  else {
    lines.push(markdownTable(
      ["Created", "Pending", "Processing", "Success", "Failed", "Terminal success", "End-to-end success", "Completion"],
      [[success.created, success.statuses.pending, success.statuses.processing, success.statuses.success, success.statuses.failed, percent(success.terminalSuccessRate), percent(success.endToEndSuccessRate), percent(success.completionRate)]],
    ));
    lines.push("", `超過 120 分鐘未終止候選：${success.nonTerminalAge.timeoutCandidates}`);
    if (success.byProvider.length) {
      lines.push("", "依 provider：", "", markdownTable(
        ["Provider", "Created", "Success", "Failed", "Pending", "Processing", "Terminal success"],
        success.byProvider.map((group) => [group.key, group.created, group.success, group.failed, group.pending, group.processing, percent(group.terminalSuccessRate)]),
      ));
    }
    if (success.byUtcDay.length) {
      lines.push("", "依 UTC 日期：", "", markdownTable(
        ["UTC day", "Created", "Success", "Failed", "Pending", "Processing", "Terminal success"],
        success.byUtcDay.map((group) => [group.key, group.created, group.success, group.failed, group.pending, group.processing, percent(group.terminalSuccessRate)]),
      ));
    }
    if (success.byConfigSchemaVersion.length) {
      lines.push("", "依 config snapshot schema version：", "", markdownTable(
        ["Schema version", "Created", "Success", "Failed", "Pending", "Processing", "Terminal success"],
        success.byConfigSchemaVersion.map((group) => [group.key, group.created, group.success, group.failed, group.pending, group.processing, percent(group.terminalSuccessRate)]),
      ));
    }
  }
  lines.push("", "## Errors", "");
  if (report.errors === null) lines.push("N/A：job 資料不可用。");
  else if (report.errors.length === 0) lines.push("此區間沒有 failed job。");
  else lines.push(markdownTable(
    ["Type", "Code", "HTTP", "Provider", "Count", "Share of failed"],
    report.errors.map((entry) => [entry.errorType, entry.errorCode, entry.providerHttpStatus ?? "N/A", entry.provider, entry.count, percent(entry.shareOfFailedJobs)]),
  ));
  lines.push("", "建 job 前的驗證、授權、商品查詢與 quota 拒絕沒有 request-level event，因此不在此表內，不能視為 0。", "", "## Latency", "");
  if (report.latency === null) lines.push("N/A：job 資料不可用。");
  else lines.push(markdownTable(
    ["Provider", "Status", "Metric", "Valid", "Excluded", "Min", "Avg", "P50", "P95", "Max"],
    report.latency.flatMap((group) => [
      [group.provider, group.status, "submission", group.submission.validSampleCount, group.submission.excludedCount, duration(group.submission.minMs), duration(group.submission.averageMs), duration(group.submission.p50Ms), duration(group.submission.p95Ms), duration(group.submission.maxMs)],
      [group.provider, group.status, "post-submit terminal", group.postSubmitTerminal.validSampleCount, group.postSubmitTerminal.excludedCount, duration(group.postSubmitTerminal.minMs), duration(group.postSubmitTerminal.averageMs), duration(group.postSubmitTerminal.p50Ms), duration(group.postSubmitTerminal.p95Ms), duration(group.postSubmitTerminal.maxMs)],
      [group.provider, group.status, "total terminal", group.totalTerminal.validSampleCount, group.totalTerminal.excludedCount, duration(group.totalTerminal.minMs), duration(group.totalTerminal.averageMs), duration(group.totalTerminal.p50Ms), duration(group.totalTerminal.p95Ms), duration(group.totalTerminal.maxMs)],
    ]),
  ));
  lines.push("", "post-submit terminal latency 包含輪詢、下載、enhancement 與 Storage 寫入，不是純 provider 執行時間。", "", "## Cost", "");
  if (!report.cost) lines.push("N/A：job 資料不可用。");
  else {
    lines.push(
      `- Recorded cost estimate：${money(report.cost.recordedCostEstimate)}`,
      `- Budget reservation：${money(report.cost.budgetReservation)}`,
      `- Average per created job：${money(report.cost.averagePerCreatedJob)}`,
      `- Average successful-job estimate：${money(report.cost.averageSuccessfulJobEstimate)}`,
      `- Estimated cost per successful result（含失敗估算）：${money(report.cost.estimatedCostPerSuccessfulResult)}`,
      "- Actual provider cost：N/A（沒有 billing data）",
      "",
      markdownTable(
        ["Provider", "Jobs", "Recorded estimate", "Reservation"],
        report.cost.byProvider.map((group) => [group.key, group.jobs, money(group.recordedCostEstimate), money(group.budgetReservation)]),
      ),
      "",
      "依 status：",
      "",
      markdownTable(
        ["Status", "Jobs", "Recorded estimate", "Reservation"],
        report.cost.byStatus.map((group) => [group.key, group.jobs, money(group.recordedCostEstimate), money(group.budgetReservation)]),
      ),
      "",
      "依 UTC 日期：",
      "",
      markdownTable(
        ["UTC day", "Jobs", "Recorded estimate", "Reservation"],
        report.cost.byUtcDay.map((group) => [group.key, group.jobs, money(group.recordedCostEstimate), money(group.budgetReservation)]),
      ),
      "",
      "Mock／付費 provider：",
      "",
      markdownTable(
        ["Provider class", "Jobs", "Recorded estimate", "Reservation"],
        report.cost.byProviderClass.map((group) => [group.key, group.jobs, money(group.recordedCostEstimate), money(group.budgetReservation)]),
      ),
    );
  }
  lines.push("", "## Storage", "");
  if (!report.storage) lines.push("N/A：Storage metadata 不可用。");
  else lines.push(markdownTable(
    ["Bucket", "Objects", "Known bytes", "Avg", ".jpg", ".upload", "Referenced", "Unreferenced candidates", "Missing refs", "Missing size"],
    report.storage.map((bucket) => [bucket.bucketId, bucket.objectCount, humanBytes(bucket.totalKnownBytes), humanBytes(bucket.averageKnownObjectBytes), bucket.formalJpgCount, bucket.rawUploadOrTombstoneCount, bucket.referencedObjectCount, bucket.unreferencedCandidateCount, bucket.missingReferencedObjectCount, bucket.missingSizeMetadataCount]),
  ));
  lines.push("", ".upload 為 raw upload／tombstone，已獨立統計且不視為 orphan；候選只供人工複核，不會自動刪除。", "", "## Database", "");
  if (!report.database) lines.push("N/A：job／DB 資料不可用。");
  else {
    lines.push(
      `- Overall database size：${humanBytes(report.database.overallSizeBytes)}`,
      `- All-time jobs：${report.database.allTimeJobCount}；legacy jobs：${report.database.legacyJobCount}`,
      `- Structured error coverage：${percent(report.database.structuredErrorCoverage.rate)}`,
      `- Config snapshot coverage：${percent(report.database.configSnapshotCoverage.rate)}`,
      `- Seed coverage：${percent(report.database.seedCoverage.rate)}`,
      `- Idempotency usage：${percent(report.database.idempotencyUsage.rate)}`,
      "",
      "Lifecycle field coverage：",
      "",
      markdownTable(
        ["Field", "Present", "Total", "Coverage"],
        report.database.lifecycleFieldCoverage.map((entry) => [entry.field, entry.present, entry.total, percent(entry.rate)]),
      ),
      "",
      markdownTable(
        ["Relation", "Rows", "Table", "Indexes", "Total"],
        report.database.relations.map((relation) => [relation.name, relation.rowCount ?? "N/A", humanBytes(relation.tableBytes), humanBytes(relation.indexBytes), humanBytes(relation.totalBytes)]),
      ),
    );
  }
  lines.push(
    "",
    "## Deterministic regression cases",
    "",
    `離線固定案例：${report.deterministicRegressionCases.passed}/${report.deterministicRegressionCases.total} passed，${report.deterministicRegressionCases.failed} failed。這是 Workflow regression 結果，不是 production 指標。`,
    "",
    "## Limitations",
    "",
    ...report.limitations.map((entry) => `- ${entry}`),
    "",
    "## Recommended next actions",
    "",
    ...(report.recommendedNextActions.length ? report.recommendedNextActions.map((entry) => `- ${entry}`) : ["- 目前沒有由數據支持的立即改善項目；持續累積樣本後重跑。"]),
    "",
  );
  return lines.join("\n");
}
