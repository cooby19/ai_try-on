# AI 虛擬試衣 MVP

使用者上傳**正面半身照**、選擇一件**上衣**商品，系統透過 Virtual Try-On API 產生「只替換上衣、盡量保留人物與背景」的試穿預覽圖。內建生成次數限制、回饋紀錄與成本控管。

## 技術架構

- **前端／後端**：Next.js 16（App Router、TypeScript、Tailwind CSS）
- **資料庫／圖片儲存**：Supabase（Postgres + 私有 Storage bucket，前端只拿短期 signed URL）
- **AI 生成**：可替換的 VTO provider 抽象層
  - `mock`（須明確啟用）：不需 API key，約 3 秒回傳示範合成圖，可跑通完整流程
  - `fashn`：真實的 [FASHN Virtual Try-On API](https://fashn.ai)
- **使用者識別**：匿名 cookie（`vto_uid`），不需註冊登入

## 快速開始

### 1. 安裝依賴

```bash
npm install
```

### 2. 建立 Supabase 專案

1. 到 [supabase.com](https://supabase.com) 建立免費專案
2. 進 **SQL Editor**，依序貼上並執行 `supabase/migrations/` 下的 SQL 檔：
   - `001_init.sql`（4 張資料表、2 個私有 storage bucket、3 件種子商品）
   - `002_atomic_quota_insert.sql`（額度檢查＋插入的原子函式；未執行的話「開始 AI 試穿」會直接失敗）

### 3. 設定環境變數

```bash
cp .env.local.example .env.local
```

打開 `.env.local`，填入（Supabase Dashboard → Project Settings → API）：

| 變數 | 說明 |
|---|---|
| `SUPABASE_URL` | 專案 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key（**只在後端使用，不會進前端 bundle**） |
| `VTO_PROVIDER` | `fashn`（預設）、`fashn-max` 或僅供流程展示的 `mock` |
| `FASHN_API_KEY` | 只有用 `fashn` 時需要 |

### 4. 啟動

```bash
npm run dev
```

打開 http://localhost:3000 → 選商品 → 「AI 試穿」→ 上傳照片 → 生成。

## 如何換成真實 VTO API

1. 到 [fashn.ai](https://fashn.ai) 註冊並取得 API key
2. `.env.local` 改成：
   ```
   VTO_PROVIDER=fashn
   FASHN_API_KEY=fa-xxxxxxxx
   ```
3. 重啟 dev server 即可，其他程式完全不用改

### 想接其他家（例如 fal.ai）？

實作 `src/lib/vto/provider.ts` 的 `VTOProvider` 介面（參考 `fashn.ts`），
然後在 `src/lib/vto/index.ts` 的 factory 註冊名稱即可。

## 部署

推薦部署到 **Vercel**（本專案的 serverless 架構為此設計）。完整步驟見
**[docs/DEPLOY_VERCEL.md](docs/DEPLOY_VERCEL.md)**。

建議「分階段、一次點亮一層」上線，壞了才好定位、也不白花 AI 錢：

1. 先用 `VTO_PROVIDER=mock` 上線，驗證 app 能連上 Supabase、上傳/額度/刪除都正常（不花 AI 錢）。
2. 全綠後只改 `VTO_PROVIDER=fashn` 並填 `FASHN_API_KEY`，重新部署，跑一次真實生成。
3. 結果圖放大（`ENHANCE_PROVIDER=realesrgan`）非必要，MVP 先維持 `none`。

## 成本控管規則

| 規則 | 值 | 位置 |
|---|---|---|
| 每人每日生成上限 | 3 次 | `src/lib/quota.ts` `DAILY_GENERATION_LIMIT` |
| 每商品每人重試上限 | 2 次（首次 + 2 次重試） | `src/lib/quota.ts` `PER_PRODUCT_RETRY_LIMIT` |

額度直接統計 `try_on_jobs` 當日筆數（台北時區），失敗的生成也計入（因為已產生 API 成本）。每筆任務都記錄 `provider`、`cost_estimate`、`status`、`retry_count`、`error_message`。

## API 一覽

| Method | Path | 說明 |
|---|---|---|
| POST | `/api/upload` | 上傳人物照（驗證 → 壓縮 → 私有 bucket） |
| POST | `/api/try-on` | 建立試穿任務（額度檢查 → 呼叫 provider） |
| GET | `/api/try-on/[jobId]` | 輪詢任務狀態 |
| DELETE | `/api/try-on/[jobId]` | 刪除試穿紀錄與照片（隱私） |
| POST | `/api/feedback` | 滿意 / 不滿意回饋 |
| GET | `/api/quota?productId=` | 查詢剩餘額度 |

## 隱私設計

- 人物照與結果圖存放在**私有** bucket，前端只拿 1 小時有效的 signed URL
- 使用者可在結果頁刪除自己的試穿照片：**照片檔案立即刪除、圖片欄位清空**，但 job 列保留——否則使用者可以靠「生成 → 刪除」重複刷每日額度，成本指標也會失真
- 照片只用於 AI 試穿；未經同意不用於模型訓練
- API key 只存在後端環境變數（已驗證不會出現在前端 bundle）
- TODO（未來強化）：定期自動清除逾期照片、上傳前臉部模糊選項、GDPR 式資料匯出

## 測試方式（mock provider）

1. 商品頁點「AI 試穿」→ 上傳一張人物照（沒有現成照片可用 `public/samples/sample-person.jpg`）→ 約 3 秒後看到示範結果圖（含 MOCK 浮水印）
2. 按「滿意 / 不滿意」→ Supabase `try_on_feedback` 表會多一筆
3. 同一商品連續生成 3 次 → 第 4 次會被「此商品重試上限」擋下
4. 換不同商品湊滿當日 3 次 → 再生成會被「每日上限」擋下
5. 上傳 txt 或超過 4MB 的檔案 → 會在送出前得到可操作的錯誤訊息

## 專案結構

```
src/
├── lib/
│   ├── vto/            # VTO provider 抽象層（mock / fashn / factory）
│   ├── quota.ts        # 額度檢查與任務紀錄
│   ├── validation.ts   # 照片格式/大小/解析度檢查
│   ├── supabase.ts     # 後端專用 Supabase client + signed URL
│   ├── user.ts         # 匿名 cookie 使用者
│   └── images.ts       # 圖片載入/轉檔工具
├── app/
│   ├── api/            # upload / try-on / feedback / quota
│   ├── page.tsx        # 商品列表
│   └── products/[id]/  # 商品頁
└── components/         # TryOnLauncher（modal）/ TryOnResult / AddToCartButton
supabase/migrations/               # 001 資料表 + bucket + 種子資料；002 原子額度插入函式
```

## 未來擴充（刻意不在第一版做）

褲子/洋裝/外套、全身照、多件試穿、完整尺寸推薦、商家後台、多 provider 自動路由、queue/webhook、自建模型。架構上已預留：`category` 欄位、`garmentType` 參數、provider factory。
