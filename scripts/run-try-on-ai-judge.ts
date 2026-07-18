import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  createBlindJudgeDryRun,
  loadBlindJudgePlan,
  runBlindJudgeExperiment,
} from "../src/lib/try-on/ai-judge-runner";
import {
  AI_JUDGE_PROMPT_HASH,
  AI_JUDGE_PROMPT_VERSION,
  AI_JUDGE_SYSTEM_PROMPT,
  AI_JUDGE_TASK_PROMPT,
} from "../src/lib/try-on/ai-judge-prompt";

const USAGE = `Usage:
  npm run try-on:judge -- --plan <path> [--model <model>] [--out <path>] [--execute]
  npm run try-on:judge -- --print-prompt`;

interface CliOptions {
  planPath: string | null;
  model: string | undefined;
  outPath: string | null;
  execute: boolean;
  printPrompt: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    planPath: null,
    model: undefined,
    outPath: null,
    execute: false,
    printPrompt: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") options.execute = true;
    else if (argument === "--print-prompt") options.printPrompt = true;
    else if (argument === "--plan" || argument === "--model" || argument === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少值`);
      index += 1;
      if (argument === "--plan") options.planPath = value;
      else if (argument === "--model") options.model = value;
      else options.outPath = value;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else {
      throw new Error(`未知參數：${argument}`);
    }
  }
  return options;
}

function printPrompt() {
  process.stdout.write(
    [
      `Prompt version: ${AI_JUDGE_PROMPT_VERSION}`,
      `Prompt SHA-256: ${AI_JUDGE_PROMPT_HASH}`,
      "",
      "[SYSTEM]",
      AI_JUDGE_SYSTEM_PROMPT,
      "",
      "[TASK]",
      AI_JUDGE_TASK_PROMPT,
      "",
    ].join("\n"),
  );
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.printPrompt) {
      if (options.execute || options.planPath || options.outPath) {
        throw new Error("--print-prompt 不可與 plan、out 或 --execute 併用");
      }
      printPrompt();
      return;
    }
    if (!options.planPath) throw new Error("請用 --plan 指定盲測計畫");

    const repoRoot = process.cwd();
    const plan = loadBlindJudgePlan(resolve(repoRoot, options.planPath));
    const model = options.model ?? process.env.AI_JUDGE_MODEL;
    const result = options.execute
      ? await runBlindJudgeExperiment({
          repoRoot,
          plan,
          model,
          apiKey: process.env.OPENAI_API_KEY ?? "",
        })
      : createBlindJudgeDryRun({ repoRoot, plan, model });
    const output = `${JSON.stringify(result, null, 2)}\n`;

    if (options.outPath) {
      const absoluteOutPath = resolve(repoRoot, options.outPath);
      if (relative(repoRoot, absoluteOutPath).startsWith("..")) {
        throw new Error("--out 必須位於目前 repo 內");
      }
      mkdirSync(dirname(absoluteOutPath), { recursive: true });
      writeFileSync(absoluteOutPath, output, "utf8");
    } else process.stdout.write(output);
    if ("summary" in result && result.summary.inconclusive > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    process.exitCode = 2;
  }
}

void main();
