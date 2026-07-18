# Try-On Baseline Candidate Review

## Candidate 資訊

- Baseline ID：`try-on-v1.0.0-candidate.2`
- 狀態：`candidate`
- Provider／模型：FASHN `tryon-v1.6`
- Capture：12 submissions、12 success、0 Provider failure
- Recorded cost estimate：USD 0.9000；不是 Provider 實際帳單
- Enhancement：`none`
- 人工 reviewer／reviewedAt／decision：全部未填

本文件的分數是 Codex 依固定 rubric 做的**輔助初評**，不是人工批准。只有使用者親自查看輸入與結果，明確回覆 Accept 的案例，才能在下一個乾淨 commit 上建立 approved baseline。

## 輸入盤點

- `model-01`：387×516，符合 production 最低寬度；輸出解析度受原圖限制為 387×516。
- `model-02`：4562×6843，production preprocessing 後送入 FASHN；輸出為 864×1296。
- `model-03-lowres-excluded`：183×275，低於 `normalizePersonImage` 的 320px 最低寬度，未送 Provider、未產生成本。
- 服裝：薄荷綠長袖 sweatshirt、藍色 T-shirt、灰色 T-shirt、橘色 T-shirt。
- 案例矩陣：兩張合格人物照 × 四件服裝共 8 案，另以 `model-01` 對四件服裝使用第二組固定 seed 共 4 案。

## 評分門檻

六項各 1～5 分：身分／臉部、服裝保真、幾何合理、遮擋／邊界、光影／場景、Artifact 控制。Accept 必須每項至少 3、平均至少 4.0、沒有 critical defect，並由人工明確確認。

## Codex 輔助初評

| Case ID | 身分 | 服裝 | 幾何 | 邊界 | 光影 | Artifact | 平均 | Critical | 初評建議 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `v16-m01-g01-s10101` | 5 | 4 | 4 | 4 | 4 | 4 | 4.17 | No | Accept candidate |
| `v16-m01-g02-s10102` | 5 | 5 | 4 | 4 | 4 | 4 | 4.33 | No | Accept candidate |
| `v16-m01-g03-s10103` | 5 | 4 | 4 | 4 | 4 | 3 | 4.00 | No | Accept candidate |
| `v16-m01-g04-s10104` | 5 | 4 | 3 | 3 | 4 | 2 | 3.50 | No | Reject |
| `v16-m02-g01-s20101` | 5 | 4 | 4 | 4 | 4 | 3 | 4.00 | No | Accept candidate |
| `v16-m02-g02-s20102` | 5 | 4 | 3 | 4 | 4 | 3 | 3.83 | No | Reject |
| `v16-m02-g03-s20103` | 5 | 4 | 3 | 4 | 4 | 3 | 3.83 | No | Reject |
| `v16-m02-g04-s20104` | 5 | 5 | 5 | 4 | 4 | 4 | 4.50 | No | Accept candidate |
| `v16-m01-g01-s30101` | 5 | 3 | 4 | 3 | 4 | 3 | 3.67 | No | Reject |
| `v16-m01-g02-s30102` | 5 | 5 | 4 | 4 | 4 | 4 | 4.33 | No | Accept candidate |
| `v16-m01-g03-s30103` | 5 | 5 | 4 | 4 | 4 | 4 | 4.33 | No | Accept candidate |
| `v16-m01-g04-s30104` | 5 | 5 | 4 | 4 | 4 | 4 | 4.33 | No | Accept candidate |

初評統計：8 個 Accept candidate、4 個 Reject。這不是人工 acceptance rate，也不能寫成 production success rate。

## 逐案觀察

- `v16-m01-g01-s10101`：色彩與 sweatshirt 特徵保留；袖口被生成為較短、向上堆疊，但整體自然。
- `v16-m01-g02-s10102`：藍色與橫向材質層次清楚；手插口袋處邊界可接受。
- `v16-m01-g03-s10103`：灰色上衣自然，但領口與下擺仍可見些微原衣層次。
- `v16-m01-g04-s10104`：頸部新增原圖沒有的深色紋樣，腰部下擺偏斜；Artifact 分數低於門檻。
- `v16-m02-g01-s20101`：長袖 sweatshirt 的版型、顏色合理；領口附近有類似鏈條／原衣殘留的細節。
- `v16-m02-g02-s20102`：藍色與紋理保留，但原本襯衫下擺明顯留在 T-shirt 下方，未完整替換。
- `v16-m02-g03-s20103`：輪廓自然，但原本襯衫下擺同樣殘留，平均未達 4.0。
- `v16-m02-g04-s20104`：服裝色彩、長度、幾何與人物保真最好，沒有明顯嚴重 artifact。
- `v16-m01-g01-s30101`：第二個 seed 生成出深色側邊區塊，與服裝原圖不一致。
- `v16-m01-g02-s30102`：輪廓、顏色、材質穩定；與第一 seed 都達門檻。
- `v16-m01-g03-s30103`：比第一 seed 更乾淨，領口與下擺合理。
- `v16-m01-g04-s30104`：沒有第一 seed 的頸部紋樣，整體自然且穩定。

## 人工決策表（請使用者填寫）

請查看同目錄的 `GALLERY.html`，再回覆每案或整批決策。此表現在刻意留空。

| Case ID | 人工決策 | Reviewer | Reviewed at | 備註 |
| --- | --- | --- | --- | --- |
| `v16-m01-g01-s10101` |  |  |  |  |
| `v16-m01-g02-s10102` |  |  |  |  |
| `v16-m01-g03-s10103` |  |  |  |  |
| `v16-m01-g04-s10104` |  |  |  |  |
| `v16-m02-g01-s20101` |  |  |  |  |
| `v16-m02-g02-s20102` |  |  |  |  |
| `v16-m02-g03-s20103` |  |  |  |  |
| `v16-m02-g04-s20104` |  |  |  |  |
| `v16-m01-g01-s30101` |  |  |  |  |
| `v16-m01-g02-s30102` |  |  |  |  |
| `v16-m01-g03-s30103` |  |  |  |  |
| `v16-m01-g04-s30104` |  |  |  |  |

建議優先人工檢查四個初評 Reject 案例，再抽查八個 Accept candidate。即使同意 Codex 初評，也需要使用者明確說明核准哪些 case ID；不得直接把此 candidate 改成 approved。
