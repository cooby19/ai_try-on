import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { verifyTryOnBaseline } from "./baseline-verifier";

const CANDIDATE_1_MANIFEST = resolve(
  process.cwd(),
  "fixtures/try-on-baselines/v1.0.0-candidate.1/manifest.json",
);
const MANIFEST = resolve(
  process.cwd(),
  "fixtures/try-on-baselines/v1.0.0-candidate.2/manifest.json",
);

describe("Try-On baseline verifier", () => {
  it("最新 candidate 的檔案、hash、Workflow 與視覺案例完整一致", async () => {
    const result = await verifyTryOnBaseline({
      repoRoot: process.cwd(),
      manifestPath: MANIFEST,
    });

    expect(result.errors).toEqual([]);
    expect(result.status).toBe("candidate");
    expect(result.checkedWorkflowCases).toBe(16);
    expect(result.checkedVisualCases).toBe(12);
    expect(result.warnings).toContain("baseline 仍是 candidate，尚未經人工核准");
  });

  it("保留的 candidate.1 仍可獨立驗證且不被覆寫", async () => {
    const result = await verifyTryOnBaseline({
      repoRoot: process.cwd(),
      manifestPath: CANDIDATE_1_MANIFEST,
    });

    expect(result.errors).toEqual([]);
    expect(result.baselineId).toBe("try-on-v1.0.0-candidate.1");
    expect(result.checkedVisualCases).toBe(0);
  });

  it("require-approved 會拒絕尚未人工核准的 candidate", async () => {
    const result = await verifyTryOnBaseline({
      repoRoot: process.cwd(),
      manifestPath: MANIFEST,
      requireApproved: true,
    });

    expect(result.errors).toContain("目前 baseline 不是 approved");
  });
});
