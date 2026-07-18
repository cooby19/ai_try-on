import "server-only";

import { resolveEnhancementConfig } from "../enhance";
import {
  createDeploymentControlDecision,
  parseTryOnFeatureFlagJson,
  resolveTryOnFeatureDecision,
  type ResolvedTryOnFeatureDecision,
  type TryOnFeatureProvider,
} from "./feature-flags-core";

function isProductionRuntime(): boolean {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}

export function resolveProductionTryOnFeatureDecision(input: {
  userId: string;
  requestedModel?: unknown;
  requestedProviderName: TryOnFeatureProvider;
}): ResolvedTryOnFeatureDecision {
  const provider = input.requestedProviderName;
  const rawConfig = process.env.TRY_ON_FEATURE_FLAG_CONFIG?.trim();
  if (!rawConfig) {
    return createDeploymentControlDecision({
      requestedModel: input.requestedModel,
      requestedProviderName: provider,
      enhancement: resolveEnhancementConfig(provider).provider,
    });
  }
  return resolveTryOnFeatureDecision({
    config: parseTryOnFeatureFlagJson(rawConfig),
    assignmentKey: input.userId,
    assignmentSecret: process.env.TRY_ON_FEATURE_FLAG_HMAC_SECRET,
    executionContext: "runtime",
    isProduction: isProductionRuntime(),
    requestedModel: input.requestedModel,
    requestedProviderName: provider,
    environment: process.env,
    enforceRuntimeDependencies: true,
  });
}

export type {
  ResolvedTryOnFeatureDecision,
  TryOnFeatureFlagConfigV1,
  TryOnFeatureVariant,
} from "./feature-flags-core";
