# Try-On Baseline Report

`try-on:report` 只讀取現有 Supabase job 與 Storage metadata，不會建立生成任務、呼叫 VTO provider、修改資料或刪除圖片。

## 執行方式

```bash
# 最近 7 天，輸出 Markdown 到 stdout
npm run try-on:report

# 明確指定半開區間 [from, to)
npm run try-on:report -- \
  --from 2026-07-10T00:00:00.000Z \
  --to 2026-07-17T00:00:00.000Z \
  --format markdown \
  --out docs/reports/try-on-baseline.md

# 同一區間的穩定 JSON
npm run try-on:report -- \
  --from 2026-07-10T00:00:00.000Z \
  --to 2026-07-17T00:00:00.000Z \
  --format json \
  --out docs/reports/try-on-baseline.json
```

同一份資料快照與相同 `--from`／`--to` 會使用穩定欄位排序，且 `generatedAt` 固定等於 `to`。報告不包含 user ID、provider job ID、圖片路徑、signed URL、request fingerprint、idempotency key 或原始 `error_message`。

## 資料來源

CLI 依下列順序選擇來源：

1. 有 `DB_URL`：以 `BEGIN TRANSACTION READ ONLY` 和 15 秒 statement timeout 查詢，可取得 job、Storage metadata、relation size 與 database size。
2. 沒有 `DB_URL`，但有 `SUPABASE_URL`／`NEXT_PUBLIC_SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`：使用唯讀 Data／Storage API；relation/database 實體容量會顯示 `N/A`。
3. 兩者都沒有：仍輸出報告骨架，但所有營運指標標示 unavailable，不會捏造為 0。

可用 `--source postgres` 或 `--source supabase` 明確限制來源。`DB_URL` 建議使用權限受限的唯讀帳號，所有憑證只能放在未提交的 `.env.local` 或執行環境。

若執行環境只有 Supabase API，但另由受信任的唯讀 SQL 工具取得 database／relation size，可用 `--db-metrics <sanitized-json>` 補入純 aggregate 容量。CLI 會驗證 relation 白名單與非負數；overlay 不得包含連線字串、ID、路徑或任何逐筆資料。

## 指標口徑

- Terminal success rate：`success / (success + failed)`。
- End-to-end success rate：`success / all created jobs`。
- Completion rate：`(success + failed) / all created jobs`。
- Submission latency：`provider_submitted_at - started_at`。
- Post-submit terminal latency：`completed_at - provider_submitted_at`，包含輪詢、結果下載、enhancement 與 Storage 寫入。
- Total terminal latency：`completed_at - started_at`。
- Recorded cost estimate 與 budget reservation 是應用程式估算／預留，不是 provider 帳單。

分母為 0 時比率顯示 `N/A`／`null`。缺少時間或時間順序錯誤的資料不會進入 percentile，會列入 excluded count。

16 個 deterministic cases 只列為離線 regression 結果，不會混入 production 成功率、延遲或成本。
