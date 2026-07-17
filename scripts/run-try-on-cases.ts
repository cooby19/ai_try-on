import { runScenarioCli } from "../src/lib/try-on/scenario-runner";

async function main() {
  const result = await runScenarioCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

void main();
