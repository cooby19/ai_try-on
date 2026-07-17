import { describe, expect, it } from "vitest";
import {
  buildBaselineReport,
  canonicalReportJson,
  percentile,
  renderBaselineMarkdown,
  type BaselineReportInput,
  type ReportJobRow,
} from "./reporting";

function job(overrides: Partial<ReportJobRow> = {}): ReportJobRow {
  return {
    provider: "fashn",
    status: "success",
    cost_estimate: 0.075,
    budget_reservation: 0.075,
    config_snapshot: { schemaVersion: 1 },
    seed: 42,
    started_at: "2026-07-16T00:00:00.000Z",
    provider_submitted_at: "2026-07-16T00:00:01.000Z",
    completed_at: "2026-07-16T00:00:11.000Z",
    last_polled_at: "2026-07-16T00:00:10.000Z",
    error_type: null,
    error_code: null,
    provider_http_status: null,
    idempotency_key: null,
    created_at: "2026-07-16T00:00:00.000Z",
    person_image_url: "user/person-1.jpg",
    result_image_url: "user/result-1.jpg",
    ...overrides,
  };
}

function input(jobs: ReportJobRow[] | null): BaselineReportInput {
  return {
    generatedAt: "2026-07-17T00:00:00.000Z",
    from: "2026-07-10T00:00:00.000Z",
    to: "2026-07-17T00:00:00.000Z",
    source: "postgres",
    availability: {
      jobs: jobs !== null,
      storage: true,
      relationCounts: true,
      relationSizes: true,
      databaseSize: true,
      requestEvents: false,
      actualProviderCost: false,
    },
    unavailableReasons: [],
    jobs,
    storageObjects: [
      { bucketId: "person-uploads", name: "user/person-1.jpg", sizeBytes: 100 },
      { bucketId: "person-uploads", name: "user/person-2.jpg", sizeBytes: 200 },
      { bucketId: "person-uploads", name: "user/person-1.upload", sizeBytes: 1 },
      { bucketId: "try-on-results", name: "user/result-1.jpg", sizeBytes: 300 },
      { bucketId: "try-on-results", name: "user/result-2.jpg", sizeBytes: null },
    ],
    relations: [
      { name: "public.try_on_jobs", rowCount: jobs?.length ?? null, tableBytes: 1000, indexBytes: 500, totalBytes: 1500 },
    ],
    databaseSizeBytes: 4096,
    deterministicCases: { total: 16, passed: 16, failed: 0 },
  };
}

describe("Try-On baseline report metrics", () => {
  it("以明確分母計算成功率、完成率與成本", () => {
    const jobs = [
      job(),
      job({
        status: "failed",
        cost_estimate: 0.15,
        budget_reservation: 0.15,
        started_at: "2026-07-16T00:00:03.000Z",
        provider_submitted_at: "2026-07-16T00:00:04.000Z",
        completed_at: "2026-07-16T00:00:02.000Z",
        error_type: "provider_rejected",
        error_code: "CONTENT_REJECTED",
        provider_http_status: 422,
        person_image_url: "user/missing-person.jpg",
        result_image_url: null,
      }),
      job({
        status: "processing",
        cost_estimate: 0,
        budget_reservation: 0,
        provider: "mock",
        started_at: "2026-07-16T20:00:00.000Z",
        provider_submitted_at: "2026-07-16T20:00:01.000Z",
        completed_at: null,
        last_polled_at: "2026-07-16T20:00:02.000Z",
        person_image_url: null,
        result_image_url: null,
      }),
    ];
    const report = buildBaselineReport(input(jobs));

    expect(report.success).toMatchObject({
      created: 3,
      terminal: 2,
      terminalSuccessRate: 0.5,
      endToEndSuccessRate: 1 / 3,
      completionRate: 2 / 3,
    });
    expect(report.cost).toMatchObject({
      recordedCostEstimate: 0.225,
      averagePerCreatedJob: 0.075,
      averageSuccessfulJobEstimate: 0.075,
      estimatedCostPerSuccessfulResult: 0.225,
      actualProviderCost: null,
    });
    expect(report.errors).toEqual([
      expect.objectContaining({
        errorType: "provider_rejected",
        errorCode: "CONTENT_REJECTED",
        count: 1,
        shareOfFailedJobs: 1,
      }),
    ]);
  });

  it("percentile 使用線性插值，並排除 null 與負延遲", () => {
    expect(percentile([0, 10], 0.5)).toBe(5);
    expect(percentile([0, 10], 0.95)).toBe(9.5);
    expect(percentile([], 0.95)).toBeNull();

    const report = buildBaselineReport(input([
      job(),
      job({
        status: "failed",
        started_at: "2026-07-16T00:00:03.000Z",
        provider_submitted_at: "2026-07-16T00:00:02.000Z",
        completed_at: "2026-07-16T00:00:01.000Z",
      }),
      job({ status: "processing", provider_submitted_at: null, completed_at: null }),
    ]));
    const overall = report.latency?.[0];

    expect(overall?.submission).toMatchObject({ validSampleCount: 1, excludedCount: 2, p95Ms: 1000 });
    expect(overall?.totalTerminal).toMatchObject({ validSampleCount: 1, excludedCount: 1, p95Ms: 11000 });
  });

  it("空分母輸出 null，不誤報為 0%", () => {
    const report = buildBaselineReport(input([]));

    expect(report.success).toMatchObject({
      terminalSuccessRate: null,
      endToEndSuccessRate: null,
      completionRate: null,
    });
    expect(report.cost).toMatchObject({
      averagePerCreatedJob: null,
      averageSuccessfulJobEstimate: null,
      estimatedCostPerSuccessfulResult: null,
    });
  });

  it("Storage 將 .upload 獨立分類，且只輸出 aggregate 候選", () => {
    const report = buildBaselineReport(input([
      job(),
      job({
        status: "failed",
        person_image_url: "user/missing-person.jpg",
        result_image_url: null,
      }),
    ]));
    const person = report.storage?.find((bucket) => bucket.bucketId === "person-uploads");
    const result = report.storage?.find((bucket) => bucket.bucketId === "try-on-results");

    expect(person).toMatchObject({
      objectCount: 3,
      formalJpgCount: 2,
      rawUploadOrTombstoneCount: 1,
      referencedObjectCount: 1,
      unreferencedCandidateCount: 1,
      missingReferencedObjectCount: 1,
    });
    expect(result).toMatchObject({
      objectCount: 2,
      referencedObjectCount: 1,
      unreferencedCandidateCount: 1,
      missingSizeMetadataCount: 1,
    });
    expect(JSON.stringify(report.storage)).not.toContain("missing-person");
  });

  it("辨識 legacy coverage，且 Markdown／JSON 不含敏感逐筆欄位", () => {
    const reportInput = input([
      job(),
      job({
        config_snapshot: {},
        seed: null,
        started_at: null,
        provider_submitted_at: null,
        completed_at: null,
        last_polled_at: null,
        idempotency_key: "secret-key-never-rendered",
        person_image_url: "private/path-never-rendered.jpg",
      }),
    ]);
    const report = buildBaselineReport(reportInput);
    const markdown = renderBaselineMarkdown(report);
    const json = canonicalReportJson(report);

    expect(report.database).toMatchObject({
      allTimeJobCount: 2,
      legacyJobCount: 1,
      configSnapshotCoverage: { numerator: 1, denominator: 2, rate: 0.5 },
      seedCoverage: { numerator: 1, denominator: 2, rate: 0.5 },
      idempotencyUsage: { numerator: 1, denominator: 2, rate: 0.5 },
    });
    expect(markdown).not.toContain("secret-key-never-rendered");
    expect(markdown).not.toContain("private/path-never-rendered");
    expect(json).not.toContain("secret-key-never-rendered");
    expect(json).not.toContain("private/path-never-rendered");
    expect(canonicalReportJson({ z: 1, a: 2 })).toBe('{\n  "a": 2,\n  "z": 1\n}\n');
  });

  it("來源不可用時使用 null 與原因，不把缺資料當成零", () => {
    const unavailable = input(null);
    unavailable.source = "unavailable";
    unavailable.storageObjects = null;
    unavailable.availability.jobs = false;
    unavailable.availability.storage = false;
    unavailable.unavailableReasons = ["資料來源不可用"];
    const report = buildBaselineReport(unavailable);

    expect(report.coverage.windowJobCount).toBeNull();
    expect(report.success).toBeNull();
    expect(report.storage).toBeNull();
    expect(report.unavailableReasons).toEqual(["資料來源不可用"]);
  });
});
