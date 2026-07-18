# Try-On Baseline Candidate Review

## Candidate 資訊

- Baseline ID：`try-on-v1.0.0-candidate.1`
- 狀態：`candidate`
- 建立時間：2026-07-17T08:12:49Z
- Git commit：`80a96b2ed9ca56e68281806454cfe7c36d3fc16f`
- Worktree：dirty（準備 candidate 前已有未追蹤的 `supabase/snippets/`）
- 人工 reviewer：未填
- 人工 reviewedAt：未填
- 人工 decision：未填

此 candidate 不符合 approved 條件，不得視為已凍結的視覺品質 baseline。

## 盤點結論

目前 repo 中可辨識的真實圖片素材只有：

| 用途 | 檔案 | 尺寸 | 狀態 |
| --- | --- | --- | --- |
| 人物輸入候選 | `public/samples/sample-person.jpg` | 800×1000 JPEG | 有輸入，沒有對應真實 Provider 輸出 |
| 服裝輸入候選 | `public/garments/uniqlo-gray-tee.jpg` | 1200×1600 JPEG | 有輸入，沒有對應真實 Provider 輸出 |

沒有找到同時具備真實輸入、真實 Provider 輸出、seed 與完整 config snapshot 的案例。因此目前可進行人工視覺審核的案例數是 **0**，不得用 mock bytes、placeholder 或 16/16 Workflow pass 代替。

## Workflow regression baseline（16 個，非視覺審核）

以下案例的 definition、expected output 與 trace 已各自記錄 SHA-256；它們只驗證編排行為。

| Case ID | 範圍 | 視覺審核資格 |
| --- | --- | --- |
| `start-v16-explicit-seed-success` | v1.6 submit／snapshot／seed | 無：沒有真實輸出圖 |
| `start-max-explicit-seed-success` | Max submit／snapshot／seed | 無：沒有真實輸出圖 |
| `start-idempotent-generated-seed-and-replay` | idempotent replay | 無：沒有真實輸出圖 |
| `reject-missing-input` | input validation | 不適用 |
| `reject-unsupported-model` | model validation | 不適用 |
| `reject-unowned-person-image` | ownership validation | 不適用 |
| `reject-invalid-seed` | seed validation | 不適用 |
| `reject-invalid-idempotency-key` | idempotency validation | 不適用 |
| `reject-product-not-found-or-inactive` | product lookup | 不適用 |
| `reject-quota-without-provider-call` | quota rejection | 不適用 |
| `fail-person-image-read` | structured input error | 不適用 |
| `fail-garment-image-read` | structured garment error | 不適用 |
| `fail-provider-submit-http-503` | structured Provider error | 不適用 |
| `conflict-same-key-different-intent` | idempotency conflict | 不適用 |
| `poll-processing-then-success` | poll／result persistence | 無：result 是 runner bytes，不是真實圖片 |
| `poll-provider-rejected` | terminal Provider rejection | 不適用 |

## 視覺評分表

目前沒有符合資格的輸出，因此本節沒有預填案例或分數。取得真實輸出後，每個案例必須複製以下表格，且 reviewer 必須親自填寫。

| Case ID | 身分／臉部 | 服裝保真 | 幾何合理 | 遮擋／邊界 | 光影／場景 | Artifact 控制 | Critical defect | 決策 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `<待建立>` | 1–5 | 1–5 | 1–5 | 1–5 | 1–5 | 1–5 | Yes／No | Accept／Reject／Needs rerun |

逐案還必須記錄：

- 人物輸入、服裝輸入與輸出檔案的 repo-relative path。
- Provider、模型、seed、prompt version/hash 與完整 config snapshot。
- Reviewer、reviewedAt 與具體備註。
- 六項平均分；Accept 必須每項至少 3、平均至少 4.0，且沒有 critical defect。

## Checkpoint A blockers

1. 缺少可供人工檢查的真實 Provider 結果圖。
2. 現有 16 個固定案例不是 12～16 個視覺案例，只是 Workflow 情境。
3. 只有一組可能的真實輸入素材，尚未形成有代表性的固定視覺案例集合。
4. Worktree dirty；即使日後完成 review，也不能直接將此 candidate 改成 approved。
5. Reviewer、reviewedAt、分數與決策必須由人工提供，不能由程式或代理代填。

## 需要人工檢查的檔案

目前沒有生成結果圖可供品質判定。Checkpoint A 可先人工檢查：

- `fixtures/try-on-baselines/v1.0.0-candidate.1/manifest.json`：確認盤點、hash、設定與 blocker 是否正確。
- `fixtures/try-on-baselines/v1.0.0-candidate.1/REVIEW.md`：確認評分維度和門檻是否符合產品要求。
- `public/samples/sample-person.jpg` 與 `public/garments/uniqlo-gray-tee.jpg`：只確認是否適合作為未來視覺案例輸入；不能對其做輸出品質 Accept。

下一步需由受信任流程提供真實輸出與完整設定，建立新的 candidate visual cases，再進行逐案人工 Accept／Reject／Needs rerun。不得覆寫這個 candidate 目錄。
