import { randomBytes } from "node:crypto";
import { resolveEnhancementConfig, type ResolvedEnhancementConfig } from "../enhance";
import {
  GARMENT_IMAGE_MAX_WIDTH,
  GARMENT_IMAGE_PREPROCESSING_VERSION,
} from "../images";
import type { TryOnConfigSnapshotV1, TryOnGarmentType } from "../types";
import type { ResolvedTryOnFeatureDecision } from "./feature-flags-core";
import { TARGET_MAX_WIDTH } from "../upload-constraints";
import {
  PERSON_IMAGE_JPEG_QUALITY,
  PERSON_IMAGE_PREPROCESSING_VERSION,
} from "../validation";

export const MAX_GENERATION_SEED = 2 ** 32 - 1;

export type ResolvedProviderGenerationConfig =
  | {
      providerName: "fashn";
      modelName: "tryon-v1.6";
      seed: number;
      inputs: {
        category: TryOnGarmentType;
        mode: "quality";
        garmentPhotoType: "flat-lay";
        outputFormat: "jpeg";
        outputCount: 1;
      };
    }
  | {
      providerName: "fashn-max";
      modelName: "tryon-max";
      seed: number;
      inputs: {
        generationMode: "balanced";
        resolution: "1k";
        outputFormat: "jpeg";
        outputCount: 1;
        prompt: "";
      };
    }
  | {
      providerName: "mock";
      modelName: "mock";
      seed: number;
      inputs: {
        outputFormat: "jpeg";
        outputCount: 1;
      };
    };

export interface ResolvedTryOnConfig {
  provider: ResolvedProviderGenerationConfig;
  enhancement: ResolvedEnhancementConfig;
  snapshot: TryOnConfigSnapshotV1;
}

export function isValidGenerationSeed(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_GENERATION_SEED
  );
}

export function generateGenerationSeed(): number {
  return randomBytes(4).readUInt32BE(0);
}

export function resolveGenerationSeed(seed?: number): number {
  if (seed !== undefined) {
    if (!isValidGenerationSeed(seed)) {
      throw new RangeError(`seed 必須是 0 到 ${MAX_GENERATION_SEED} 之間的整數。`);
    }
    return seed;
  }
  return generateGenerationSeed();
}

export function resolveTryOnConfig(
  providerName: string,
  seed: number,
  featureDecision?: ResolvedTryOnFeatureDecision | null,
  garmentType: TryOnGarmentType = "tops",
): ResolvedTryOnConfig {
  if (!isValidGenerationSeed(seed)) {
    throw new RangeError(`seed 必須是 0 到 ${MAX_GENERATION_SEED} 之間的整數。`);
  }

  let provider: ResolvedProviderGenerationConfig;
  if (providerName === "fashn") {
    provider = {
      providerName: "fashn",
      modelName: "tryon-v1.6",
      seed,
      inputs: {
        category: garmentType,
        mode: "quality",
        garmentPhotoType: "flat-lay",
        outputFormat: "jpeg",
        outputCount: 1,
      },
    };
  } else if (providerName === "fashn-max") {
    provider = {
      providerName: "fashn-max",
      modelName: "tryon-max",
      seed,
      inputs: {
        generationMode: "balanced",
        resolution: "1k",
        outputFormat: "jpeg",
        outputCount: 1,
        prompt: "",
      },
    };
  } else if (providerName === "mock") {
    provider = {
      providerName: "mock",
      modelName: "mock",
      seed,
      inputs: { outputFormat: "jpeg", outputCount: 1 },
    };
  } else {
    throw new Error(`無法為未知的 VTO provider 建立設定快照：${providerName}`);
  }

  const enhancement = resolveEnhancementConfig(
    providerName,
    featureDecision?.variant.enhancement,
  );
  const snapshot: TryOnConfigSnapshotV1 = {
    schemaVersion: 1,
    ...(featureDecision ? { experiment: featureDecision.snapshot } : {}),
    provider: {
      name: provider.providerName,
      modelName: provider.modelName,
      mode:
        provider.providerName === "fashn"
          ? provider.inputs.mode
          : provider.providerName === "fashn-max"
            ? provider.inputs.generationMode
            : null,
      resolution: provider.providerName === "fashn-max" ? provider.inputs.resolution : null,
      outputFormat: provider.inputs.outputFormat,
      outputCount: provider.inputs.outputCount,
    },
    generation: {
      seed,
      garmentType: provider.providerName === "fashn" ? provider.inputs.category : null,
      garmentPhotoType:
        provider.providerName === "fashn" ? provider.inputs.garmentPhotoType : null,
    },
    preprocessing: {
      personImage: {
        version: PERSON_IMAGE_PREPROCESSING_VERSION,
        maxWidth: TARGET_MAX_WIDTH,
        outputFormat: "jpeg",
        jpegQuality: PERSON_IMAGE_JPEG_QUALITY,
      },
      garmentImage: {
        version: GARMENT_IMAGE_PREPROCESSING_VERSION,
        maxWidth: GARMENT_IMAGE_MAX_WIDTH,
        outputFormat: "png",
      },
    },
    enhancement,
    prompt: {
      version: "none",
      hash: null,
      value: provider.providerName === "fashn-max" ? provider.inputs.prompt : null,
    },
  };
  return { provider, enhancement, snapshot };
}
