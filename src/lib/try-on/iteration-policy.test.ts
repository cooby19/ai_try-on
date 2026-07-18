import { describe, expect, it } from "vitest";
import {
  evaluateTryOnIterationStop,
  evaluateTryOnPromotionGate,
  type TryOnPromotionEvidence,
} from "./iteration-policy";

function passingEvidence(): TryOnPromotionEvidence {
  return {
    offline: {
      testsPassed: true,
      lintPassed: true,
      deterministicCasesPassed: true,
      baselineIntegrityPassed: true,
      buildPassedOrNotRequired: true,
    },
    contract: {
      httpContractPreserved: true,
      securityRegression: false,
      privacyRegression: false,
      idempotencyRegression: false,
      snapshotComplete: true,
      approvedBaselineMutationDetected: false,
    },
    comparison: {
      pairedInputsMatch: true,
      productionMetricsSufficient: true,
      successRateWithinBudget: true,
      structuredErrorsWithinBudget: true,
      latencyWithinBudget: true,
      costWithinBudget: true,
    },
    visual: {
      criticalDefectCount: 0,
      judgeOutcome: "challenger",
      positionBiasDetected: false,
      abstainDetected: false,
      humanReview: "pending",
    },
  };
}

describe("Try-On promotion gate", () => {
  it("AI Judge challenger 勝出仍只能等待人工審查", () => {
    expect(evaluateTryOnPromotionGate(passingEvidence())).toEqual({
      status: "awaiting-human-review",
      blockers: [],
      automatedPromotionAllowed: false,
    });
  });

  it("任何 regression、inconclusive 或 baseline mutation 都會阻擋", () => {
    const evidence = passingEvidence();
    evidence.contract.idempotencyRegression = true;
    evidence.contract.approvedBaselineMutationDetected = true;
    evidence.visual.judgeOutcome = "inconclusive";
    expect(evaluateTryOnPromotionGate(evidence)).toMatchObject({
      status: "blocked",
      blockers: ["idempotency_regression", "approved_baseline_mutated", "judge_inconclusive"],
      automatedPromotionAllowed: false,
    });
  });

  it("人工 Accept 也只進 rollout review，不會自動 promotion", () => {
    const evidence = passingEvidence();
    evidence.visual.humanReview = "accept";
    expect(evaluateTryOnPromotionGate(evidence)).toMatchObject({
      status: "eligible-for-rollout-review",
      automatedPromotionAllowed: false,
    });
  });
});

describe("Try-On Agent stop conditions", () => {
  it("未觸及條件時可繼續", () => {
    expect(
      evaluateTryOnIterationStop({
        completedIterations: 1,
        consecutiveGateFailures: 0,
        repeatedRootCauseCount: 0,
        evidenceSufficient: true,
      }),
    ).toEqual({ stop: false, outcome: "continue", reasons: [] });
  });

  it("第三輪、連續兩次 gate fail 或同根因兩次會停止", () => {
    expect(
      evaluateTryOnIterationStop({
        completedIterations: 3,
        consecutiveGateFailures: 2,
        repeatedRootCauseCount: 2,
        evidenceSufficient: true,
      }),
    ).toMatchObject({
      stop: true,
      outcome: "stopped",
      reasons: ["maximum_iterations_reached", "consecutive_gate_failures", "repeated_root_cause"],
    });
  });

  it("證據不足時只能輸出 inconclusive", () => {
    expect(
      evaluateTryOnIterationStop({
        completedIterations: 1,
        consecutiveGateFailures: 0,
        repeatedRootCauseCount: 0,
        evidenceSufficient: false,
      }),
    ).toMatchObject({ stop: true, outcome: "inconclusive", reasons: ["insufficient_evidence"] });
  });
});
