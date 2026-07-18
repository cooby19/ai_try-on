# Try-On 品質 Baseline

本文件說明三種彼此獨立的基準，避免把程式正確、營運指標與圖片品質混為一談。

## 三種基準

| 基準 | 回答的問題 | 目前來源 | 是否代表視覺品質 |
| --- | --- | --- | --- |
| Workflow regression baseline | 相同輸入是否得到相同結構化結果與 trace？ | `fixtures/try-on-cases/cases.v1.json` | 否 |
| Visual quality baseline | 人物、服裝、幾何與影像品質是否經人工接受？ | versioned baseline 中的真實輸入／輸出與 review | 是 |
| Production metrics reference | 線上成功率、錯誤、延遲、成本估算與 Storage／DB 狀況如何？ | `docs/reports/try-on-baseline-*.{json,md}` | 否 |

固定案例使用 runner 內嵌 bytes 和 mock Provider。即使 `npm run try-on:cases` 顯示 16/16 passed，也只能證明 Workflow regression 通過。Production report 的 recorded cost 是程式估算，不是 Provider 實際帳單。

## Candidate 與 Approved

- `candidate`：資料與 hash 已整理，可供審查，但尚未獲得人工核准。
- `approved`：只包含 reviewer 明確標記為 Accept 的真實視覺案例，而且核准時的 Git worktree 必須乾淨。
- Reject／Needs rerun 不得進入 approved baseline。
- 不提供自動接受或 `--update`；修改 manifest、輸入、輸出、評分或 expected value 都必須留下可審查的 Git diff。

Verifier 預設檢查 candidate 的 schema、檔案、SHA-256、圖片 metadata、Workflow 案例完整性與核准狀態：

```bash
npm run try-on:baseline:verify
```

需要正式 release gate 時加上 `--require-approved`。Candidate 預期會在此模式失敗：

```bash
npm run try-on:baseline:verify -- --require-approved
```

Verifier 完全離線且只讀，不會呼叫 Provider、DB 或 Storage，也不會修改 hash 或 baseline。

## 人工評分規則

每個項目使用 1～5 分：1 為嚴重失真，3 為可接受下限，5 為幾乎沒有可見問題。

1. 身分／臉部保真。
2. 服裝款式、顏色、圖案與材質保真。
3. 身體與服裝幾何合理性。
4. 遮擋、手臂、頭髮與邊界品質。
5. 光影與場景一致性。
6. Artifact 控制；5 分表示沒有明顯 artifact，1 分表示嚴重破圖。

Accept 必須同時符合：六項皆至少 3 分、平均至少 4.0、沒有 critical defect，而且 reviewer 明確選擇 Accept。人物身分錯置、服裝主體錯誤、裸露／安全問題、多餘或缺失肢體、無法辨識的嚴重破圖，都屬 critical defect。資訊不足或疑似暫時性生成問題使用 Needs rerun；明確未達門檻使用 Reject。

## 升版規則

- 輸入案例集合或人工評分規格改變：建立新的 major version。
- Provider、模型、prompt 或 preprocessing 改變：至少建立新的 minor version。
- 只修正不影響輸入、輸出或判定的 metadata：建立 patch version。
- Candidate 可使用 `-candidate.N` 後綴；核准時建立新的 versioned approved 目錄，不覆寫舊 candidate 或舊 baseline。

## 核准流程

1. 在乾淨 commit 上準備真實輸入、Provider 結果與完整 config snapshot。
2. 產生 candidate manifest 和逐案 review 文件。
3. Reviewer 直接查看 versioned 目錄中的本機檔案，依固定規則填寫分數與決策。
4. 只有收到明確核准後，才建立新的 approved 目錄並填入 reviewer／reviewedAt。
5. 重新計算所有 hash，執行 tests、lint、deterministic cases 與 `--require-approved` verifier。

任何缺少真實輸出、完整設定或人工決策的 baseline 都必須保留為 candidate。
