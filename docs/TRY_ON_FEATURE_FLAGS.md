# Try-On Feature Flag 實驗矩陣

此機制只改變 server-side Workflow 的 provider／enhancement 設定解析，不改變 `/api/try-on` 的 URL、request body、response body、HTTP status mapping 或繁中錯誤契約。未設定 `TRY_ON_FEATURE_FLAG_CONFIG` 時，系統沿用既有 `VTO_PROVIDER`／`ENHANCE_PROVIDER`，並把新 job 記為 `deployment-control`。

## 設定優先序

1. deterministic runner／單元測試的明確 forced injection；只存在離線 harness。
2. 已驗證的 Feature Flag experiment decision。
3. `VTO_PROVIDER`／`ENHANCE_PROVIDER` 部署設定。
4. 既有安全預設：`fashn`／`none`。

Feature Flag 的 JSON 與 HMAC secret 只由 `src/lib/try-on/feature-flags.ts` 讀取。這個 module 有 `server-only` 邊界，Route 與 Client Component 不得自行解析旗標，也不得建立 `NEXT_PUBLIC_` 版本。

## 矩陣

| Provider | Enhancement | 狀態 | Production | 外部成本 | 必要環境變數 |
|---|---|---|---|---|---|
| `fashn` | `none` | supported | 可 | 有 | `FASHN_API_KEY` |
| `fashn` | `realesrgan` | supported | 可 | 有 | `FASHN_API_KEY`、`REPLICATE_API_TOKEN` |
| `fashn-max` | `none` | supported | 可 | 有 | `FASHN_API_KEY` |
| `fashn-max` | `realesrgan` | unsupported | 不可 | 有 | 禁止：Max 已是高解析輸出 |
| `mock` | `none` | evaluation-only | 不可 | 無 | 無 |
| `mock` | `realesrgan` | unsupported | 不可 | 有 | 禁止對示範結果增加成本 |

Parser 也只接受目前可真正執行的 `generation-v1` 與 `prompt.version=none`。未來新增 generation config 或 prompt 時，必須先實作 provider 行為、更新 snapshot type、矩陣、測試與文件，不可只改字串便宣稱已支援。

## Rollout mode

| Mode | Runtime 行為 | Candidate 行為 |
|---|---|---|
| `off` | 100% control | 不執行 |
| `evaluation` | 網站仍是 control | 只有明確離線 evaluation／forced injection 才執行 |
| `canary` | 依 0–100% 穩定分流 | 需人工開啟與 HMAC secret |
| `on` | 100% candidate | 仍需人工核准與部署，不代表 baseline approved |

`off` 必須是 0%；`evaluation`／`on` 必須是 100%；`canary` 接受 0–100 的整數。設定格式、ID、組合、必要 secret 或選中 variant 的 runtime dependency 不合法時一律 fail-closed，不會偷偷切換到較昂貴的 provider。

## 設定格式

`TRY_ON_FEATURE_FLAG_CONFIG` 是單行 JSON，schema 如 `fixtures/try-on-experiments/example.v1.json`：

```json
{
  "schemaVersion": 1,
  "experimentId": "max-quality-v1",
  "mode": "evaluation",
  "rolloutPercentage": 100,
  "saltVersion": "salt-v1",
  "control": {
    "id": "control-v16",
    "provider": "fashn",
    "enhancement": "none",
    "generationConfigVersion": "generation-v1",
    "prompt": { "version": "none", "hash": null }
  },
  "candidate": {
    "id": "candidate-max",
    "provider": "fashn-max",
    "enhancement": "none",
    "generationConfigVersion": "generation-v1",
    "prompt": { "version": "none", "hash": null }
  }
}
```

Experiment 與 candidate ID 是不可變身分。只要 provider、enhancement、generation config、prompt 或評測假設改變，就建立新的 candidate ID；不得在相同 ID 下換內容。更換 experiment ID 或 salt version 代表新的 assignment version，必須重新審查 rollout。

## 穩定分流與隱私

`canary` 使用 server-side HMAC-SHA-256，輸入為 experiment ID、salt version 與可信 Auth user ID。相同輸入永遠落在相同 variant，不使用 `Math.random()`；快照不保存 user ID、assignment key、HMAC 或 bucket。

Idempotency replay 會先讀既有 job，並以 job 的原始 `config_snapshot` 驗證 request fingerprint。因此旗標、salt 或部署設定後來改變時，同一個合法 idempotency key 仍回原 job／原 variant，不重新抽樣。

## Job snapshot

Production 新 job 的 `config_snapshot.experiment` 保存：schema version、experiment ID、variant ID／role、rollout mode／percentage、assignment version、salt version、原始 request 所映射的 provider。原有 provider、model、seed、preprocessing、enhancement 與 prompt 仍在同一份 snapshot。

Polling 的 enhancement 以 job 建立時的 snapshot 為準，不重新讀取當下 Feature Flag。歷史 v1 golden 與 legacy `{}` 仍可唯讀；只有新 production job 強制帶 experiment metadata，因此不需新增 migration 或覆寫 approved baseline。

## 離線 runner

預設 golden 模式完全不變：

```bash
npm run try-on:cases -- --json
```

明確觀察 control／candidate 時使用 versioned config；輸出是 observation，不會比較或更新 golden：

```bash
npm run try-on:cases -- \
  --case start-v16-explicit-seed-success \
  --feature-config fixtures/try-on-experiments/example.v1.json \
  --variant candidate \
  --json
```

Runner 使用固定時間、seed、bytes、in-memory DB／Storage／Provider，並封鎖 network。相同 commit 與參數的 JSON 可 byte-for-byte 重現。它不會建立真實 candidate 圖，也不能取代 production metrics、AI Judge 或人工 baseline。

## 回滾

把 experiment mode 改成 `off` 或移除 `TRY_ON_FEATURE_FLAG_CONFIG` 即回到 control。回滾不刪除 job、不覆寫歷史 snapshot，也不修改 approved baseline。任何 canary／on／百分比提高都只能由人工 reviewer 決定。
