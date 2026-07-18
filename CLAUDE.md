@AGENTS.md

# CLAUDE.md

本文件是給 AI 助理（Claude Code 等）的專案指南。修改任何程式碼之前，請先讀完本文件，並遵守「AI 協作注意事項」章節的規則。

## 1. 專案概述

- **產品名稱**：樣衣間 — AI 虛擬試衣 MVP。
- **核心功能**：使用者上傳**正面半身照**、選擇一件**上衣**商品，系統透過 Virtual Try-On（VTO）API 產生「只替換上衣、盡量保留人物與背景」的試穿預覽圖。
- **定位**：第一版仍只支援上衣（`category = 'tops'`），但已具備尺寸規格、跨裝置購物車、地址簿、結帳、訂單、Mock 付款、庫存保留、取消／退款申請、客服與營運後台。Mock Payment 僅供封閉測試，尚不可宣稱可正式收款。
- **會員登入**：使用 Supabase Auth（Google OAuth + Email 6 位數 OTP）；未登入可瀏覽商品，但 AI 試穿、額度與結果均需登入。Auth `user.id` 是正式使用者唯一 ID，不搬移匿名測試資料。
- **核心機制**：
  - 成本控管 — 每位會員每日最多生成 3 次、每商品每人最多重試 2 次，另有平台每日 USD 預算熔斷，失敗也計入額度。
  - 回饋紀錄 — 使用者對結果按「滿意 / 不滿意」，寫入 `try_on_feedback` 表。
  - 隱私設計 — 照片存私有 bucket、前端只拿 1 小時不透明加密 URL、使用者可刪除自己的照片。
  - 購物與庫存 — 訪客購物車存於 localStorage，登入時冪等合併至帳號；結帳建立庫存保留，僅付款成功才扣減實際庫存。
  - 營運安全 — Email outbox、客服、取消／退款狀態機、風險事件、員工 RBAC、稽核與資料保留工作均由後端 service role 執行。

## 2. 專案架構

### 2.1 資料夾結構

```
src/
├── app/
│   ├── layout.tsx              # 全站 layout（zh-TW、header/footer、免責文案）
│   ├── page.tsx                # 首頁商品列表（Server Component，直接查 DB）
│   ├── products/[id]/page.tsx  # 商品頁（Server Component）
│   ├── account/、auth/、cart/、checkout/、orders/、support/ # 帳戶、登入、購物與售後頁
│   ├── admin/                    # RBAC 保護的營運後台
│   └── api/                      # Auth、圖片、試穿、購物車、結帳、訂單、客服與內部 Cron Route Handlers
├── components/                 # Client Components（"use client"）
│   ├── TryOnLauncher.tsx       # 試穿 modal：上傳 → 預覽 → 生成 → 輪詢
│   ├── TryOnResult.tsx         # 結果對比、回饋、重新生成、刪除
│   ├── CartProvider.tsx         # 訪客／會員購物車狀態與順序化 mutation queue
│   └── AddToCartButton.tsx      # 尺寸選擇與實際加入購物車
├── lib/
│   ├── vto/
│   │   ├── provider.ts         # VTOProvider 介面（submit + checkStatus 兩段式）
│   │   ├── mock.ts             # mock provider：3 秒後回傳合成示範圖
│   │   ├── fashn.ts            # FASHN API adapter（tryon-v1.6）
│   │   ├── fashn-max.ts        # FASHN Try-On Max adapter（共用 FASHN_API_KEY）
│   │   └── index.ts            # provider factory + 使用者模型白名單（v1.6/max → provider 名稱）
│   ├── enhance/
│   │   ├── enhancer.ts         # ImageEnhancer 介面（結果圖放大後處理）
│   │   ├── realesrgan.ts       # Real-ESRGAN 2× 放大 adapter（Replicate API）
│   │   └── index.ts            # enhancer factory + 降級策略（ENHANCE_PROVIDER，預設 none）
│   ├── try-on/
│   │   ├── workflow.ts         # server-only production dependencies 與既有公開 exports
│   │   ├── workflow-core.ts    # Route 與固定案例共用的可注入生成編排
│   │   └── scenario-runner.ts  # 完全離線的 deterministic in-memory harness
│   ├── supabase.ts             # service role client + 不透明短效圖片 URL（僅限後端）
│   ├── quota.ts                # 額度檢查與 try_on_jobs 讀寫
│   ├── user.ts                 # Supabase Auth session 使用者驗證
│   ├── supabase/               # browser/server/proxy SSR Auth clients
│   ├── cart*.ts、orders*.ts、mock-payments.ts # 購物車、結帳／訂單、付款與庫存規則
│   ├── support.ts、risk.ts、staff.ts、retention.ts、notifications.ts # V1 營運服務
│   ├── validation.ts、images.ts、http.ts      # 圖片驗證／處理與 HTTP 共用工具
│   └── types.ts                # 資料表與 API view 共用型別
├── proxy.ts                     # 更新 Supabase SSR session
supabase/migrations/              # 001–012：核心、會員、購物車、結帳、付款、庫存與 V1 營運
supabase/tests/                   # Supabase RLS／權限安全檢查
fixtures/try-on-cases/            # 16 個 versioned golden scenarios
scripts/run-try-on-cases.ts       # deterministic CLI entrypoint
public/garments/                  # 種子商品的上衣圖（SVG / JPG）
public/samples/sample-person.jpg  # 測試用人物照
.claude/launch.json               # preview 用 dev server 設定（npm run dev，port 3000）
vitest.config.ts                  # Vitest 設定（node 環境、@/* alias）
eslint.config.mjs                 # ESLint flat config（eslint-config-next）
vercel.json                        # 通知派送與資料保留 Cron
.github/workflows/ci.yml           # push／PR 的 test + deterministic cases + lint
```

單元測試檔大多與被測檔同層；另有 `src/app/api/**/*.test.ts` 驗證 Route Handler 的認證與輸入邊界。上面的樹狀圖省略未列。

### 2.2 分層關係

- **Client Components** 只呼叫自家 `/api/*` 或使用 Supabase 的 browser client 維持 Auth session；完全接觸不到 service role、VTO、付款、Email 或 Cron secret。`cart-storage.ts`、`cart-optimistic.ts`、`types.ts` 是刻意可供 client import 的純資料工具；其餘 server-only 模組不可跨入 client import 鏈。
- **Server Components 與 Server Actions** 直接以已驗證的 Auth user 查詢資料、處理登入登出與頁面導向；不可信的瀏覽器輸入仍交由 Route Handler 驗證。
- **API Route Handlers** 是瀏覽器可呼叫的後端邊界：負責身份驗證、輸入驗證、購物車／訂單狀態機、私有圖片、VTO provider 與營運操作。`/api/internal/*` 只接受 Cron secret，不可對前端開放。
- **Supabase** 負責 Auth、Postgres 與私有 Storage bucket（`person-uploads`、`try-on-results`）。`anonymous_sessions` 只保留舊測試資料，正式流程不讀寫；持久購物車、訂單與營運資料全綁定 Auth `user.id`。
- **VTO provider 抽象層**：`VTOProvider` 介面拆成 `submit()`（送出任務、回傳 provider 端任務 ID）與 `checkStatus()`（輪詢），因為主流 VTO API 都是非同步「送出 → 輪詢」模式，serverless route 不必長時間等待。要接新供應商（如 fal.ai）只需實作介面並在 `src/lib/vto/index.ts` 的 factory 註冊。

### 2.3 資料表（見 `supabase/migrations/001`–`012`）

| 資料表 | 用途 |
|---|---|
| `users` | 正式會員 profile；`id` 對應 `auth.users.id`，email 由 trigger 同步 |
| `anonymous_sessions` | V0.1 舊測試資料，V0.2 正式流程不讀寫 |
| `products` | 商品（含 `garment_image_url` 給 VTO 用、`category` 預設 `'tops'`、`size_chart` jsonb） |
| `product_variants` | 商品尺寸、可售狀態與實際庫存 |
| `try_on_jobs` | 每次試穿任務：狀態機 `pending → processing → success/failed`，含 `provider`、`provider_job_id`、`cost_estimate`、`retry_count`、`error_message` |
| `try_on_feedback` | 滿意 / 不滿意回饋（`rating` 限 `satisfied`/`unsatisfied`） |
| `carts`、`cart_items`、`cart_merge_receipts` | 會員購物車、品項與訪客購物車冪等合併收據 |
| `addresses`、`shipping_methods` | 地址簿與結帳可用運送方式 |
| `orders`、`order_items`、`payments`、`payment_webhook_events` | 訂單快照、付款與冪等 Webhook 事件 |
| `inventory_reservations` | 建單時建立、付款成功才扣庫存的可過期庫存保留 |
| `account_deletion_requests` | 帳戶刪除申請與後續受控處理 |
| `notification_outbox`、`support_tickets`、`support_messages` | 通知、客服案件與訊息紀錄 |
| `refund_requests`、`order_status_events` | 取消／退款與訂單狀態稽核軌跡 |
| `user_roles`、`risk_events`、`auth_attempt_events`、`admin_audit_logs` | RBAC、風險偵測與營運稽核 |
| `data_retention_policies` | 資料保留與去識別化政策 |

- 所有敏感表啟用 RLS，並撤銷 `anon`／`authenticated` 的 table grants；後端 service role 仍須以可信 Auth `user.id` 篩選資料。own-row RLS policy 是未來誤加 grant 時的第二道防線，不是允許前端直接存取的理由。
- Migration 內含對 `service_role` 的明確 `GRANT`——新版 Supabase 專案（`sb_secret_` 金鑰）在 SQL Editor 建表後不會自動授權，這段不可刪除。

## 3. 核心功能流程

### 3.1 AI 試穿主流程

1. 商品頁點「AI 試穿」→ `TryOnLauncher` 開 modal，先打 `GET /api/quota?productId=` 顯示剩餘額度；回應中的 `defaultModel`（`"v1.6" | "max" | null`）決定是否顯示生成模型選擇器（`null` = mock 模式，隱藏選擇器）。
2. 使用者上傳照片 → `POST /api/upload`：驗證格式（JPG/PNG/WebP、≤8MB、寬度 ≥320px）→ sharp 依 EXIF 轉正、壓成寬度 ≤1440 的 JPEG（quality 92，補 v1.6 的輸入解析度）→ 存入私有 bucket `person-uploads`（路徑 `{userId}/{uuid}.jpg`）→ 回傳 Storage 路徑 + 預覽用不透明短效 URL。
3. 按「開始 AI 試穿」→ `POST /api/try-on`：
   - 驗證 `personImagePath` 必須以 `{userId}/` 開頭（防止拿別人的照片生成）。
   - 選用欄位 `model`（`"v1.6"` 或 `"max"`）經 `resolveVTOProviderName()` 白名單映射成 provider 名稱（`fashn` / `fashn-max`）：不合法值回 400（此時尚未建 job、不占額度）；`VTO_PROVIDER=mock` 時忽略選擇一律用 mock；未傳則沿用 `VTO_PROVIDER` 預設。**前端不得直接傳 provider 內部名稱**（防止注入 `mock` 取得免費假結果）。兩種模型共用同一套每日額度，不分開計。
   - `checkGenerationQuota()` 前置檢查會員每日 3 次與每商品 3 次（首次 + 2 次重試）上限——非原子、僅供快速失敗與友善訊息，防併發的最終判定在下一步。
   - `recordTryOnJob()` 呼叫 migration 005 的 `insert_try_on_job_within_quota`，以固定鎖順序原子檢查平台預算、Auth 使用者額度與商品重試後才插入 job。拒絕請求不呼叫 AI API。**建立紀錄本身就是額度與預算預留**，不用額外計數器欄位。
   - 從 Storage 下載人物照、載入上衣圖 → `provider.submit()` → 狀態改 `processing`，回傳 `jobId`。
   - 送出失敗時：狀態改 `failed` 並寫 `error_message`，回 502——**失敗仍占額度**（已產生 API 成本）。
4. 前端每 2 秒輪詢 `GET /api/try-on/[jobId]`（上限 120 秒）：
   - 後端向 provider `checkStatus()`；成功時把結果圖存入私有 bucket `try-on-results`，狀態改 `success`。
   - 存檔前有一道選配的**放大後處理**（`src/lib/enhance/`，`ENHANCE_PROVIDER` 驅動、預設 `none` 停用）：只針對 v1.6（`fashn`）的結果做 2× 放大（864×1296 → 1728×2592，補其與 Max 的解析度缺口），mock / fashn-max 跳過；實際執行放大時把放大成本加進 `cost_estimate`。**放大失敗一律降級回原圖、job 仍標 `success`**——使用者已扣額度，選配後處理不能讓生成報廢。硬逾時 30 秒（`ENHANCE_TIMEOUT_MS`），總延遲留在前端 120 秒輪詢上限內。
   - 回傳 `TryOnJobView`（圖片一律轉成 1 小時不透明加密 URL，不暴露 Storage 路徑或 user/job UUID）。
5. 結果頁（`TryOnResult`）：原圖 / 結果對比、免責文案、滿意/不滿意回饋（`POST /api/feedback`）、重新生成、刪除照片。

### 3.2 刪除流程（隱私 vs 成本控管的取捨）

`DELETE /api/try-on/[jobId]`：

- 結果圖檔案刪除；人物照**先確認沒有其他 job 引用**（重新生成會共用同一張人物照）才刪檔案。
- job 資料列**保留**，只清空圖片欄位——因為額度是統計當日 `try_on_jobs` 筆數，若整列刪除，使用者就能靠「生成 → 刪除」重複刷額度，成本指標也會失真。**不要改成整列刪除。**

### 3.3 購物、訂單與 V1 營運流程

1. 訪客購物車只保存 `guestCartId`、`variantId` 與數量到 localStorage；每次畫面載入都以 `/api/cart/resolve` 依目前商品價格與庫存重新解析，瀏覽器提供的價格永遠不可信。
2. 登入後，`CartProvider` 將訪客品項送至 `/api/cart/merge`；`cart_merge_receipts` 使同一批次在重送時不會重複累加。已登入購物車則由 API 以 Auth `user.id` 存取，並在跨裝置載入或視窗重新取得焦點時刷新。
3. 建立訂單會以資料庫交易驗證地址、運送方式、價格與庫存，並建立 30 分鐘的 `inventory_reservations`。付款成功才在同一交易扣除庫存；失敗、取消、逾期或保留到期只釋放保留。Mock Payment 透過 HMAC Webhook 與事件 ID 去重，正式環境預設拒絕 Mock。
4. 訂單取消與退款只能建立申請；敏感狀態變更、客服內部訊息、風險調查與角色操作都經 server-side RBAC 並寫入稽核軌跡。`notification_outbox` 由 `vercel.json` 所列的內部 Cron 路由派送；未設定 Email provider 時標記為 `skipped`，不會誤報為已送達。

### 3.4 API 一覽

| Method | Path | 說明 |
|---|---|---|
| POST | `/api/upload` | 申請直傳授權或完成私有 Storage 圖片驗證與正規化 |
| GET | `/api/upload?path=` | 刷新目前使用者照片的短效顯示 URL |
| POST | `/api/try-on` | 建立試穿任務（額度檢查 → 呼叫 provider）；選用 body 欄位 `model: "v1.6" \| "max"` 選擇生成模型 |
| GET | `/api/try-on/[jobId]` | 輪詢任務狀態（processing 時順便向 provider 查進度） |
| DELETE | `/api/try-on/[jobId]` | 刪除照片、保留 job 列（隱私） |
| POST | `/api/feedback` | 滿意 / 不滿意回饋 |
| GET | `/api/quota?productId=` | 查詢剩餘額度；回應含 `defaultModel`（`null` = 不開放選模型） |
| GET | `/api/cart` | 取得目前登入帳號的資料庫購物車 |
| POST | `/api/cart/items` | 加入指定尺寸規格 |
| PATCH / DELETE | `/api/cart/items/[variantId]` | 更新數量／移除指定規格 |
| POST | `/api/cart/resolve` | 依目前商品價格與庫存解析訪客購物車 |
| POST | `/api/cart/merge` | 冪等合併訪客購物車到登入帳號 |
| GET / POST | `/api/addresses` | 取得／新增本人的地址簿項目 |
| PATCH / DELETE | `/api/addresses/[addressId]` | 修改／刪除本人的地址簿項目 |
| GET | `/api/shipping-methods` | 取得可用運送方式 |
| GET / POST | `/api/orders` | 取得訂單歷史／從購物車建立待付款訂單 |
| POST | `/api/orders/[orderId]/mock-payment` | 只供測試的 Mock 付款結果 |
| POST | `/api/payments/mock/webhook` | 驗證 HMAC 後冪等更新付款與訂單狀態 |
| POST | `/api/orders/[orderId]/cancellation` | 建立取消申請 |
| POST | `/api/orders/[orderId]/refund` | 建立退款申請 |
| GET / POST | `/api/support/tickets` | 取得／建立本人的客服案件 |
| POST | `/api/support/tickets/[ticketId]/messages` | 為本人的客服案件新增訊息 |
| POST | `/api/account/deletion-request` | 建立帳戶刪除申請，不直接刪除帳戶 |
| POST | `/api/auth/otp/request`、`/api/auth/otp/verify` | 請求／驗證 Email OTP，並記錄安全事件所需雜湊指紋 |
| GET | `/api/image/[...slug]` | 驗證目前使用者後代理私有圖片 |
| GET / POST | `/api/internal/notifications/dispatch` | 內部通知派送，需 `CRON_SECRET` |
| GET / POST | `/api/internal/retention/run` | 內部資料保留工作，需 `CRON_SECRET` |

錯誤回應統一格式：`{ status: "failed", message: "<可操作的繁中訊息>" }`（見 `src/lib/http.ts`）。

## 4. 技術棧與外部服務

| 類別 | 技術 / 版本 | 備註 |
|---|---|---|
| 框架 | Next.js **16.2.10**（App Router）+ React 19 | **此版本與訓練資料有 breaking changes**，寫程式前先讀 `node_modules/next/dist/docs/` 的相關指南（見 AGENTS.md） |
| 語言 | TypeScript（strict 模式） | path alias `@/*` → `./src/*` |
| 樣式 | Tailwind CSS 4（`@tailwindcss/postcss`） | `globals.css` 只有 `@import "tailwindcss"` 與字型設定；統一淺色主題 |
| 圖片處理 | sharp | 轉正、壓縮、SVG 點陣化、mock 合成 |
| 資料庫 / 儲存 | Supabase（`@supabase/supabase-js`） | Postgres + 私有 Storage bucket；只用 service role key，於後端使用 |
| AI 生成 | 可替換的 VTO provider | `fashn` 是安全預設（`tryon-v1.6`）；`fashn-max` 與它共用 `FASHN_API_KEY`，使用者可於 v1.6 / Max 間切換；`mock` 必須明確設定，僅用於展示流程 |
| 測試 | Vitest 4 + deterministic CLI | `npm run test`；`npm run try-on:cases` 執行 16 個固定生成案例。兩者皆完全離線，不花 API 錢 |
| Lint | ESLint 9（flat config） | `npm run lint`；`eslint-config-next` 的 core-web-vitals + typescript 設定。**Next.js 16 已移除 `next lint`**，一律走 ESLint CLI |
| CI | GitHub Actions | `.github/workflows/ci.yml` 在 push／pull request 以 Node 22 執行 `npm ci`、`npm run test`、`npm run try-on:cases -- --json`、`npm run lint` |
| 部署／排程 | Vercel | `vercel.json` 設定通知派送與資料保留的內部 Cron 路由；完整上線規則見 `docs/DEPLOY_VERCEL.md`、`docs/V1_OPERATIONS.md` |

### 4.1 環境變數（`.env.local`，範本見 `.env.local.example`）

| 變數 | 說明 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 專案 URL（Auth client） |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key（Auth client，可公開） |
| `SUPABASE_URL` | Supabase 專案 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key，**只能在後端使用** |
| `NEXT_PUBLIC_APP_URL` | 正式站點 URL，供通知／回傳連結使用 |
| `MOCK_PAYMENT_WEBHOOK_SECRET` | Mock Payment Webhook HMAC secret，至少 32 字元，只能在後端使用 |
| `ENABLE_MOCK_PAYMENTS_IN_PRODUCTION` | 正式環境是否例外啟用 Mock；預設 `false`，公開營運不可開啟 |
| `RESEND_API_KEY`、`EMAIL_FROM` | 同時設定才啟用對外 Email；否則通知僅記錄為 `skipped` |
| `CRON_SECRET` | Vercel Cron 呼叫內部維護 API 的 secret，至少 32 字元 |
| `RISK_HASH_SECRET` | 對 Email、IP、User-Agent 產生不可逆風險指紋的 secret，至少 32 字元 |
| `ACCOUNT_DELETION_EXECUTION_ENABLED` | 帳戶刪除實際執行開關；staging 演練前必須為 `false` |
| `PLATFORM_DAILY_BUDGET_USD` | 平台每日 AI 成本預算熔斷（USD） |
| `VTO_PROVIDER` | `fashn`（預設）、`fashn-max` 或僅展示用的 `mock` |
| `FASHN_API_KEY` | `VTO_PROVIDER=fashn` 或 `fashn-max` 時需要 |
| `ENHANCE_PROVIDER` | `none`（預設，停用放大後處理）或 `realesrgan`（Real-ESRGAN 2× 放大，經 Replicate，約 USD 0.0025/張；只作用於 v1.6 的結果） |
| `REPLICATE_API_TOKEN` | 僅 `ENHANCE_PROVIDER=realesrgan` 時需要，**只能在後端使用** |

`.gitignore` 已排除 `.env*`；`.env.local` 永遠不可提交。

### 4.2 Next.js 16 已知慣例（程式中已採用，修改時必須沿用）

- Route Handler 與 Page 的 `params` 是 **Promise**，必須 `await`（例：`{ params }: { params: Promise<{ id: string }> }`）。
- `cookies()` 是非同步，必須 `await`；寫 cookie 只能在 Route Handler，Server Component 不行。
- 讀 DB 的頁面使用 `export const dynamic = "force-dynamic"` 避免建置時預先渲染。
- 其他 API 差異請先查 `node_modules/next/dist/docs/`，不要憑訓練資料的記憶寫。

## 5. 開發規範

- **註解語言**：全部使用繁體中文，重點寫「為什麼這樣設計」而非「這行在做什麼」。程式註解常引用「規格書第 X 節」，但**規格書本身不在 repo 中**（目前專案中未明確定義其存放位置）。
- **命名**：資料庫與 API 內部用 snake_case（對應資料表欄位）；TypeScript 變數與 API 回傳給前端的 view 用 camelCase（見 `TryOnJob` vs `TryOnJobView` 的轉換）。
- **錯誤訊息**：一律是使用者「可操作」的繁體中文（告訴使用者下一步怎麼做），不直接透出技術細節；第三方錯誤要經過轉換（見 `fashn.ts` 的 `mapFashnError`）。
- **Server / Client 劃分**：頁面預設 Server Component 直接查 DB；需要互動的元件才加 `"use client"` 放進 `src/components/`。除了刻意的純資料模組（`cart-storage.ts`、`cart-optimistic.ts`、`types.ts`），`src/lib/supabase.ts`、`quota.ts`、`user.ts`、`validation.ts`、`images.ts`、`vto/`、付款與營運服務 **只能在伺服器端 import**。
- **圖片**：目前使用原生 `<img>` 搭配 `eslint-disable` 註解（未使用 `next/image`），新增圖片時沿用此慣例即可。
- **Commit 風格**：Conventional Commits 前綴 + 繁體中文描述，例：`feat: AI 虛擬試衣 MVP（上衣受控替換）`。
- **常數位置**：額度規則在 `src/lib/quota.ts`（`DAILY_GENERATION_LIMIT`、`PER_PRODUCT_RETRY_LIMIT`）；照片限制在 `src/lib/validation.ts`；輪詢間隔在 `TryOnLauncher.tsx`。調整規則直接改常數，不要散落新數字。
- **測試**：Vitest（`npm run test` 一次執行、`npm run test:watch` 監看模式），設定在 `vitest.config.ts`。`npm run try-on:cases` 另以固定時間、ID、seed、DB／Storage／Provider 跑 16 個 versioned golden scenarios，可用 `--case <id>` 或 `--json`；兩套測試都完全離線，不碰真實服務也不花錢。
- **唯讀 baseline report**：`npm run try-on:report` 統計真實 `try_on_jobs` 與私有 Storage metadata；有 `DB_URL` 時用 read-only transaction 取得 DB size，否則降級至 Supabase API 並把不可取得欄位標為 `N/A`。不得把固定案例當 production 指標，也不得在報告輸出逐筆 ID、路徑、signed URL、idempotency key 或原始錯誤訊息；完整口徑見 `docs/TRY_ON_BASELINE_REPORT.md`。
- **品質 baseline**：`npm run try-on:baseline:verify` 只讀檢查 versioned manifest、檔案 hash、圖片 metadata 與 Workflow case hash；`--require-approved` 只允許乾淨 commit 上、由人工明確 Accept 的真實視覺案例。不得將 16/16 Workflow pass 或 production metrics report 當成視覺品質核准，也不得加入自動接受／`--update`。
- **Lint**：ESLint（`npm run lint`），flat config 在 `eslint.config.mjs`。底線開頭的參數視為刻意未使用；規則誤判或介面保留參數時，沿用「附繁中理由的 `eslint-disable` 註解」慣例（見 `TryOnLauncher.tsx`、`AddToCartButton.tsx`），不要整條規則關掉。
- **CI/CD**：GitHub Actions 在每個 push 與 pull request 以 Node 22 執行 `npm ci`、`npm run test`、`npm run try-on:cases -- --json`、`npm run lint`。端到端與 Supabase migration／RLS 驗證仍需依 README、`docs/DEPLOY_VERCEL.md` 與 `docs/V1_OPERATIONS.md` 的清單手動驗證。
- **部署方式**：目標平台為 Vercel；`vercel.json` 已定義通知派送與資料保留 Cron。部署前必須遵循 `docs/DEPLOY_VERCEL.md` 與 `docs/V1_OPERATIONS.md`，且不能把 Mock Payment 當作正式金流。

## 6. AI 協作注意事項

**修改程式前必讀的規則：**

1. **先理解現有架構再動手**：讀完本文件與相關原始碼，確認要改的位置與既有分層（前端 → API route → lib → Supabase/provider）一致，再開始修改。
2. **不要任意重構整個專案**：不做大範圍搬移、改名、換資料夾結構；重構僅限於任務明確要求的範圍。
3. **不要刪除既有功能**：包括額度控管、失敗計入額度、刪除時保留 job 列、私有 bucket + 不透明短效圖片 URL 等刻意的設計取捨（原因都寫在對應檔案的註解裡）。
4. **不要自行更換技術棧**：不換框架、不換資料庫、不引入新的狀態管理或 UI 套件，除非使用者明確要求。
5. **不要硬編碼 API Key**：所有金鑰只能來自環境變數（`.env.local`），並更新 `.env.local.example` 的說明。
6. **不要把敏感資訊寫進前端**：`SUPABASE_SERVICE_ROLE_KEY`、`FASHN_API_KEY`、`src/lib/supabase.ts` 等後端模組絕對不可出現在任何 `"use client"` 元件的 import 鏈中；前端只能呼叫自家 `/api/*`。
7. **不確定需求時，做最小幅度、可回滾的修改**：小步修改、保留原行為、不要順手「順便改善」無關的程式。

**本專案特有的注意事項：**

- **Next.js 16 與你的訓練資料不同**（見根目錄 AGENTS.md）：寫任何 Next.js 相關程式前，先讀 `node_modules/next/dist/docs/` 的對應章節，並留意棄用警告。
- **額度機制不要改成計數器欄位**：額度 = 統計 `try_on_jobs` 當日筆數（台北時區 UTC+8），「建立 job」即「額度 +1」，沒有同步問題；改成計數器會重新引入不同步風險。
- **新增 VTO provider 的正確方式**：實作 `src/lib/vto/provider.ts` 的 `VTOProvider` 介面 → 在 `src/lib/vto/index.ts` factory 註冊名稱；API route 與前端不需要改。
- **改資料庫結構**：在 `supabase/migrations/` 新增遞增編號的 SQL 檔；目前 migration 為 `001`–`012`，需在 Supabase SQL Editor 依序執行，同時更新 `src/lib/types.ts` 的對應型別及相關安全檢查。
- **安全檢查不可移除**：`personImagePath` 必須以 `{userId}/` 開頭的驗證、`loadOwnedJob` 的 `user_id` 過濾、`loadImageAsPngBuffer` 的路徑跳脫檢查。
- **改 `quota.ts` / `validation.ts` / `vto/fashn.ts` 前先跑 `npm run test`**：這三個模組有單元測試釘住行為邊界（額度上限、時區換算、訊息文案）。行為是刻意調整時，同步更新對應測試與其註解；不要為了讓測試變綠而放寬斷言。

### 6.1 codebase-memory-mcp 使用守則（選用工具）

> 前提：此 MCP 為 local scope，僅部分開發機可用。若工具清單中沒有
> `mcp__codebase-memory-mcp__*`，跳過本節，改用內建 Grep/Glob/Read。
> 所有工具的 `project` 參數一律填：`Users-sihanchen-AI_try-on`

**核心原則：先查圖譜，再讀檔案。** 找「定義、關係、影響面」用圖譜（快、省 token）；只有確認目標後才 Read 完整檔案。

**工具選擇（依任務對號入座）：**

| 任務 | 工具與用法 |
|---|---|
| Session 開始、要全局視角 | `get_architecture(aspects=["all"])` — 一次即可，session 內重用結果 |
| 讀取專案既有決策與取捨 | `manage_adr(mode="get")` — **每次接到修改任務先讀這個**，內含不可違反的設計取捨 |
| 找函式/類別/route 定義 | `search_graph`：自然語言用 `query`（BM25，camelCase 自動拆詞）；精確名稱用 `name_pattern`（regex）；近義詞用 `semantic_query`（**必須是字串陣列**，如 `["upload","resize"]`） |
| 找字串/註解/文案出處 | `search_code`（圖譜增強 grep）：預設 `mode="compact"` 省 token，必要才 `"full"`；用 `path_filter` 縮小範圍 |
| **改動任何函式之前** | `trace_path(function_name, direction="inbound")` 先看誰依賴它；影響面大（如 `getSupabaseAdmin`、`jsonError`）就提高謹慎度 |
| 追資料流（值如何流動） | `trace_path(mode="data_flow", parameter_name=...)` |
| 讀單一符號的原始碼 | 先 `search_graph` 拿 `qualified_name` → `get_code_snippet`（不要用短名瞎猜） |
| 多跳關係、聚合、複雜度熱點 | `query_graph`（Cypher）。節點：Function/Method/Class/Interface/File/Module/Variable/EnvVar；邊：CALLS/IMPORTS/DEFINES/CONFIGURES/TESTS_FILE/IMPLEMENTS/USAGE。Function 節點帶 complexity/cognitive/loop_depth/transitive_loop_depth/linear_scan_in_loop 等屬性可直接查 |
| 改完程式碼之後 | `detect_changes` 看影響 → `index_repository(mode="fast")` 重建索引（結構性大改才用 `moderate`/`full`；語意搜尋需要 moderate 以上） |
| 完成重大設計決策後 | `manage_adr(mode="update")` 回寫（六節：PURPOSE/STACK/ARCHITECTURE/PATTERNS/TRADEOFFS/PHILOSOPHY，整份覆寫，先 get 再合併） |

**分頁與 token 紀律：**

- 回應帶 `total`/`has_more`：先用 `label`、`file_pattern`、`min_degree` 縮小，不要盲目翻頁。
- `query_graph` 在 Cypher 內自帶 `LIMIT`。

**紅線（違反即停止並回報）：**

1. `index_repository` 的 `persistence` 永遠保持 `false`——repo 內不得出現 `.codebase-memory/`。
2. 不得將 `.env*` 內容、API key、service role key 放入任何查詢、輸出、ADR 或索引操作；圖譜的 `EnvVar` 節點只能用於「引用位置」分析，不得嘗試取值。
3. 涉及 quota、auth、Supabase RLS、FASHN、migration 的結論只能輸出「分析與修改計畫」，未經使用者明確核准不得動工。
4. 圖譜是輔助索引，不是真相來源——關鍵修改前仍須 Read 實際檔案確認現況。

## 7. 已知限制與待改善項目

- **只支援上衣**：`garmentType` 寫死 `"tops"`；褲子/洋裝/外套、全身照、多件試穿刻意留到之後（架構已預留 `category` 欄位與 `garmentType` 參數）。
- **既有匿名資料不搬移**：V0.1 測試列可保留在資料庫，但任何正式會員流程都不得讀寫或合併這些資料。
- **照片驗證只有基礎檢查**：格式/大小/解析度而已，不做電腦視覺判斷（多人、遮擋、背面照等交給 VTO API 端失敗後的錯誤轉譯）。
- **輪詢由前端驅動、無 webhook/queue**：使用者在生成期間關閉視窗，job 可能永遠停在 `processing`（provider 端已完成也不會回寫）。
- **資料保留工作需受控部署**：`vercel.json` 已排程照片、通知與營運資料的保留工作，但正式啟用前仍須依 `docs/V1_OPERATIONS.md` 完成 staging 演練；目前沒有臉部模糊或 GDPR 式資料匯出。
- **時區寫死台北（UTC+8）**：`quota.ts` 的「每日」邊界。
- **mock provider 只是視覺合成**：人物照 + 上衣縮圖 + 「MOCK 預覽」浮水印，非真實 AI 效果。
- **CI 只涵蓋離線 test + deterministic cases + lint**：push／PR 會執行 Vitest、16 個固定 Workflow 案例與 ESLint；不會取代需要真實 Supabase、Cron、Email、金流供應商的 staging 驗證。
- **Mock Payment 不是正式金流**：正式對外收款、退款與 Webhook 驗證仍需選定並整合真實金流供應商。

## 8. 後續開發建議

依優先順序：

1. **整合真實金流**：選定供應商後完成付款、退款、Webhook 驗證與 staging 演練，才可對外正式收款。
2. **處理「輪詢中斷」的殘留 job**：加一個逾時回收機制（例如查詢時發現 `processing` 超過 N 分鐘就向 provider 查一次最終狀態或標記 failed），避免額度被永遠卡住的任務占用且狀態不準。
3. **擴大 CI 驗證範圍**：保留離線測試的快速回饋，並在不暴露 secret 的前提下建立 staging migration／RLS 與端到端驗證流程。
4. **擴充品類**：新增 `bottoms`/`dresses` 時，沿 `category` 欄位 + `garmentType` 參數 + provider factory 的既有預留擴充，不需要動架構。
