# Try-On Baseline Report

## Executive summary

- 資料區間：2026-07-10T07:15:50.000Z 至 2026-07-17T07:15:50.000Z（[from, to)，UTC）
- 資料來源：supabase-api+readonly-sql
- Jobs：15；terminal success rate：86.67%
- Total terminal latency P95：N/A
- Recorded cost estimate：USD 0.9025；actual provider cost：N/A
- Storage 已知容量：5.21 MiB
- Database size：13.00 MiB

## Coverage／資料品質

- 產生時間：2026-07-17T07:15:50.000Z
- 台北區間：2026-07-10T15:15:50+08:00 至 2026-07-17T15:15:50+08:00
- Window jobs：15；all-time jobs：40

Unavailable：

- 沒有 provider billing data：actual provider cost unavailable。
- 沒有 request-level event：建 job 前的拒絕 unavailable。

## Success

| Created | Pending | Processing | Success | Failed | Terminal success | End-to-end success | Completion |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 15 | 0 | 0 | 13 | 2 | 86.67% | 86.67% | 100.00% |

超過 120 分鐘未終止候選：0

依 provider：

| Provider | Created | Success | Failed | Pending | Processing | Terminal success |
| --- | --- | --- | --- | --- | --- | --- |
| fashn | 10 | 8 | 2 | 0 | 0 | 80.00% |
| fashn-max | 1 | 1 | 0 | 0 | 0 | 100.00% |
| mock | 4 | 4 | 0 | 0 | 0 | 100.00% |

依 UTC 日期：

| UTC day | Created | Success | Failed | Pending | Processing | Terminal success |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-07-10 | 3 | 3 | 0 | 0 | 0 | 100.00% |
| 2026-07-11 | 4 | 4 | 0 | 0 | 0 | 100.00% |
| 2026-07-13 | 5 | 3 | 2 | 0 | 0 | 60.00% |
| 2026-07-17 | 3 | 3 | 0 | 0 | 0 | 100.00% |

依 config snapshot schema version：

| Schema version | Created | Success | Failed | Pending | Processing | Terminal success |
| --- | --- | --- | --- | --- | --- | --- |
| legacy | 15 | 13 | 2 | 0 | 0 | 86.67% |

## Errors

| Type | Code | HTTP | Provider | Count | Share of failed |
| --- | --- | --- | --- | --- | --- |
| unclassified | unclassified | N/A | fashn | 2 | 100.00% |

建 job 前的驗證、授權、商品查詢與 quota 拒絕沒有 request-level event，因此不在此表內，不能視為 0。

## Latency

| Provider | Status | Metric | Valid | Excluded | Min | Avg | P50 | P95 | Max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | all | submission | 0 | 15 | N/A | N/A | N/A | N/A | N/A |
| all | all | post-submit terminal | 0 | 15 | N/A | N/A | N/A | N/A | N/A |
| all | all | total terminal | 0 | 15 | N/A | N/A | N/A | N/A | N/A |
| fashn | all | submission | 0 | 10 | N/A | N/A | N/A | N/A | N/A |
| fashn | all | post-submit terminal | 0 | 10 | N/A | N/A | N/A | N/A | N/A |
| fashn | all | total terminal | 0 | 10 | N/A | N/A | N/A | N/A | N/A |
| fashn | success | submission | 0 | 8 | N/A | N/A | N/A | N/A | N/A |
| fashn | success | post-submit terminal | 0 | 8 | N/A | N/A | N/A | N/A | N/A |
| fashn | success | total terminal | 0 | 8 | N/A | N/A | N/A | N/A | N/A |
| fashn | failed | submission | 0 | 2 | N/A | N/A | N/A | N/A | N/A |
| fashn | failed | post-submit terminal | 0 | 2 | N/A | N/A | N/A | N/A | N/A |
| fashn | failed | total terminal | 0 | 2 | N/A | N/A | N/A | N/A | N/A |
| fashn-max | all | submission | 0 | 1 | N/A | N/A | N/A | N/A | N/A |
| fashn-max | all | post-submit terminal | 0 | 1 | N/A | N/A | N/A | N/A | N/A |
| fashn-max | all | total terminal | 0 | 1 | N/A | N/A | N/A | N/A | N/A |
| fashn-max | success | submission | 0 | 1 | N/A | N/A | N/A | N/A | N/A |
| fashn-max | success | post-submit terminal | 0 | 1 | N/A | N/A | N/A | N/A | N/A |
| fashn-max | success | total terminal | 0 | 1 | N/A | N/A | N/A | N/A | N/A |
| mock | all | submission | 0 | 4 | N/A | N/A | N/A | N/A | N/A |
| mock | all | post-submit terminal | 0 | 4 | N/A | N/A | N/A | N/A | N/A |
| mock | all | total terminal | 0 | 4 | N/A | N/A | N/A | N/A | N/A |
| mock | success | submission | 0 | 4 | N/A | N/A | N/A | N/A | N/A |
| mock | success | post-submit terminal | 0 | 4 | N/A | N/A | N/A | N/A | N/A |
| mock | success | total terminal | 0 | 4 | N/A | N/A | N/A | N/A | N/A |

post-submit terminal latency 包含輪詢、下載、enhancement 與 Storage 寫入，不是純 provider 執行時間。

## Cost

- Recorded cost estimate：USD 0.9025
- Budget reservation：USD 0.9150
- Average per created job：USD 0.0602
- Average successful-job estimate：USD 0.0579
- Estimated cost per successful result（含失敗估算）：USD 0.0694
- Actual provider cost：N/A（沒有 billing data）

| Provider | Jobs | Recorded estimate | Reservation |
| --- | --- | --- | --- |
| fashn | 10 | USD 0.7525 | USD 0.7650 |
| fashn-max | 1 | USD 0.1500 | USD 0.1500 |
| mock | 4 | USD 0.0000 | USD 0.0000 |

依 status：

| Status | Jobs | Recorded estimate | Reservation |
| --- | --- | --- | --- |
| failed | 2 | USD 0.1500 | USD 0.1525 |
| success | 13 | USD 0.7525 | USD 0.7625 |

依 UTC 日期：

| UTC day | Jobs | Recorded estimate | Reservation |
| --- | --- | --- | --- |
| 2026-07-10 | 3 | USD 0.1500 | USD 0.1500 |
| 2026-07-11 | 4 | USD 0.0750 | USD 0.0750 |
| 2026-07-13 | 5 | USD 0.4500 | USD 0.4575 |
| 2026-07-17 | 3 | USD 0.2275 | USD 0.2325 |

Mock／付費 provider：

| Provider class | Jobs | Recorded estimate | Reservation |
| --- | --- | --- | --- |
| mock | 4 | USD 0.0000 | USD 0.0000 |
| paid-provider | 11 | USD 0.9025 | USD 0.9150 |

## Storage

| Bucket | Objects | Known bytes | Avg | .jpg | .upload | Referenced | Unreferenced candidates | Missing refs | Missing size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| person-uploads | 92 | 3.32 MiB | 36.98 KiB | 79 | 13 | 34 | 45 | 0 | 0 |
| try-on-results | 33 | 1.88 MiB | 58.48 KiB | 33 | 0 | 33 | 0 | 0 | 0 |

.upload 為 raw upload／tombstone，已獨立統計且不視為 orphan；候選只供人工複核，不會自動刪除。

## Database

- Overall database size：13.00 MiB
- All-time jobs：40；legacy jobs：40
- Structured error coverage：0.00%
- Config snapshot coverage：0.00%
- Seed coverage：0.00%
- Idempotency usage：0.00%

Lifecycle field coverage：

| Field | Present | Total | Coverage |
| --- | --- | --- | --- |
| started_at | 0 | 40 | 0.00% |
| provider_submitted_at | 0 | 40 | 0.00% |
| completed_at | 0 | 40 | 0.00% |
| last_polled_at | 0 | 40 | 0.00% |

| Relation | Rows | Table | Indexes | Total |
| --- | --- | --- | --- | --- |
| public.order_items | 11 | 8.00 KiB | 64.00 KiB | 80.00 KiB |
| public.orders | 13 | 8.00 KiB | 64.00 KiB | 80.00 KiB |
| public.product_variants | 17 | 8.00 KiB | 48.00 KiB | 64.00 KiB |
| public.products | 4 | 8.00 KiB | 16.00 KiB | 32.00 KiB |
| public.try_on_feedback | 14 | 8.00 KiB | 16.00 KiB | 32.00 KiB |
| public.try_on_jobs | 40 | 32.00 KiB | 72.00 KiB | 136.00 KiB |
| public.users | 36 | 8.00 KiB | 16.00 KiB | 32.00 KiB |

## Deterministic regression cases

離線固定案例：16/16 passed，0 failed。這是 Workflow regression 結果，不是 production 指標。

## Limitations

- 固定案例只代表離線 Workflow 回歸結果，不是 production 成功率、延遲或成本。
- post-submit terminal latency 包含輪詢間隔、結果下載、enhancement 與 Storage 寫入，不是純 provider execution time。
- cost_estimate 與 budget_reservation 是程式記錄的估算／預留，不是 provider 實際帳單；pre-submit failure 也可能已有估算值。
- try_on_jobs 不涵蓋建 job 前的 authentication、input validation、product lookup 或 quota rejection。
- Storage 未引用與缺失數字只是 aggregate 候選；.upload 是 raw upload／tombstone，沒有被當作 orphan。

## Recommended next actions

- Terminal success rate 低於 90%，但失敗尚未分類；先確認新版 structured error 寫入後再定位原因。
- 人工複核 Storage 未引用／缺失候選；本報表不會自動刪除任何物件。
- 確認 reproducibility migration 已部署，並用新建 job 驗證 config snapshot、seed、生命週期時間與結構化錯誤開始寫入。
- 若要涵蓋建 job 前的驗證、授權與 quota 拒絕，需另設 request-level event／log 指標。
