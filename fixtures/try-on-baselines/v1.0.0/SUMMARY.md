# Try-On Visual Quality Baseline v1.0.0

## Freeze summary

- Baseline ID：`try-on-v1.0.0`
- 狀態：`approved`
- Reviewer：`sihanchen`
- Reviewed at：2026-07-18T01:16:26Z
- 乾淨來源 commit：`f49407e69732889bd54608a9719ce6b75346f46a`
- Provider／模型：FASHN `tryon-v1.6`
- Enhancement：`none`
- 人工 Accept：7
- 人工 Reject：5
- Capture：12 submissions、12 success、0 Provider failure
- Recorded cost estimate：USD 0.9000；不是 Provider 實際帳單

此目錄只包含 7 個人工 Accept 的結果。Rejected 結果仍保留在不可覆寫的來源 candidate `v1.0.0-candidate.2`，但不屬於 approved regression reference。

## Approved cases

| Case ID | Seed | 初評平均 | 人工決策 |
| --- | ---: | ---: | --- |
| `v16-m01-g01-s10101` | 10101 | 4.17 | Accept |
| `v16-m01-g02-s10102` | 10102 | 4.33 | Accept |
| `v16-m01-g03-s10103` | 10103 | 4.00 | Accept |
| `v16-m02-g01-s20101` | 20101 | 4.00 | Accept |
| `v16-m02-g04-s20104` | 20104 | 4.50 | Accept |
| `v16-m01-g02-s30102` | 30102 | 4.33 | Accept |
| `v16-m01-g03-s30103` | 30103 | 4.33 | Accept |

## Rejected from the source candidate

| Case ID | 理由 |
| --- | --- |
| `v16-m01-g04-s10104` | 頸部新增深色紋樣，腰部下擺偏斜 |
| `v16-m02-g02-s20102` | 原本襯衫下擺明顯殘留 |
| `v16-m02-g03-s20103` | 原本襯衫下擺明顯殘留 |
| `v16-m01-g01-s30101` | 深色側邊區塊與服裝原圖不一致 |
| `v16-m01-g04-s30104` | 人工複核認為視覺效果太假、不及格 |

## Scope and limitations

- Workflow regression、視覺品質 baseline 與 production metrics reference 仍是三種不同證據。
- 此視覺 baseline 只有兩張符合 production preprocessing 的人物輸入；其中 `model-01` 原圖只有 387×516，且臉部已有圖像化遮罩，因此身分／臉部保真覆蓋有限。
- 四件服裝都是上衣；不代表其他品類、複雜圖案、多人、側身或高遮擋情境。
- Seed 與完整 config snapshot 已凍結，但第三方生成服務仍可能因 Provider 後端變更而出現像素差異。
- 未來比較應先檢查設定與 hash，再做人工視覺判定；不能只以輸出檔 SHA-256 不同判定品質退步。

## Version policy

- 輸入集合或評分規格變更：新 major version。
- Provider、模型、prompt 或 preprocessing 變更：至少新 minor version。
- 只修正不影響內容與決策的 metadata：patch version。
- 不提供自動接受或 `--update`；任何變更都必須建立新 versioned 目錄並審查 diff。
