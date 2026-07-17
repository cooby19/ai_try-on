import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { Client } from "pg";

const PRODUCT_ID = "00000000-0000-0000-0000-000000000001";
const SEED = 314159265;
const FINGERPRINT = "a".repeat(64);
const WAIT_TIMEOUT_MS = 2_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readLocalSupabaseEnvironment() {
  const output = execFileSync(
    "npx",
    ["--yes", "supabase@latest", "status", "-o", "env"],
    { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const entries = output
    .split(/\r?\n/u)
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u))
    .filter(Boolean)
    .map(([, key, rawValue]) => [key, rawValue.replace(/^['"]|['"]$/gu, "")]);
  const environment = Object.fromEntries(entries);

  for (const key of ["API_URL", "ANON_KEY", "DB_URL"]) {
    assert(environment[key], `找不到 ${key}；請先執行 supabase start。`);
  }

  return environment;
}

function taipeiTodayStartUtcIso() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );

  return new Date(
    Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day), -8),
  ).toISOString();
}

async function signUpTestUser(apiUrl, anonKey) {
  const email = `idempotency-race-${randomUUID()}@local.test`;
  const response = await fetch(`${apiUrl}/auth/v1/signup`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password: `LocalTest-${randomUUID()}` }),
  });
  const body = await response.json();

  assert(response.ok, `建立本機測試使用者失敗：${JSON.stringify(body)}`);
  assert(body.user?.id, "Supabase Auth 未回傳測試使用者 id。");
  return body.user.id;
}

async function waitForBlockedSession(observer) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const result = await observer.query(
      `select wait_event_type = 'Lock' as is_waiting
       from pg_stat_activity
       where application_name = 'try-on-idempotency-session-b'`,
    );

    if (result.rows[0]?.is_waiting) {
      return;
    }
    await sleep(25);
  }

  throw new Error("第二個 PostgreSQL session 沒有等待第一個 session 的 advisory lock。");
}

async function cleanup(client, userId) {
  if (!client || !userId) return;

  await client.query("delete from public.try_on_jobs where user_id = $1", [userId]);
  await client.query("delete from public.users where id = $1", [userId]);
  await client.query("delete from auth.users where id = $1", [userId]);
}

async function main() {
  const { API_URL: apiUrl, ANON_KEY: anonKey, DB_URL: dbUrl } = readLocalSupabaseEnvironment();
  const userId = await signUpTestUser(apiUrl, anonKey);
  const sessionA = new Client({ connectionString: dbUrl, application_name: "try-on-idempotency-session-a" });
  const sessionB = new Client({ connectionString: dbUrl, application_name: "try-on-idempotency-session-b" });
  let sessionATransactionOpen = false;

  const idempotencyKey = `concurrency-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const snapshot = JSON.stringify({
    schemaVersion: 1,
    generation: { seed: SEED },
  });
  const parameters = [
    userId,
    PRODUCT_ID,
    `person-uploads/${userId}/race-person.jpg`,
    "/garments/white-tee.svg",
    "mock",
    0.1,
    0.1,
    taipeiTodayStartUtcIso(),
    10,
    3,
    100,
    SEED,
    snapshot,
    startedAt,
    idempotencyKey,
    FINGERPRINT,
  ];
  const rpcQuery = `
    select public.insert_try_on_job_within_quota(
      $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
      $6::numeric, $7::numeric, $8::timestamptz, $9::integer,
      $10::integer, $11::numeric, $12::bigint, $13::jsonb,
      $14::timestamptz, $15::text, $16::text
    ) as result
  `;

  try {
    await Promise.all([sessionA.connect(), sessionB.connect()]);

    const profile = await sessionA.query(
      "select id from public.users where id = $1",
      [userId],
    );
    assert(profile.rowCount === 1, "Auth trigger 沒有建立 public.users 測試 profile。");

    await sessionA.query("begin");
    sessionATransactionOpen = true;
    const created = await sessionA.query(rpcQuery, parameters);

    const replayPromise = sessionB.query(rpcQuery, parameters);
    await waitForBlockedSession(sessionA);

    await sessionA.query("commit");
    sessionATransactionOpen = false;
    const replayed = await replayPromise;

    const createdResult = created.rows[0]?.result;
    const replayedResult = replayed.rows[0]?.result;
    assert(createdResult?.outcome === "created", "第一個 session 必須建立 job。");
    assert(replayedResult?.outcome === "replayed", "第二個 session 必須回放既有 job。");
    assert(
      createdResult.job?.id === replayedResult.job?.id,
      "兩個 session 沒有指向相同的 try-on job。",
    );
    assert(
      createdResult.used_today === 1 && replayedResult.used_today === 1,
      "同一 idempotency key 不應重複扣除每日 quota。",
    );

    const persisted = await sessionA.query(
      `select count(*)::integer as job_count,
              coalesce(sum(budget_reservation), 0)::text as total_reservation
       from public.try_on_jobs
       where user_id = $1 and idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    assert(persisted.rows[0]?.job_count === 1, "資料庫中應只留下單一 try_on_jobs 記錄。");
    assert(Number(persisted.rows[0]?.total_reservation) === 0.1, "quota reservation 應只保留一次。");

    console.log("PASS: 兩個獨立 PostgreSQL session 的 idempotency 併發測試通過。");
  } finally {
    if (sessionATransactionOpen) {
      await sessionA.query("rollback").catch(() => undefined);
    }
    await cleanup(sessionA, userId).catch((error) => {
      console.warn(`清理本機測試資料失敗：${error.message}`);
    });
    await Promise.all([sessionA.end().catch(() => undefined), sessionB.end().catch(() => undefined)]);
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
