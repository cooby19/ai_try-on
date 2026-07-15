# Vercel 部署指南

本文件說明如何把「樣衣間 — AI 虛擬試衣 MVP」部署到 Vercel。

> **為什麼選 Vercel**：本專案的 VTO provider 刻意拆成 `submit()` / `checkStatus()` 兩段、前端 2 秒輪詢，每個 API 請求都很短——就是為 serverless 設計的。Next.js 16 是 Vercel 自家框架，`sharp` 在其 Node.js runtime 原生支援，資料與檔案又都託管在 Supabase，所以部署面只剩「跑 Next.js」一件事，幾乎零改動即可上線。

---

## 前置需求

- 專案已推到 GitHub / GitLab / Bitbucket（Vercel 由此匯入並自動部署）。
- 一個已建好、且**已跑過 migration** 的 Supabase 專案（見下方步驟 1）。
- 若要跑真實 AI：一把 [FASHN API key](https://fashn.ai)。
- 若要開結果圖放大：一個 [Replicate API token](https://replicate.com/account/api-tokens)。
- 確認 `.env.local` **沒有**被提交（已被 `.gitignore` 排除，本機金鑰不會外洩到 repo）。

專案採 Next.js 預設建置（`next build`），`next.config.ts` 為預設空設定，**不需要** `vercel.json` 或 `Dockerfile`。

---

## 步驟 1：準備 Supabase（部署前必做）

1. 在 Supabase Dashboard 進 **SQL Editor**，依序執行 `001_init.sql` 至 `009_mock_payments_and_order_history.sql`。
   - 會建立包含帳戶刪除申請、尺寸庫存、購物車、訂單與 Mock 付款在內的應用資料表、2 個私有 storage bucket（`person-uploads`、`try-on-results`）、3 件種子商品。
   - migration 內含對 `service_role` 的明確 `GRANT`——新版 `sb_secret_` 金鑰在 SQL Editor 建表後**不會自動授權**，這段不可略過，否則後端讀寫會 permission denied。
   - 到 **Storage → Settings** 確認 Global file size limit 至少為 8MiB；`003` 會再把 `person-uploads` bucket 鎖成 8MiB 且只允許 JPEG/PNG/WebP。
2. 到 **Project Settings → API**，記下：
   - `Project URL` → 之後填 `SUPABASE_URL` 與 `NEXT_PUBLIC_SUPABASE_URL`
   - publishable key → 之後填 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `service_role` key → 之後填 `SUPABASE_SERVICE_ROLE_KEY`（**只放後端環境變數，絕不進前端**）
3. 記下專案所在 **Region**（如 `ap-southeast-1` 新加坡），步驟 4 讓 Vercel function 就近部署用。

---

## 步驟 2：在 Vercel 匯入專案

1. 登入 [vercel.com](https://vercel.com) → **Add New… → Project**。
2. 選擇本 repo，按 **Import**。
3. Framework Preset 會自動偵測為 **Next.js**，Build Command / Output 保持預設即可（`next build`）。
4. **先不要按 Deploy**，先展開 **Environment Variables** 把下方變數填完（步驟 3），再部署——否則第一次部署會因缺變數而在執行期報錯。

---

## 步驟 3：設定環境變數

在 **Settings → Environment Variables** 逐一新增下列變數。建議每個變數都同時勾選 **Production** 與 **Preview** 兩個環境（Preview 供 PR 預覽用）。

| 變數 | 值 | 何時需要 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 專案 URL | 一律必填（Auth） |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key | 一律必填（可公開，不是 service role） |
| `SUPABASE_URL` | Supabase 專案 URL | 一律必填 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key | 一律必填（**僅後端**） |
| `MOCK_PAYMENT_WEBHOOK_SECRET` | 至少 32 字元的隨機值 | 一律必填；只驗證 Mock Webhook，並非真實金流憑證 |
| `VTO_PROVIDER` | `mock` / `fashn` / `fashn-max` | 一律必填；正式跑 AI 設 `fashn` |
| `FASHN_API_KEY` | FASHN API key | `VTO_PROVIDER=fashn` 或 `fashn-max` 時必填 |
| `ENHANCE_PROVIDER` | `none`（預設）/ `realesrgan` | 一律建議設；MVP 用 `none` |
| `REPLICATE_API_TOKEN` | Replicate API token | 僅 `ENHANCE_PROVIDER=realesrgan` 時必填（**僅後端**） |
| `PLATFORM_DAILY_BUDGET_USD` | 例如 `5` | 一律必填；達到當日預算時停止新的 AI 呼叫 |

> **MVP 建議組合**：`VTO_PROVIDER=fashn` + `ENHANCE_PROVIDER=none`。先跑通真實生成，放大後處理之後要開再開。若只想 demo 流程不花 API 錢，設 `VTO_PROVIDER=mock` 即可。
>
> **安全提醒**：`SUPABASE_SERVICE_ROLE_KEY`、`FASHN_API_KEY`、`REPLICATE_API_TOKEN` 只會被後端 API route 讀取，不會進前端 bundle。只有 Supabase URL 與 publishable key 可使用 `NEXT_PUBLIC_*`。

---

## 步驟 4：設定執行區域（Region）

為減少「下載人物照 → 呼叫 provider → 存結果圖」與 Supabase 之間的來回延遲，把 Vercel function 部署到**靠近 Supabase 的區域**。

- **Settings → Functions → Function Region**，選與 Supabase 相同或相鄰的區域（例：Supabase 在新加坡 `ap-southeast-1`，Vercel 選 Singapore `sin1`）。

---

## 步驟 5：部署

1. 回到專案頁按 **Deploy**（或推一個 commit 觸發自動部署）。
2. 等建置完成，Vercel 會給一個 `https://<project>.vercel.app` 網址。
3. 之後每次 push 到預設分支 → 自動部署到 Production；每個 PR → 自動產生 Preview 部署。

---

## 步驟 6：部署後煙霧測試（Smoke Test）

用給的網址實際走一遍主流程，確認線上環境接得起後端與外部服務：

1. 開首頁，確認商品列表出得來（代表 Server Component 能連上 Supabase、GRANT 正常）。
2. 依 README 設好 Supabase Auth 的 Site URL、Redirect URL、Google provider 與 Email OTP template；進商品頁點「AI 試穿」應先導向登入，登入後才顯示 modal 與額度。
3. 分別上傳約 4MB、8MB 的正面半身照 → 應出現預覽（代表瀏覽器直傳 Storage、後端完成驗證與 private bucket signed URL 正常）。
   - 瀏覽器 Network 面板中，大圖 PUT 目的地應為 `*.supabase.co/storage/...`，不可是 Vercel `/api/upload`。
4. 按「開始 AI 試穿」→ 前端開始輪詢，最終出結果圖：
   - `VTO_PROVIDER=mock`：約 3 秒回合成示範圖。
   - `VTO_PROVIDER=fashn`：實際呼叫 FASHN，會扣一次額度與 API 成本。
5. 對結果按滿意 / 不滿意（`POST /api/feedback`），再測「刪除照片」。
6. 進 `/account`，確認只顯示目前帳戶的試穿紀錄；刪除一筆照片後應立即顯示「照片已刪除」，job 與額度資料仍保留。
7. 在「危險操作」展開二次確認並送出帳戶刪除申請；`account_deletion_requests` 應只有一筆 pending，頁面應停用重複送出。此步驟不應刪除 Auth 使用者或其他資料。
8. 未登入先加入不同尺寸並重新整理 `/cart`；登入後確認本機品項合併，再用另一個瀏覽器登入同一帳號確認跨裝置內容一致。第二個瀏覽器修改數量後，第一個瀏覽器重新聚焦應同步。
9. 建立訂單後，在 Mock Payment Sandbox 分別測試成功、失敗、取消與逾期；成功時訂單應顯示「處理中」，並可在 `/orders` 與詳情頁看到交易編號及 Webhook 紀錄。

若某步失敗，先看 Vercel **Deployments → 該次部署 → Functions / Logs** 的錯誤，多半是環境變數缺漏或 Supabase GRANT 沒跑。

---

## 選配：啟用結果圖放大（`realesrgan`）時的注意事項

放大後處理是在輪詢用的 `GET /api/try-on/[jobId]` route 內、生成成功後**同步**執行的，硬逾時 30 秒（`ENHANCE_TIMEOUT_MS`）。加上下載/上傳往返，這條 route 可能需要接近 35 秒。

Vercel function 有預設執行時間上限，若不調整，這條 route 可能在放大途中被砍斷（雖然程式會降級回原圖、job 仍標 `success`，但白花了 Replicate 成本）。啟用 `realesrgan` 前，請替**輪詢 route** 提高上限：

在 `src/app/api/try-on/[jobId]/route.ts` 加上 route segment 設定：

```ts
// 放大後處理最長 30 秒（ENHANCE_TIMEOUT_MS）＋ 下載/上傳往返，需放寬此 route 的執行上限
export const maxDuration = 60;
```

> Hobby 方案可設到 60 秒；需要更長請升級方案。`ENHANCE_PROVIDER=none`（預設）時完全用不到這段，可略過。

---

## 常見問題

**Q：首頁商品列表空白或 500？**
多半是 Supabase migration 沒跑，或 `service_role` GRANT 缺失（新版金鑰坑）。回步驟 1 重跑 `001_init.sql`。

**Q：可以用 Edge Runtime 嗎？**
不行。本專案用 `sharp` 做圖片轉正/壓縮/合成，需要 Node.js runtime。Next.js 的 API route 預設就是 Node runtime，維持預設即可，不要改成 `export const runtime = "edge"`。

**Q：要不要自訂網域？**
Settings → Domains 加入自有網域即可，非必要。

**Q：怎麼回滾？**
Deployments 列表挑一個先前成功的部署 → **Promote to Production**，即可即時回滾。

**Q：額度會被清掉嗎？**
額度是統計 `try_on_jobs` 當日筆數（台北時區 UTC+8），存在 Supabase，與 Vercel 部署無關；重新部署不影響既有額度與資料。

---

## 上線前最終檢查清單

- [ ] `001` 至 `009` migrations 已依序在正式 Supabase 專案執行。
- [ ] Vercel 已設好全部必要環境變數（Production + Preview）。
- [ ] `VTO_PROVIDER` / `ENHANCE_PROVIDER` 設為預期值，對應的 key 已填。
- [ ] Function Region 已設在靠近 Supabase 的區域。
- [ ] （若開 `realesrgan`）輪詢 route 已加 `maxDuration = 60`。
- [ ] 部署後煙霧測試（步驟 6）全部通過。
- [ ] `.env.local` 未被提交到 repo。
