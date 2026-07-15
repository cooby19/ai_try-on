# AI 虛擬試衣 V0.7

使用者上傳**正面半身照**、選擇一件**上衣**商品，系統透過 Virtual Try-On API 產生試穿預覽圖。V0.7 加入結帳、Mock 模擬付款、付款結果 Webhook 與歷史訂單查詢；模擬金流不會連線第三方支付或進行實際扣款。

## 技術架構

- **前端／後端**：Next.js 16（App Router、TypeScript、Tailwind CSS）
- **資料庫／圖片儲存**：Supabase（Postgres + 私有 Storage bucket，前端只拿短期 signed URL）
- **AI 生成**：可替換的 VTO provider 抽象層
  - `mock`（須明確啟用）：不需 API key，約 3 秒回傳示範合成圖，可跑通完整流程
  - `fashn`：真實的 [FASHN Virtual Try-On API](https://fashn.ai)
- **會員登入**：Supabase Auth（Google OAuth + Email 6 位數 OTP），Auth `user.id` 是唯一正式使用者 ID

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
   - `003_direct_upload_constraints.sql`（人物照直傳的 8MiB／MIME bucket 限制；既有專案必跑）
   - `004_secure_anonymous_sessions.sql`（安全匿名 session、來源額度與平台預算熔斷；既有專案必跑）
   - `005_supabase_auth_users.sql`（Supabase Auth 使用者同步、正式會員外鍵、移除匿名額度入口；V0.2 必跑）
   - `006_account_deletion_requests.sql`（帳戶刪除申請、pending 唯一限制與 RLS；V0.4 必跑）
   - `007_persistent_cart.sql`（商品尺寸／庫存、帳號購物車、冪等訪客合併 RPC；V0.5 必跑）
   - `008_checkout_orders.sql`（地址簿、運送方式、原子結帳與待付款訂單；V0.6 必跑）
   - `009_mock_payments_and_order_history.sql`（Mock 付款、Webhook 冪等事件與訂單付款狀態；V0.7 必跑）
   - `010_inventory_reservations.sql`（庫存保留、付款成功才扣庫存、失敗／取消／逾期自動釋放；V0.7 必跑）

### 3. 設定環境變數

```bash
cp .env.local.example .env.local
```

打開 `.env.local`，填入（Supabase Dashboard → Project Settings → API）：

| 變數 | 說明 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 專案 URL（Auth browser/server client 使用） |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | publishable key（可放前端；不是 service role） |
| `SUPABASE_URL` | 後端管理 client 使用的專案 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key（**只在後端使用，不會進前端 bundle**） |
| `MOCK_PAYMENT_WEBHOOK_SECRET` | 至少 32 字元的隨機值；僅供後端驗證 Mock Webhook，並非真實金流憑證 |
| `VTO_PROVIDER` | `fashn`（預設）、`fashn-max` 或僅供流程展示的 `mock` |
| `FASHN_API_KEY` | 只有用 `fashn` 時需要 |
| `PLATFORM_DAILY_BUDGET_USD` | 每日可預留的 AI 成本上限（USD） |

### 4. 設定 Supabase Auth

1. **Authentication → URL Configuration**
   - Site URL：本機填 `http://localhost:3000`，正式環境填實際 HTTPS 網域。
   - Redirect URLs：本機加入 `http://localhost:3000/**`；正式環境精確加入 `https://你的網域/auth/callback`。
2. **Authentication → Providers → Google**
   - 在 Google Auth Platform 建立 Web application OAuth client。
   - Authorized JavaScript origins 加入 `http://localhost:3000` 與正式網域。
   - Google 的 Authorized redirect URI 必須填 Supabase 顯示的 callback：
     `https://<project-ref>.supabase.co/auth/v1/callback`。
   - 將 Google Client ID / Client Secret 填回 Supabase Google provider 並啟用。
3. **Authentication → Email Templates → Magic Link**
   - 本專案採 Email OTP，不使用密碼。把信件內容改為顯示 6 位數 token，例如：
     ```html
     <h2>你的登入驗證碼</h2>
     <p>請在登入頁輸入：{{ .Token }}</p>
     ```
   - Email OTP 預設 60 秒內不可重寄、1 小時到期；正式環境建議設定自有 SMTP。
4. 確認 **Authentication → Providers → Email** 已啟用。前端只呼叫 `signInWithOtp` / `verifyOtp`，沒有密碼登入入口。

### 5. 啟動

```bash
npm run dev
```

打開 http://localhost:3000 → 選商品 → 「AI 試穿」→ 登入 → 上傳照片 → 生成。

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
| 平台每日成本預算 | 環境變數，預設 USD 5 | `PLATFORM_DAILY_BUDGET_USD` |

額度直接統計 `try_on_jobs` 當日筆數（台北時區），失敗的生成也計入（因為已產生 API 成本）。每筆任務都記錄 `provider`、`cost_estimate`、`status`、`retry_count`、`error_message`。

## API 一覽

| Method | Path | 說明 |
|---|---|---|
| POST | `/api/upload` | 申請直傳授權／完成 Storage 圖片驗證與正規化（只收 JSON） |
| GET | `/api/upload?path=` | 刷新本人照片的短效 signed display URL |
| POST | `/api/try-on` | 建立試穿任務（額度檢查 → 呼叫 provider） |
| GET | `/api/try-on/[jobId]` | 輪詢任務狀態 |
| DELETE | `/api/try-on/[jobId]` | 刪除本人的試穿照片，保留 job／額度紀錄 |
| POST | `/api/feedback` | 滿意 / 不滿意回饋 |
| GET | `/api/quota?productId=` | 查詢剩餘額度 |
| POST | `/api/account/deletion-request` | 為目前登入者建立帳戶刪除申請（不直接刪帳） |
| GET | `/api/cart` | 取得目前登入帳號的資料庫購物車 |
| POST | `/api/cart/items` | 將指定尺寸規格加入登入帳號購物車 |
| PATCH | `/api/cart/items/[variantId]` | 更新本人購物車內指定規格的數量 |
| DELETE | `/api/cart/items/[variantId]` | 移除本人購物車內指定規格 |
| POST | `/api/cart/merge` | 將訪客購物車冪等合併至登入帳號 |
| POST | `/api/cart/resolve` | 依資料庫目前價格與庫存解析訪客購物車，不持久化 |
| GET | `/api/orders` | 取得目前登入者的歷史訂單與付款狀態 |
| POST | `/api/orders` | 從目前登入者的購物車建立待付款訂單 |
| POST | `/api/orders/[orderId]/mock-payment` | 為本人的待付款訂單模擬成功／失敗／取消／逾期 |
| POST | `/api/payments/mock/webhook` | 接收具 HMAC 簽章的 Mock 付款結果並冪等更新訂單 |

## V0.7 Mock 付款資料流

1. 結帳以資料庫交易建立 `pending_payment` 訂單，完成後導向 `/orders/[orderId]/payment`。
2. 使用者在 Sandbox 選擇模擬結果；後端產生不可由前端指定的交易編號、事件 ID 與 HMAC 簽章。
3. Webhook 共用處理器驗證簽章與 payload，再由單一 Postgres RPC 鎖定訂單、記錄事件並更新付款／訂單狀態。
4. 相同 `event_id` 重送只回傳既有結果；終態之後晚到的不同事件會保留稽核紀錄，但不覆寫成功或其他既有結果。
5. `/orders` 與 `/orders/[orderId]` 都先驗證 Supabase Auth 使用者，後端查詢同時限制 `user_id`；未登入者會被導向登入。

## V0.7 庫存保留規則

- 加入或修改購物車不會扣減 `stock_quantity`。
- 建立待付款訂單時會建立 30 分鐘的庫存保留；可售量以「實際庫存 − 有效保留量」計算。
- Mock Payment Webhook 只有在回傳成功時才會在同一筆資料庫交易中扣減實際庫存並完成保留。
- 付款失敗、取消、逾期與保留到期時只釋放保留，不會扣減實際庫存；相同 Webhook 事件重送不會重複扣除或釋放。

## V0.5 購物車資料流

- 未登入：localStorage 只保存 `guestCartId`、尺寸規格 ID 與數量；商品名稱、價格、圖片、庫存與總額每次由 `/api/cart/resolve` 重新取得。
- 登入：頁面啟動時把訪客品項送到 `/api/cart/merge`。資料庫以 `user_id + guestCartId` 記錄已處理批次，即使回應途中斷線再重送，也不會重複累加。
- 已登入操作：加入、更新、移除都先用 Supabase Auth session 取得可信 `user.id`，前端不能指定其他帳號；API 回傳完整權威購物車後才更新畫面。
- 跨裝置：購物車綁定帳號存在 Supabase；每次載入、操作完成及瀏覽器視窗重新取得焦點時刷新。V0.5 不啟用即時推播。
- 庫存：每個尺寸最多 99 件且不得超過實際庫存。庫存下降時會下修仍可售品項；缺貨或下架品項保留並標示，但不計入總額。

## 隱私設計

- 人物照與結果圖存放在**私有** bucket，前端只拿 1 小時有效的 signed URL
- 所有上傳、額度、生成、輪詢、回饋與刪除 API 都先驗證 Supabase Auth session，並只用目前登入者的 `auth.users.id` 存取資料
- 登入購物車 API 同樣不接受前端 `user_id`；RLS 不提供 anon/authenticated policy，所有 DB 操作只由後端 service role 執行
- 購物車總額只使用資料庫當下價格計算，localStorage 或請求內偽造的價格欄位不會被採用
- 未登入仍可瀏覽商品；AI 試穿與會員額度不提供匿名模式，既有匿名測試資料不搬移也不再被流程使用
- 原始人物照以綁定隨機 `.upload` path 的 Supabase signed URL 直傳；後端以 10 分鐘 HMAC 完成憑證核對使用者、path、MIME 與 bytes，驗證成功後才建立正式 `.jpg`
- Supabase signed upload URL 官方固定約 2 小時且不能自訂 TTL；以 `upsert=false`、不可猜 path、8MiB/MIME bucket 限制、完成後的 1-byte path lock 與「正式 `.jpg` 才能進 AI」降低風險
- 使用者可在結果頁或 `/account` 刪除自己的試穿照片：未被其他試穿引用的 Storage 檔案會刪除、該 job 的圖片欄位會清空，但 job 列保留——否則使用者可以靠「生成 → 刪除」重複刷每日額度，成本指標也會失真
- 若同一人物照被重新生成的多筆 job 共用，刪除單筆時先移除該筆引用，最後一筆引用刪除時才移除 Storage 檔案，避免破壞仍保留的試穿結果
- `/account` 會清楚標示照片已刪除；刪除不可復原，但商品、狀態、時間、用量與必要成本資訊可能為防濫用與成本稽核保留
- 帳戶刪除按鈕只建立 `account_deletion_requests` 的 pending 申請，不會直接刪除 Supabase Auth 使用者、照片或資料列；後續需由營運／管理流程審核處理
- API key 只存在後端環境變數（已驗證不會出現在前端 bundle）
- TODO（未來強化）：定期自動清除逾期照片、上傳前臉部模糊選項、GDPR 式資料匯出

## 測試方式（mock provider）

1. 商品頁點「AI 試穿」→ Google 或 Email OTP 登入 → 上傳一張人物照（沒有現成照片可用 `public/samples/sample-person.jpg`）→ 約 3 秒後看到示範結果圖（含 MOCK 浮水印）
2. 按「滿意 / 不滿意」→ Supabase `try_on_feedback` 表會多一筆
3. 同一商品連續生成 3 次 → 第 4 次會被「此商品重試上限」擋下
4. 換不同商品湊滿當日 3 次 → 再生成會被「每日上限」擋下
5. 約 4MB、8MB 圖片可直傳；txt 或超過 8MB 的檔案會在送出前得到可操作的錯誤訊息

## 購物車跨裝置驗證

1. 在未登入瀏覽器選擇商品尺寸並加入購物車；重新整理 `/cart`，內容應保留。
2. 登入前先讓同一帳號在資料庫購物車擁有相同尺寸；登入後兩邊數量應相加，但不得超過該尺寸庫存或 99。
3. 用另一個瀏覽器或裝置登入同一帳號，開啟 `/cart`，應看到相同品項、尺寸與數量。
4. 在第二裝置改數量，回第一裝置重新聚焦視窗，應自動取得更新後資料。
5. 改登入另一個帳號，確認購物車內容完全隔離。
6. 在 Supabase 將規格庫存改小、改為 0，或將商品／規格 `is_active` 設為 false；重新載入後應分別下修數量或標示不可購買，且不可售品項不計入總額。
7. 修改 localStorage 加入偽造 `price`，重新整理後金額仍應使用資料庫價格。

## 專案結構

```
src/
├── lib/
│   ├── vto/            # VTO provider 抽象層（mock / fashn / factory）
│   ├── quota.ts        # 額度檢查與任務紀錄
│   ├── validation.ts   # 照片格式/大小/解析度檢查
│   ├── supabase.ts     # 後端專用 Supabase client + signed URL
│   ├── user.ts         # Supabase Auth 使用者驗證
│   ├── account.ts      # 帳戶中心最小 DTO 與本人資料查詢
│   ├── supabase/       # browser/server/proxy SSR Auth clients
│   └── images.ts       # 圖片載入/轉檔工具
├── app/
│   ├── api/            # upload / try-on / feedback / quota / account / cart
│   ├── account/        # 帳戶中心（基本資料、試穿、隱私、危險操作）
│   ├── cart/           # 獨立購物車頁
│   ├── page.tsx        # 商品列表
│   └── products/[id]/  # 商品頁
└── components/         # 試穿元件、CartProvider、購物車頁與加入按鈕
supabase/migrations/               # 001–009：核心資料、購物車、結帳與 Mock 金流
```

## 未來擴充（刻意不在第一版做）

褲子/洋裝/外套、全身照、多件試穿、完整尺寸推薦、商家後台、多 provider 自動路由、queue/webhook、自建模型。架構上已預留：`category` 欄位、`garmentType` 參數、provider factory。
