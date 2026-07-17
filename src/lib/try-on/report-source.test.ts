import { describe, expect, it } from "vitest";
import {
  applyDatabaseMetricsOverlay,
  type LoadedReportData,
} from "./report-source";

function source(): LoadedReportData {
  return {
    source: "supabase-api",
    availability: {
      jobs: true,
      storage: true,
      relationCounts: true,
      relationSizes: false,
      databaseSize: false,
      requestEvents: false,
      actualProviderCost: false,
    },
    unavailableReasons: [
      "未提供 DB_URL：Supabase API fallback 無法取得 relation size 與 database size。",
      "沒有 provider billing data：actual provider cost unavailable。",
    ],
    jobs: [],
    storageObjects: [],
    relations: [
      { name: "public.try_on_jobs", rowCount: 40, tableBytes: null, indexBytes: null, totalBytes: null },
    ],
    databaseSizeBytes: null,
  };
}

describe("database metrics aggregate overlay", () => {
  it("只補入白名單 aggregate size，不改動 row count", () => {
    const result = applyDatabaseMetricsOverlay(source(), {
      databaseSizeBytes: 4096,
      relations: [
        { name: "public.try_on_jobs", tableBytes: 100, indexBytes: 50, totalBytes: 150 },
      ],
    });

    expect(result).toMatchObject({
      source: "supabase-api+readonly-sql",
      databaseSizeBytes: 4096,
      availability: { databaseSize: true, relationSizes: true },
      relations: [
        { name: "public.try_on_jobs", rowCount: 40, tableBytes: 100, indexBytes: 50, totalBytes: 150 },
      ],
    });
    expect(result.unavailableReasons).not.toContain(
      "未提供 DB_URL：Supabase API fallback 無法取得 relation size 與 database size。",
    );
  });

  it("拒絕未知 relation 或負容量", () => {
    expect(() => applyDatabaseMetricsOverlay(source(), {
      databaseSizeBytes: 4096,
      relations: [{ name: "public.secrets", tableBytes: 1, indexBytes: 1, totalBytes: 2 }],
    })).toThrow("不支援的 relation");
    expect(() => applyDatabaseMetricsOverlay(source(), {
      databaseSizeBytes: -1,
      relations: [],
    })).toThrow("databaseSizeBytes 必須是非負數");
  });
});
