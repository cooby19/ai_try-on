export const DEFAULT_TRY_ON_AGENT_ITERATION_POLICY = {
  schemaVersion: 1,
  maxAutomaticIterations: 3,
  externalApiBudgetUsd: 0,
  maxConsecutiveGateFailures: 2,
  maxRepeatedRootCause: 2,
} as const;

export interface TryOnPromotionEvidence {
  offline: {
    testsPassed: boolean;
    lintPassed: boolean;
    deterministicCasesPassed: boolean;
    baselineIntegrityPassed: boolean;
    buildPassedOrNotRequired: boolean;
  };
  contract: {
    httpContractPreserved: boolean;
    securityRegression: boolean;
    privacyRegression: boolean;
    idempotencyRegression: boolean;
    snapshotComplete: boolean;
    approvedBaselineMutationDetected: boolean;
  };
  comparison: {
    pairedInputsMatch: boolean;
    productionMetricsSufficient: boolean;
    successRateWithinBudget: boolean;
    structuredErrorsWithinBudget: boolean;
    latencyWithinBudget: boolean;
    costWithinBudget: boolean;
  };
  visual: {
    criticalDefectCount: number;
    judgeOutcome: "baseline" | "challenger" | "tie" | "inconclusive" | "not-run";
    positionBiasDetected: boolean;
    abstainDetected: boolean;
    humanReview: "pending" | "accept" | "reject";
  };
}

export interface TryOnPromotionGateResult {
  status: "blocked" | "awaiting-human-review" | "eligible-for-rollout-review";
  blockers: string[];
  automatedPromotionAllowed: false;
}

export function evaluateTryOnPromotionGate(
  evidence: TryOnPromotionEvidence,
): TryOnPromotionGateResult {
  const blockers: string[] = [];
  const require = (condition: boolean, code: string) => {
    if (!condition) blockers.push(code);
  };
  require(evidence.offline.testsPassed, "tests_failed");
  require(evidence.offline.lintPassed, "lint_failed");
  require(evidence.offline.deterministicCasesPassed, "deterministic_cases_failed");
  require(evidence.offline.baselineIntegrityPassed, "baseline_integrity_failed");
  require(evidence.offline.buildPassedOrNotRequired, "build_failed_or_missing");
  require(evidence.contract.httpContractPreserved, "http_contract_changed");
  require(!evidence.contract.securityRegression, "security_regression");
  require(!evidence.contract.privacyRegression, "privacy_regression");
  require(!evidence.contract.idempotencyRegression, "idempotency_regression");
  require(evidence.contract.snapshotComplete, "config_snapshot_incomplete");
  require(!evidence.contract.approvedBaselineMutationDetected, "approved_baseline_mutated");
  require(evidence.comparison.pairedInputsMatch, "comparison_inputs_mismatch");
  require(evidence.comparison.productionMetricsSufficient, "production_metrics_insufficient");
  require(evidence.comparison.successRateWithinBudget, "success_rate_regression");
  require(evidence.comparison.structuredErrorsWithinBudget, "structured_errors_regression");
  require(evidence.comparison.latencyWithinBudget, "latency_budget_exceeded");
  require(evidence.comparison.costWithinBudget, "cost_budget_exceeded");
  require(evidence.visual.criticalDefectCount === 0, "new_critical_visual_defect");
  require(!evidence.visual.positionBiasDetected, "judge_position_bias");
  require(!evidence.visual.abstainDetected, "judge_abstained");
  require(evidence.visual.judgeOutcome !== "not-run", "judge_not_run");
  require(evidence.visual.judgeOutcome !== "inconclusive", "judge_inconclusive");
  require(evidence.visual.humanReview !== "reject", "human_review_rejected");

  if (blockers.length > 0) {
    return { status: "blocked", blockers, automatedPromotionAllowed: false };
  }
  return {
    status:
      evidence.visual.humanReview === "accept"
        ? "eligible-for-rollout-review"
        : "awaiting-human-review",
    blockers: [],
    automatedPromotionAllowed: false,
  };
}

export interface TryOnIterationStopInput {
  completedIterations: number;
  consecutiveGateFailures: number;
  repeatedRootCauseCount: number;
  regression?: "test" | "contract" | "security" | "privacy" | "baseline-integrity";
  evidenceSufficient: boolean;
}

export function evaluateTryOnIterationStop(input: TryOnIterationStopInput): {
  stop: boolean;
  outcome: "continue" | "stopped" | "inconclusive";
  reasons: string[];
} {
  const reasons: string[] = [];
  if (input.regression) reasons.push(`${input.regression}_regression`);
  if (input.completedIterations >= DEFAULT_TRY_ON_AGENT_ITERATION_POLICY.maxAutomaticIterations) {
    reasons.push("maximum_iterations_reached");
  }
  if (
    input.consecutiveGateFailures >=
    DEFAULT_TRY_ON_AGENT_ITERATION_POLICY.maxConsecutiveGateFailures
  ) {
    reasons.push("consecutive_gate_failures");
  }
  if (
    input.repeatedRootCauseCount >= DEFAULT_TRY_ON_AGENT_ITERATION_POLICY.maxRepeatedRootCause
  ) {
    reasons.push("repeated_root_cause");
  }
  if (!input.evidenceSufficient) reasons.push("insufficient_evidence");
  if (reasons.length === 0) return { stop: false, outcome: "continue", reasons };
  return {
    stop: true,
    outcome: input.evidenceSufficient ? "stopped" : "inconclusive",
    reasons,
  };
}
