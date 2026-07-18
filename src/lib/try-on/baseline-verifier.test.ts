import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { verifyTryOnBaseline } from "./baseline-verifier";

const CANDIDATE_1_MANIFEST = resolve(
  process.cwd(),
  "fixtures/try-on-baselines/v1.0.0-candidate.1/manifest.json",
);
const MANIFEST = resolve(
  process.cwd(),
  "fixtures/try-on-baselines/v1.0.0/manifest.json",
);

describe("Try-On baseline verifier", () => {
  it("approved baseline 的檔案、hash、Workflow 與人工接受案例完整一致", async () => {
    const result = await verifyTryOnBaseline({
      repoRoot: process.cwd(),
      manifestPath: MANIFEST,
    });

    expect(result.errors).toEqual([]);
    expect(result.status).toBe("approved");
    expect(result.checkedWorkflowCases).toBe(16);
    expect(result.checkedVisualCases).toBe(7);
    expect(result.warnings).toEqual([]);
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

  it("require-approved 接受已凍結的人工核准 baseline", async () => {
    const result = await verifyTryOnBaseline({
      repoRoot: process.cwd(),
      manifestPath: MANIFEST,
      requireApproved: true,
    });

    expect(result.errors).toEqual([]);
  });
});
