import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import {
  buildBaselineReport,
  canonicalReportJson,
  renderBaselineMarkdown,
  type DeterministicCaseSummary,
} from "../src/lib/try-on/reporting";
import {
  applyDatabaseMetricsOverlay,
  loadReportData,
  type DatabaseMetricsOverlay,
  type ReportSourceEnvironment,
  type ReportSourcePreference,
} from "../src/lib/try-on/report-source";
import {
  installNetworkGuard,
  loadScenarioManifest,
  runScenarios,
} from "../src/lib/try-on/scenario-runner";

type OutputFormat = "markdown" | "json";

interface CliOptions {
  from: string;
  to: string;
  format: OutputFormat;
  out?: string;
  source: ReportSourcePreference;
  dbMetrics?: string;
}

const USAGE = [
  "Usage: npm run try-on:report -- [--from <ISO>] [--to <ISO>]",
  "       [--format markdown|json] [--out <path>] [--source auto|postgres|supabase]",
  "       [--db-metrics <sanitized-aggregate-json>]",
].join("\n");

function defaultWindow(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 需要值`);
  return value;
}

export function parseReportCliArgs(args: string[]): CliOptions {
  const defaults = defaultWindow();
  const options: CliOptions = { ...defaults, format: "markdown", source: "auto" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--from") {
      options.from = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "--to") {
      options.to = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "--format") {
      const value = takeValue(args, index, argument);
      if (value !== "markdown" && value !== "json") throw new Error("--format 只支援 markdown 或 json");
      options.format = value;
      index += 1;
    } else if (argument === "--out") {
      options.out = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "--source") {
      const value = takeValue(args, index, argument);
      if (value !== "auto" && value !== "postgres" && value !== "supabase") {
        throw new Error("--source 只支援 auto、postgres 或 supabase");
      }
      options.source = value;
      index += 1;
    } else if (argument === "--db-metrics") {
      options.dbMetrics = takeValue(args, index, argument);
      index += 1;
    } else {
      throw new Error(`未知參數：${argument}`);
    }
  }
  const from = Date.parse(options.from);
  const to = Date.parse(options.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error("--from／--to 必須是合法 ISO 時間，且 from 早於 to");
  }
  options.from = new Date(from).toISOString();
  options.to = new Date(to).toISOString();
  return options;
}

function decodeEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvironment(): ReportSourceEnvironment {
  const environment: Record<string, string | undefined> = { ...process.env };
  const path = resolve(process.cwd(), ".env.local");
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
      if (match && environment[match[1]] === undefined) environment[match[1]] = decodeEnvValue(match[2]);
    }
  }
  return {
    DB_URL: environment.DB_URL,
    SUPABASE_URL: environment.SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: environment.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: environment.SUPABASE_SERVICE_ROLE_KEY,
  };
}

function loadDatabaseMetricsOverlay(path: string): DatabaseMetricsOverlay {
  const parsed = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as DatabaseMetricsOverlay;
  if (!parsed || !Array.isArray(parsed.relations)) throw new Error("DB metrics overlay 格式不合法");
  return parsed;
}

async function runDeterministicCases(): Promise<DeterministicCaseSummary> {
  const restore = installNetworkGuard();
  try {
    const summary = await runScenarios(loadScenarioManifest().cases);
    return { total: summary.cases.length, passed: summary.passed, failed: summary.failed };
  } finally {
    restore();
  }
}

export async function runReportCli(args: string[]): Promise<{
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}> {
  let options: CliOptions;
  try {
    options = parseReportCliArgs(args);
  } catch (cause) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${cause instanceof Error ? cause.message : "參數錯誤"}\n${USAGE}\n`,
    };
  }

  try {
    // 先完成所有外部唯讀查詢，再啟用固定案例的 network guard。
    let source = await loadReportData(loadEnvironment(), options.source);
    if (options.dbMetrics) {
      source = applyDatabaseMetricsOverlay(source, loadDatabaseMetricsOverlay(options.dbMetrics));
    }
    const deterministicCases = await runDeterministicCases();
    const report = buildBaselineReport({
      generatedAt: options.to,
      from: options.from,
      to: options.to,
      deterministicCases,
      ...source,
    });
    const output = options.format === "json"
      ? canonicalReportJson(report)
      : renderBaselineMarkdown(report);
    if (options.out) {
      const outputPath = resolve(process.cwd(), options.out);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, output, "utf8");
    }
    return {
      exitCode: deterministicCases.failed === 0 ? 0 : 1,
      stdout: options.out ? "" : output,
      stderr: "",
    };
  } catch {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "報表產生失敗；請檢查時間參數、唯讀資料來源與輸出路徑。未輸出任何憑證。\n",
    };
  }
}

async function main() {
  const result = await runReportCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

void main();
