import { describe, expect, it } from "vitest";
import { createTryOnWorkflow } from "./workflow-core";
import {
  canonicalJson,
  installNetworkGuard,
  loadScenarioManifest,
  runScenarioCli,
  runScenarios,
  scenarioWorkflowFactory,
} from "./scenario-runner";

describe("deterministic Try-On scenario manifest", () => {
  it("固定為 16 個案例且 ID 唯一", () => {
    const manifest = loadScenarioManifest();
    const ids = manifest.cases.map((definition) => definition.id);

    expect(manifest.schemaVersion).toBe(1);
    expect(ids).toHaveLength(16);
    expect(new Set(ids).size).toBe(16);
  });

  it("全部案例符合 versioned golden expected", async () => {
    const summary = await runScenarios(loadScenarioManifest().cases);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(16);
  });

  it("相同參數連續執行得到 byte-for-byte 相同 canonical output", async () => {
    const first = await runScenarioCli(["--json"]);
    const second = await runScenarioCli(["--json"]);

    expect(first).toEqual(second);
    expect(first.exitCode).toBe(0);
    expect(canonicalJson(JSON.parse(first.stdout))).toBe(canonicalJson(JSON.parse(second.stdout)));
  });

  it("CLI 支援 list、單一案例及穩定 usage exit code", async () => {
    const listed = await runScenarioCli(["--list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.split("\n").filter(Boolean)).toHaveLength(16);

    const selected = await runScenarioCli(["--case", "reject-missing-input", "--json"]);
    expect(selected.exitCode).toBe(0);
    expect(JSON.parse(selected.stdout)).toMatchObject({
      passed: 1,
      failed: 0,
      cases: [{ id: "reject-missing-input", passed: true }],
    });

    expect((await runScenarioCli(["--case", "does-not-exist"])).exitCode).toBe(2);
    expect((await runScenarioCli(["--case"])).exitCode).toBe(2);
    expect((await runScenarioCli(["--unknown"])).exitCode).toBe(2);
  });

  it("CLI 可明確注入 control／candidate，candidate observation 可 byte-for-byte 重現", async () => {
    const args = [
      "--case",
      "start-v16-explicit-seed-success",
      "--feature-config",
      "fixtures/try-on-experiments/example.v1.json",
      "--variant",
      "candidate",
      "--json",
    ];
    const first = await runScenarioCli(args);
    const second = await runScenarioCli(args);

    expect(first).toEqual(second);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      mode: "feature-observation",
      experimentId: "example-max-v1",
      variantRole: "candidate",
      failed: 0,
      cases: [
        {
          actual: {
            finalJob: {
              provider: "fashn-max",
              configSnapshot: {
                experiment: {
                  variantId: "candidate-max",
                  variantRole: "candidate",
                  assignmentVersion: "forced-test-v1",
                },
              },
            },
          },
        },
      ],
    });
    expect(
      (
        await runScenarioCli([
          "--feature-config",
          "fixtures/try-on-experiments/example.v1.json",
        ])
      ).exitCode,
    ).toBe(2);
  });

  it("執行期間明確封鎖外部 network", async () => {
    const restore = installNetworkGuard();
    try {
      await expect(fetch("https://example.com")).rejects.toThrow(
        "deterministic scenario runner forbids external network access",
      );
    } finally {
      restore();
    }
  });

  it("scenario harness 直接使用正式 Workflow core factory", () => {
    expect(scenarioWorkflowFactory).toBe(createTryOnWorkflow);
  });
});
