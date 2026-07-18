import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260717041002_try_on_reproducibility_idempotency.sql",
);
const numericFixMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260718000000_fix_try_on_budget_reservation_coalesce.sql",
);
const disableGenerationLimitsMigrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260718010000_disable_try_on_generation_limits.sql",
);

async function migrationSql(): Promise<string> {
  return readFile(migrationPath, "utf8");
}

async function numericFixMigrationSql(): Promise<string> {
  return readFile(numericFixMigrationPath, "utf8");
}

async function disableGenerationLimitsMigrationSql(): Promise<string> {
  return readFile(disableGenerationLimitsMigrationPath, "utf8");
}

describe("Try-On migration contract（離線靜態保護）", () => {
  it("保留平台 → 使用者 advisory lock 順序，並在鎖內重查 idempotency", async () => {
    const sql = await migrationSql();
    const platformLock = sql.indexOf("'platform:' || p_since::text");
    const userLock = sql.indexOf("'user:' || p_user_id::text");
    const lockWaitRecheck = sql.indexOf("等鎖期間可能已有同 key transaction commit");
    expect(platformLock).toBeGreaterThan(-1);
    expect(userLock).toBeGreaterThan(platformLock);
    expect(lockWaitRecheck).toBeGreaterThan(userLock);
  });

  it("partial unique index 與 unique_violation 收斂是 DB 最後防線", async () => {
    const sql = await migrationSql();
    expect(sql).toContain("create unique index try_on_jobs_user_idempotency_key_uidx");
    expect(sql).toContain("where idempotency_key is not null");
    expect(sql).toContain("exception when unique_violation");
    expect(sql).toContain("'outcome', 'replayed'");
    expect(sql).toContain("'outcome', 'conflict'");
  });

  it("SECURITY DEFINER 使用空 search_path 且只授權 service_role", async () => {
    const sql = await migrationSql();
    expect(sql).toContain("security definer\nset search_path = ''");
    expect(sql).toMatch(/from public, anon, authenticated;/);
    expect(sql).toMatch(/to service_role;/);
    expect(sql).not.toContain("pg_catalog.coalesce");
  });

  it("舊 overload 全數移除，snapshot/seed/idempotency 在同一 insert 寫入", async () => {
    const sql = await migrationSql();
    expect(sql.match(/drop function if exists public\.insert_try_on_job_within_quota/g)).toHaveLength(3);
    expect(sql).toContain("seed, config_snapshot, started_at, idempotency_key, request_fingerprint");
    expect(sql).toContain("new.config_snapshot := old.config_snapshot");
    expect(sql).toContain("new.completed_at := old.completed_at");
  });

  it("numeric 預算 aggregate 使用明確 numeric fallback，且 replacement 保留 RPC 安全邊界", async () => {
    const sql = await numericFixMigrationSql();
    expect(sql).toContain("create or replace function public.insert_try_on_job_within_quota");
    expect(sql).toContain("coalesce(pg_catalog.sum(budget_reservation), 0::numeric)");
    expect(sql).not.toContain("pg_catalog.coalesce");
    expect(sql).toContain("security definer\nset search_path = ''");
    expect(sql).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(sql).toMatch(/from public, anon, authenticated;/);
    expect(sql).toMatch(/to service_role;/);
  });

  it("生成次數限制可由 null 暫時停用，但平台預算與 RPC 安全邊界仍保留", async () => {
    const sql = await disableGenerationLimitsMigrationSql();
    expect(sql).toContain("p_daily_limit is not null and v_used_today >= p_daily_limit");
    expect(sql).toContain("p_product_attempt_limit is not null and v_product_attempts >= p_product_attempt_limit");
    expect(sql).toContain("v_platform_reserved + p_budget_reservation > p_platform_daily_budget");
    expect(sql).toContain("security definer\nset search_path = ''");
    expect(sql).toMatch(/from public, anon, authenticated;/);
    expect(sql).toMatch(/to service_role;/);
  });
});
