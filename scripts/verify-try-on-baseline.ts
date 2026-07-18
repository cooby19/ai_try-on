import { resolve } from "node:path";
import { verifyTryOnBaseline } from "../src/lib/try-on/baseline-verifier";

const DEFAULT_MANIFEST = "fixtures/try-on-baselines/v1.0.0-candidate.2/manifest.json";
const USAGE = "Usage: npm run try-on:baseline:verify -- [--manifest <path>] [--require-approved]";

interface CliOptions {
  manifest: string;
  requireApproved: boolean;
}

export function parseBaselineVerifierArgs(args: string[]): CliOptions {
  let manifest = DEFAULT_MANIFEST;
  let requireApproved = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--manifest") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--manifest 需要路徑");
      manifest = value;
      index += 1;
    } else if (argument === "--require-approved") {
      requireApproved = true;
    } else {
      throw new Error(`未知參數：${argument}`);
    }
  }
  return { manifest, requireApproved };
}

export async function runBaselineVerifierCli(args: string[]): Promise<{
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}> {
  let options: CliOptions;
  try {
    options = parseBaselineVerifierArgs(args);
  } catch (cause) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${cause instanceof Error ? cause.message : "參數錯誤"}\n${USAGE}\n`,
    };
  }

  // Verifier 僅做本機唯讀檢查；即使日後誤加 fetch，也會在執行時立即失敗。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("baseline verifier forbids external network access");
  };
  try {
    const result = await verifyTryOnBaseline({
      repoRoot: process.cwd(),
      manifestPath: resolve(process.cwd(), options.manifest),
      requireApproved: options.requireApproved,
    });
    const lines = [
      `Baseline: ${result.baselineId ?? "unknown"}`,
      `Status: ${result.status ?? "invalid"}`,
      `Checked: ${result.checkedFiles} files, ${result.checkedWorkflowCases} workflow cases, ${result.checkedVisualCases} visual cases`,
      ...result.warnings.map((warning) => `[WARN] ${warning}`),
      ...result.errors.map((error) => `[FAIL] ${error}`),
    ];
    if (result.errors.length === 0) lines.push("[PASS] baseline integrity verified");
    return {
      exitCode: result.errors.length === 0 ? 0 : 1,
      stdout: `${lines.join("\n")}\n`,
      stderr: "",
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  const result = await runBaselineVerifierCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

void main();
