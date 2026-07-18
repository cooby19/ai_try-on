# Try-On Coding Agent 自動迭代規範

本規範讓 Agent 自動完成免費、離線、可回復的實驗工作；付費生成、外部寫入、baseline 核准、production rollout 與 deployment 永遠保留給人。`src/lib/try-on/iteration-policy.ts` 把 promotion gate 與停止條件實作成可單元測試的規則。

## 不可變原則

- 每輪只宣告一個可驗證假設與一個主要變因。
- 每個 candidate 使用新的不可變 ID；不得用相同 ID 改內容。
- control 與 candidate artifact 分開寫入新路徑，禁止覆寫、隱藏或刪除不利結果。
- deterministic regression、production metrics、人工 visual baseline、blind AI Judge 與 rollout state 是五種不同證據，不得合成單一分數。
- AI Judge 只提供輔助證據；challenger 勝出最多進入 `awaiting-human-review`。
- Agent 不得自行部署、開啟 canary／on、提高百分比、接受成本／延遲退化，或建立／核准 baseline。

## 狀態流程

```text
proposed
→ implemented
→ offline-verified
→ candidate-captured
→ blind-judged
→ human-reviewed
→ approved | rejected
```

狀態不得跳級。未獲外部 API 授權時，流程最多到 `offline-verified`；沒有真實 paired images 時不得標為 `candidate-captured`；AI Judge inconclusive／abstain／position bias 不得標為勝出；只有人工 reviewer 能寫入 `human-reviewed` 與最終決策。

## 每輪紀錄

開始前建立新 candidate report，至少記錄：

- 單一假設、主要變因、candidate ID、control ID。
- 基準 commit、worktree 狀態與修改檔案。
- Feature Flag config、解析後 snapshot、案例版本與 seed 集合。
- generation config／preprocessing／prompt／Judge 的 version 與 hash。
- 預先宣告的成功率、錯誤、p95 latency、單次成本預算與 critical defect 門檻。
- 本輪編號、累積外部 API 花費與前兩輪 root cause。

報告只保存 aggregate 或去識別資訊。不得輸出 API key、HMAC secret、user ID、逐筆 job/provider ID、Storage path、signed URL、idempotency key、圖片 base64 或原始 provider 錯誤。

## 免費離線 gate

每輪按順序執行：

```bash
npm run test
npm run try-on:cases -- --json
npm run try-on:baseline:verify
npm run lint
```

修改 Next.js 行為、module boundary、型別或 build 邊界時再執行：

```bash
npm run build
```

任一命令失敗就停在目前狀態，保留失敗證據並修正；不得更新 golden 或 baseline 來讓測試變綠。

## 外部與付費 gate

預設外部 API 預算是 USD 0。連接 Supabase、VTO Provider、OpenAI、Replicate，或任何外部寫入前必須：

1. 完成所有免費離線 gate。
2. 完成對應 CLI dry-run。
3. 列出預計 calls、圖片、資料目的地與成本上限。
4. 取得人工對這一輪、這個範圍的明確授權。
5. 使用新 artifact path；不得覆寫既有結果。

授權一次不代表可部署、可開 canary，或可在下一輪繼續花費。

## Promotion gate

下列任一項成立即 `blocked`：

- test、lint、deterministic cases、baseline integrity 或必要 build 未通過。
- HTTP 契約、安全、隱私、額度或 idempotency 發生 regression。
- config snapshot 不完整、矩陣組合無效，或偵測到 approved baseline mutation。
- control／candidate 不是同人物、同服裝、同案例，或資料不足。
- terminal success rate、結構化錯誤、p95 latency 或成本超過本輪預算。
- 出現新的 critical visual defect。
- Judge position bias、abstain、inconclusive 被誤當成勝出。
- 人工 reviewer Reject。

所有自動 gate 通過且尚未人工審查時，狀態只能是 `awaiting-human-review`。人工 Accept 後也只成為 `eligible-for-rollout-review`；`automatedPromotionAllowed` 永遠是 `false`。人工 reviewer 仍需另外決定 canary／on、百分比與 deployment。

## 停止條件

預設政策：

- 最多自動迭代 3 輪。
- 外部 API 預算 USD 0，除非本輪獲明確授權。
- 連續 2 輪未通過 gate 時停止。
- 相同 root cause 出現 2 次時停止。
- test、HTTP contract、安全、隱私或 baseline integrity regression 立即停止。
- 證據不足立即輸出 `inconclusive`，不得宣稱成功。

停止後 Agent 只能交付原因、證據、已嘗試方案與需要的人工作決定；不得為了分數持續改 seed、prompt、門檻或 Judge rubric。

## 回滾與人工權限

回滾只把 Feature Flag 切回 `control`／`off`，不依賴刪除資料或覆寫歷史。既有 job 保留建立時 snapshot。只有人工 reviewer 可以：核准 baseline、接受成本／延遲退化、把 mode 改成 canary／on、提高 rollout percentage，以及決定 production deployment。

## Agent 完成回報格式

1. 修改檔案與單一假設。
2. Feature Flag control／candidate 與矩陣合法性。
3. 預設、fail-closed、stable assignment 與回滾行為。
4. 實際執行的免費驗證與結果。
5. 未執行的連網／付費步驟及預估成本。
6. promotion gate status、blockers 與停止條件。
7. 需要人工決策的事項。
8. HTTP 契約是否完整保持；若否，任務未完成。
