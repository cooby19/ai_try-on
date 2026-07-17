import { createRequire } from "node:module";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  BaselineReportInput,
  RelationMetric,
  ReportAvailability,
  ReportJobRow,
  ReportStorageObject,
} from "./reporting";
import { PERSON_BUCKET, RESULT_BUCKET } from "./reporting";

const PAGE_SIZE = 1_000;
const STATEMENT_TIMEOUT_MS = 15_000;
const REPORT_RELATIONS = [
  "users",
  "products",
  "try_on_jobs",
  "try_on_feedback",
  "product_variants",
  "orders",
  "order_items",
] as const;
const EXACT_RELATION_COUNTS_SQL = REPORT_RELATIONS
  .map((name) => `select '${name}'::text as relname, count(*)::bigint as row_count from public.${name}`)
  .join(" union all ");

export type ReportSourcePreference = "auto" | "postgres" | "supabase";

export interface ReportSourceEnvironment {
  DB_URL?: string;
  SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export interface DatabaseMetricsOverlay {
  databaseSizeBytes: number;
  relations: Array<Pick<RelationMetric, "name" | "tableBytes" | "indexBytes" | "totalBytes">>;
}

export type LoadedReportData = Pick<
  BaselineReportInput,
  | "source"
  | "availability"
  | "unavailableReasons"
  | "jobs"
  | "storageObjects"
  | "relations"
  | "databaseSizeBytes"
>;

interface QueryResult<Row> {
  rows: Row[];
}

interface PgClientLike {
  connect(): Promise<void>;
  query<Row = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<QueryResult<Row>>;
  end(): Promise<void>;
}

interface PgClientConstructor {
  new (options: { connectionString: string; application_name: string }): PgClientLike;
}

function baseAvailability(): ReportAvailability {
  return {
    jobs: false,
    storage: false,
    relationCounts: false,
    relationSizes: false,
    databaseSize: false,
    requestEvents: false,
    actualProviderCost: false,
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeJob(row: Record<string, unknown>): ReportJobRow {
  return {
    provider: String(row.provider),
    status: row.status as ReportJobRow["status"],
    cost_estimate: numberOrNull(row.cost_estimate) ?? 0,
    budget_reservation: numberOrNull(row.budget_reservation) ?? 0,
    config_snapshot: row.config_snapshot,
    seed: numberOrNull(row.seed),
    started_at: typeof row.started_at === "string" ? row.started_at : null,
    provider_submitted_at:
      typeof row.provider_submitted_at === "string" ? row.provider_submitted_at : null,
    completed_at: typeof row.completed_at === "string" ? row.completed_at : null,
    last_polled_at: typeof row.last_polled_at === "string" ? row.last_polled_at : null,
    error_type: (row.error_type as ReportJobRow["error_type"]) ?? null,
    error_code: typeof row.error_code === "string" ? row.error_code : null,
    provider_http_status: numberOrNull(row.provider_http_status),
    idempotency_key: typeof row.idempotency_key === "string" ? row.idempotency_key : null,
    created_at: String(row.created_at),
    person_image_url: typeof row.person_image_url === "string" ? row.person_image_url : null,
    result_image_url: typeof row.result_image_url === "string" ? row.result_image_url : null,
  };
}

const JOB_SELECT = [
  "provider",
  "status",
  "cost_estimate",
  "budget_reservation",
  "config_snapshot",
  "seed",
  "started_at",
  "provider_submitted_at",
  "completed_at",
  "last_polled_at",
  "error_type",
  "error_code",
  "provider_http_status",
  "idempotency_key",
  "created_at",
  "person_image_url",
  "result_image_url",
].join(",");

async function loadSupabaseJobs(client: SupabaseClient): Promise<ReportJobRow[]> {
  const rows: ReportJobRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from("try_on_jobs")
      .select(JOB_SELECT)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`jobs:${error.code || "unknown"}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page.map(normalizeJob));
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function listStoragePrefix(
  client: SupabaseClient,
  bucketId: string,
  prefix: string,
): Promise<ReportStorageObject[]> {
  const objects: ReportStorageObject[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client.storage.from(bucketId).list(prefix, {
      limit: PAGE_SIZE,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`storage:${bucketId}:${error.name ?? "unknown"}`);
    const page = data ?? [];
    for (const entry of page) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null && entry.metadata === null) {
        objects.push(...await listStoragePrefix(client, bucketId, name));
      } else {
        objects.push({
          bucketId,
          name,
          sizeBytes: numberOrNull(entry.metadata?.size),
        });
      }
    }
    if (page.length < PAGE_SIZE) break;
  }
  return objects;
}

async function loadSupabaseStorage(client: SupabaseClient): Promise<ReportStorageObject[]> {
  const buckets = await Promise.all([
    listStoragePrefix(client, PERSON_BUCKET, ""),
    listStoragePrefix(client, RESULT_BUCKET, ""),
  ]);
  return buckets.flat().sort((left, right) =>
    left.bucketId.localeCompare(right.bucketId) || left.name.localeCompare(right.name));
}

async function loadSupabaseRelationCounts(
  client: SupabaseClient,
): Promise<{ relations: RelationMetric[]; complete: boolean }> {
  let complete = true;
  const relations = await Promise.all(REPORT_RELATIONS.map(async (name): Promise<RelationMetric> => {
    const { count, error } = await client.from(name).select("*", { count: "exact", head: true });
    if (error) complete = false;
    return { name: `public.${name}`, rowCount: error ? null : count, tableBytes: null, indexBytes: null, totalBytes: null };
  }));
  return { relations, complete };
}

async function loadFromSupabase(environment: ReportSourceEnvironment): Promise<LoadedReportData> {
  const url = environment.SUPABASE_URL ?? environment.NEXT_PUBLIC_SUPABASE_URL;
  const key = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("supabase-config-missing");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const availability = baseAvailability();
  const unavailableReasons = [
    "未提供 DB_URL：Supabase API fallback 無法取得 relation size 與 database size。",
    "沒有 provider billing data：actual provider cost unavailable。",
    "沒有 request-level event：建 job 前的拒絕 unavailable。",
  ];

  let jobs: ReportJobRow[] | null = null;
  try {
    jobs = await loadSupabaseJobs(client);
    availability.jobs = true;
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "jobs:unknown";
    unavailableReasons.push(`Supabase Data API 無法讀取 try_on_jobs（${code}）；job 指標 unavailable。`);
  }

  let storageObjects: ReportStorageObject[] | null = null;
  try {
    storageObjects = await loadSupabaseStorage(client);
    availability.storage = true;
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "storage:unknown";
    unavailableReasons.push(`Supabase Storage API 無法列出私有 buckets（${code}）；Storage 指標 unavailable。`);
  }

  let relations: RelationMetric[] = REPORT_RELATIONS.map((name) => ({
    name: `public.${name}`,
    rowCount: null,
    tableBytes: null,
    indexBytes: null,
    totalBytes: null,
  }));
  try {
    const loaded = await loadSupabaseRelationCounts(client);
    relations = loaded.relations;
    availability.relationCounts = loaded.complete;
    if (!loaded.complete) unavailableReasons.push("部分 relation row count 無法由 Data API 取得。");
  } catch {
    unavailableReasons.push("Relation row count 無法由 Data API 取得。");
  }

  return {
    source: "supabase-api",
    availability,
    unavailableReasons,
    jobs,
    storageObjects,
    relations,
    databaseSizeBytes: null,
  };
}

function pgClientConstructor(): PgClientConstructor {
  const require = createRequire(import.meta.url);
  const pgModule = require("pg") as { Client: PgClientConstructor };
  return pgModule.Client;
}

async function loadFromPostgres(connectionString: string): Promise<LoadedReportData> {
  const Client = pgClientConstructor();
  const client = new Client({ connectionString, application_name: "try-on-baseline-report" });
  const availability = baseAvailability();
  const unavailableReasons = [
    "沒有 provider billing data：actual provider cost unavailable。",
    "沒有 request-level event：建 job 前的拒絕 unavailable。",
  ];
  let transactionOpen = false;
  try {
    await client.connect();
    await client.query("begin transaction read only");
    transactionOpen = true;
    await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    const [jobResult, storageResult, relationResult, databaseResult] = await Promise.all([
      client.query<Record<string, unknown>>(`select ${JOB_SELECT} from public.try_on_jobs order by created_at`),
      client.query<Record<string, unknown>>(
        `select bucket_id, name,
                case when metadata ? 'size' and (metadata->>'size') ~ '^[0-9]+$'
                     then (metadata->>'size')::bigint else null end as size_bytes
         from storage.objects
         where bucket_id = any($1::text[])
         order by bucket_id, name`,
        [[PERSON_BUCKET, RESULT_BUCKET]],
      ),
      client.query<Record<string, unknown>>(
        `with relation_counts as (${EXACT_RELATION_COUNTS_SQL})
         select stats.schemaname || '.' || stats.relname as name,
                counts.row_count,
                pg_relation_size(relid)::bigint as table_bytes,
                pg_indexes_size(relid)::bigint as index_bytes,
                pg_total_relation_size(relid)::bigint as total_bytes
         from pg_stat_user_tables stats
         join relation_counts counts on counts.relname = stats.relname
         where stats.schemaname = 'public'
         order by name`,
      ),
      client.query<{ database_size_bytes: unknown }>(
        "select pg_database_size(current_database())::bigint as database_size_bytes",
      ),
    ]);
    await client.query("commit");
    transactionOpen = false;
    availability.jobs = true;
    availability.storage = true;
    availability.relationCounts = true;
    availability.relationSizes = true;
    availability.databaseSize = true;
    return {
      source: "postgres",
      availability,
      unavailableReasons,
      jobs: jobResult.rows.map(normalizeJob),
      storageObjects: storageResult.rows.map((row) => ({
        bucketId: String(row.bucket_id),
        name: String(row.name),
        sizeBytes: numberOrNull(row.size_bytes),
      })),
      relations: relationResult.rows.map((row) => ({
        name: String(row.name),
        rowCount: numberOrNull(row.row_count),
        tableBytes: numberOrNull(row.table_bytes),
        indexBytes: numberOrNull(row.index_bytes),
        totalBytes: numberOrNull(row.total_bytes),
      })),
      databaseSizeBytes: numberOrNull(databaseResult.rows[0]?.database_size_bytes),
    };
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

function unavailableData(reason: string): LoadedReportData {
  return {
    source: "unavailable",
    availability: baseAvailability(),
    unavailableReasons: [
      reason,
      "沒有 provider billing data：actual provider cost unavailable。",
      "沒有 request-level event：建 job 前的拒絕 unavailable。",
    ],
    jobs: null,
    storageObjects: null,
    relations: REPORT_RELATIONS.map((name) => ({
      name: `public.${name}`,
      rowCount: null,
      tableBytes: null,
      indexBytes: null,
      totalBytes: null,
    })),
    databaseSizeBytes: null,
  };
}

function nonNegativeNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field} 必須是非負數`);
  return number;
}

export function applyDatabaseMetricsOverlay(
  data: LoadedReportData,
  overlay: DatabaseMetricsOverlay,
): LoadedReportData {
  const allowedRelations = new Set(REPORT_RELATIONS.map((name) => `public.${name}`));
  const sizes = new Map(overlay.relations.map((relation) => {
    if (!allowedRelations.has(relation.name)) throw new Error("DB metrics overlay 包含不支援的 relation");
    return [relation.name, {
      tableBytes: nonNegativeNumber(relation.tableBytes, "tableBytes"),
      indexBytes: nonNegativeNumber(relation.indexBytes, "indexBytes"),
      totalBytes: nonNegativeNumber(relation.totalBytes, "totalBytes"),
    }];
  }));
  const allRelationsCovered = data.relations.every((relation) => sizes.has(relation.name));
  return {
    ...data,
    source: data.source === "supabase-api" ? "supabase-api+readonly-sql" : data.source,
    availability: {
      ...data.availability,
      databaseSize: true,
      relationSizes: allRelationsCovered,
    },
    unavailableReasons: data.unavailableReasons.filter((reason) =>
      !reason.startsWith("未提供 DB_URL：")),
    databaseSizeBytes: nonNegativeNumber(overlay.databaseSizeBytes, "databaseSizeBytes"),
    relations: data.relations.map((relation) => ({
      ...relation,
      ...(sizes.get(relation.name) ?? {}),
    })),
  };
}

export async function loadReportData(
  environment: ReportSourceEnvironment,
  preference: ReportSourcePreference,
): Promise<LoadedReportData> {
  const hasSupabase = Boolean(
    (environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL) &&
    environment.SUPABASE_SERVICE_ROLE_KEY,
  );
  if (preference === "postgres") {
    if (!environment.DB_URL) return unavailableData("指定 postgres source，但未提供 DB_URL。");
    return loadFromPostgres(environment.DB_URL).catch(() =>
      unavailableData("唯讀 PostgreSQL 連線或查詢失敗；未輸出連線字串。"));
  }
  if (preference === "supabase") {
    if (!hasSupabase) return unavailableData("指定 supabase source，但 URL／service key 未完整設定。");
    return loadFromSupabase(environment).catch(() =>
      unavailableData("Supabase API 連線失敗；未輸出 URL 或憑證。"));
  }
  if (environment.DB_URL) {
    try {
      return await loadFromPostgres(environment.DB_URL);
    } catch {
      if (hasSupabase) {
        const fallback = await loadFromSupabase(environment);
        fallback.unavailableReasons.push("DB_URL 查詢失敗，已安全降級至 Supabase API；未輸出連線字串。");
        return fallback;
      }
      return unavailableData("DB_URL 查詢失敗，且沒有 Supabase API fallback。");
    }
  }
  if (hasSupabase) return loadFromSupabase(environment);
  return unavailableData("找不到 DB_URL 或完整 Supabase 後端設定。");
}
