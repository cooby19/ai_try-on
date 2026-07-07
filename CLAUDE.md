@AGENTS.md

# CLAUDE.md

本文件是給 AI 助理（Claude Code 等）的專案指南。修改任何程式碼之前，請先讀完本文件，並遵守「AI 協作注意事項」章節的規則。

## 1. 專案概述

- **產品名稱**：樣衣間 — AI 虛擬試衣 MVP。
- **核心功能**：使用者上傳**正面半身照**、選擇一件**上衣**商品，系統透過 Virtual Try-On（VTO）API 產生「只替換上衣、盡量保留人物與背景」的試穿預覽圖。
- **定位**：Demo / MVP。第一版刻意只做上衣（`category = 'tops'`），購物車按鈕是假動作（`AddToCartButton` 只切換文字，無實際購物車系統）。
- **不需登入**：使用匿名 cookie（`vto_uid`，httpOnly、一年效期）識別使用者。
- **內建三大機制**：
  - 成本控管 — 每人每日最多生成 3 次、每商品每人最多重試 2 次，失敗也計入額度。
  - 回饋紀錄 — 使用者對結果按「滿意 / 不滿意」，寫入 `try_on_feedback` 表。
  - 隱私設計 — 照片存私有 bucket、前端只拿 1 小時 signed URL、使用者可刪除自己的照片。

## 2. 專案架構

### 2.1 資料夾結構

```
src/
├── app/
│   ├── layout.tsx              # 全站 layout（zh-TW、header/footer、免責文案）
│   ├── page.tsx                # 首頁商品列表（Server Component，直接查 DB）
│   ├── products/[id]/page.tsx  # 商品頁（Server Component）
│   └── api/                    # 所有後端邏輯（Route Handlers）
│       ├── upload/route.ts         # POST 上傳人物照
│       ├── try-on/route.ts         # POST 建立試穿任務
│       ├── try-on/[jobId]/route.ts # GET 輪詢狀態 / DELETE 刪除照片
│       ├── quota/route.ts          # GET 查詢剩餘額度
│       └── feedback/route.ts       # POST 滿意度回饋
├── components/                 # Client Components（"use client"）
│   ├── TryOnLauncher.tsx       # 試穿 modal：上傳 → 預覽 → 生成 → 輪詢
│   ├── TryOnResult.tsx         # 結果對比、回饋、重新生成、刪除
│   └── AddToCartButton.tsx     # 示範用假購物車按鈕
└── lib/                        # 後端共用邏輯（大多不可在 client import）
    ├── vto/
    │   ├── provider.ts         # VTOProvider 介面（submit + checkStatus 兩段式）
    │   ├── mock.ts             # mock provider：3 秒後回傳合成示範圖
    │   ├── fashn.ts            # FASHN API adapter（tryon-v1.6）
    │   ├── fashn-max.ts        # FASHN Try-On Max adapter（共用 FASHN_API_KEY）
    │   └── index.ts            # provider factory + 使用者模型白名單（v1.6/max → provider 名稱）
    ├── supabase.ts             # service role client + signed URL（僅限後端）
    ├── quota.ts                # 額度檢查與 try_on_jobs 讀寫
    ├── user.ts                 # 匿名 cookie 使用者
    ├── validation.ts           # 照片格式 / 大小 / 解析度檢查
    ├── images.ts               # 圖片載入、轉 PNG、base64 工具
    ├── http.ts                 # jsonError / errorMessage 共用工具
    └── types.ts                # 共用型別（對應資料表 + API view）
supabase/migrations/001_init.sql  # 資料表、RLS、GRANT、bucket、種子商品
public/garments/                  # 種子商品的上衣圖（SVG / JPG）
public/samples/sample-person.jpg  # 測試用人物照
.claude/launch.json               # preview 用 dev server 設定（npm run dev，port 3000）
vitest.config.ts                  # Vitest 設定（node 環境、@/* alias）
eslint.config.mjs                 # ESLint flat config（eslint-config-next）
```

單元測試檔與被測檔同層（`src/lib/quota.test.ts`、`src/lib/validation.test.ts`、`src/lib/vto/fashn.test.ts`、`src/lib/vto/fashn-max.test.ts`、`src/lib/vto/index.test.ts`），上面的樹狀圖省略未列。

### 2.2 分層關係

- **前端（Client Components）** 只呼叫自家 `/api/*` 端點，完全接觸不到 Supabase 金鑰與 VTO API key。
- **Server Components**（`page.tsx`）直接用 `getSupabaseAdmin()` 查 DB 讀商品，不經過 API route。
- **API Routes** 是唯一的後端：驗證輸入 → 檢查額度 → 存取 Supabase → 呼叫 VTO provider。
- **Supabase** 負責 Postgres（4 張表）與 Storage（2 個私有 bucket：`person-uploads`、`try-on-results`）。
- **VTO provider 抽象層**：`VTOProvider` 介面拆成 `submit()`（送出任務、回傳 provider 端任務 ID）與 `checkStatus()`（輪詢），因為主流 VTO API 都是非同步「送出 → 輪詢」模式，serverless route 不必長時間等待。要接新供應商（如 fal.ai）只需實作介面並在 `src/lib/vto/index.ts` 的 factory 註冊。

### 2.3 資料表（見 `supabase/migrations/001_init.sql`）

| 資料表 | 用途 |
|---|---|
| `users` | 匿名使用者（uuid 主鍵；`email` 欄位保留給未來登入功能） |
| `products` | 商品（含 `garment_image_url` 給 VTO 用、`category` 預設 `'tops'`、`size_chart` jsonb） |
| `try_on_jobs` | 每次試穿任務：狀態機 `pending → processing → success/failed`，含 `provider`、`provider_job_id`、`cost_estimate`、`retry_count`、`error_message` |
| `try_on_feedback` | 滿意 / 不滿意回饋（`rating` 限 `satisfied`/`unsatisfied`） |

- 所有表 **RLS 全開且不建任何 public policy**：資料只能經由後端（service role）存取，anon key 外洩也讀不到資料。
- Migration 內含對 `service_role` 的明確 `GRANT`——新版 Supabase 專案（`sb_secret_` 金鑰）在 SQL Editor 建表後不會自動授權，這段不可刪除。

## 3. 核心功能流程

### 3.1 AI 試穿主流程

1. 商品頁點「AI 試穿」→ `TryOnLauncher` 開 modal，先打 `GET /api/quota?productId=` 顯示剩餘額度；回應中的 `defaultModel`（`"v1.6" | "max" | null`）決定是否顯示生成模型選擇器（`null` = mock 模式，隱藏選擇器）。
2. 使用者上傳照片 → `POST /api/upload`：驗證格式（JPG/PNG/WebP、≤8MB、寬度 ≥320px）→ sharp 依 EXIF 轉正、壓成寬度 ≤1024 的 JPEG → 存入私有 bucket `person-uploads`（路徑 `{userId}/{uuid}.jpg`）→ 回傳 Storage 路徑 + 預覽用 signed URL。
3. 按「開始 AI 試穿」→ `POST /api/try-on`：
   - 驗證 `personImagePath` 必須以 `{userId}/` 開頭（防止拿別人的照片生成）。
   - 選用欄位 `model`（`"v1.6"` 或 `"max"`）經 `resolveVTOProviderName()` 白名單映射成 provider 名稱（`fashn` / `fashn-max`）：不合法值回 400（此時尚未建 job、不占額度）；`VTO_PROVIDER=mock` 時忽略選擇一律用 mock；未傳則沿用 `VTO_PROVIDER` 預設。**前端不得直接傳 provider 內部名稱**（防止注入 `mock` 取得免費假結果）。兩種模型共用同一套每日額度，不分開計。
   - `checkGenerationQuota()` 檢查每日 3 次與每商品 3 次（首次 + 2 次重試）上限。
   - 建立 `try_on_jobs` 紀錄（**建立紀錄本身就是額度 +1**，設計上刻意不用計數器欄位，避免不同步）。
   - 插入後、呼叫 provider 前，`verifyJobWithinQuota()` 以 (created_at, id) 名次複驗額度（防前置檢查與插入之間的並發競態）：競態落敗列會被**整列刪除**並回 429——該列從未呼叫 AI API、零成本，是 3.2「保留 job 列」規則的刻意例外（詳見 `quota.ts` 註解）。
   - 從 Storage 下載人物照、載入上衣圖 → `provider.submit()` → 狀態改 `processing`，回傳 `jobId`。
   - 送出失敗時：狀態改 `failed` 並寫 `error_message`，回 502——**失敗仍占額度**（已產生 API 成本）。
4. 前端每 2 秒輪詢 `GET /api/try-on/[jobId]`（上限 120 秒）：
   - 後端向 provider `checkStatus()`；成功時把結果圖存入私有 bucket `try-on-results`，狀態改 `success`。
   - 回傳 `TryOnJobView`（圖片一律轉成 1 小時 signed URL，不回傳 Storage 路徑以外的內部資訊）。
5. 結果頁（`TryOnResult`）：原圖 / 結果對比、免責文案、滿意/不滿意回饋（`POST /api/feedback`）、重新生成、刪除照片。

### 3.2 刪除流程（隱私 vs 成本控管的取捨）

`DELETE /api/try-on/[jobId]`：

- 結果圖檔案刪除；人物照**先確認沒有其他 job 引用**（重新生成會共用同一張人物照）才刪檔案。
- job 資料列**保留**，只清空圖片欄位——因為額度是統計當日 `try_on_jobs` 筆數，若整列刪除，使用者就能靠「生成 → 刪除」重複刷額度，成本指標也會失真。**不要改成整列刪除。**

### 3.3 API 一覽

| Method | Path | 說明 |
|---|---|---|
| POST | `/api/upload` | 上傳人物照（驗證 → 壓縮 → 私有 bucket） |
| POST | `/api/try-on` | 建立試穿任務（額度檢查 → 呼叫 provider）；選用 body 欄位 `model: "v1.6" \| "max"` 選擇生成模型 |
| GET | `/api/try-on/[jobId]` | 輪詢任務狀態（processing 時順便向 provider 查進度） |
| DELETE | `/api/try-on/[jobId]` | 刪除照片、保留 job 列（隱私） |
| POST | `/api/feedback` | 滿意 / 不滿意回饋 |
| GET | `/api/quota?productId=` | 查詢剩餘額度；回應含 `defaultModel`（`null` = 不開放選模型） |

錯誤回應統一格式：`{ status: "failed", message: "<可操作的繁中訊息>" }`（見 `src/lib/http.ts`）。

## 4. 技術棧與外部服務

| 類別 | 技術 / 版本 | 備註 |
|---|---|---|
| 框架 | Next.js **16.2.10**（App Router）+ React 19 | **此版本與訓練資料有 breaking changes**，寫程式前先讀 `node_modules/next/dist/docs/` 的相關指南（見 AGENTS.md） |
| 語言 | TypeScript（strict 模式） | path alias `@/*` → `./src/*` |
| 樣式 | Tailwind CSS 4（`@tailwindcss/postcss`） | `globals.css` 只有 `@import "tailwindcss"` 與字型設定；統一淺色主題 |
| 圖片處理 | sharp | 轉正、壓縮、SVG 點陣化、mock 合成 |
| 資料庫 / 儲存 | Supabase（`@supabase/supabase-js`） | Postgres + 私有 Storage bucket；只用 service role key，於後端使用 |
| AI 生成 | 可替換的 VTO provider | `mock`（預設，免 key）／`fashn`（[FASHN API](https://docs.fashn.ai)，`tryon-v1.6`，約 USD 0.075/張）／`fashn-max`（`tryon-max`，約 USD 0.15/張，與 `fashn` 共用 `FASHN_API_KEY`；使用者可在前端於 v1.6 / Max 之間切換） |
| 測試 | Vitest 4 | `npm run test`；測試檔為 `src/**/*.test.ts`，node 環境，完全離線（mock Supabase 與 fetch，不花 API 錢） |
| Lint | ESLint 9（flat config） | `npm run lint`；`eslint-config-next` 的 core-web-vitals + typescript 設定。**Next.js 16 已移除 `next lint`**，一律走 ESLint CLI |

### 4.1 環境變數（`.env.local`，範本見 `.env.local.example`）

| 變數 | 說明 |
|---|---|
| `SUPABASE_URL` | Supabase 專案 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key，**只能在後端使用** |
| `VTO_PROVIDER` | `mock`（預設）或 `fashn` |
| `FASHN_API_KEY` | 僅 `VTO_PROVIDER=fashn` 時需要 |

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
- **Server / Client 劃分**：頁面預設 Server Component 直接查 DB；需要互動的元件才加 `"use client"` 放進 `src/components/`；`src/lib/supabase.ts`、`quota.ts`、`user.ts`、`validation.ts`、`images.ts`、`vto/` **只能在伺服器端 import**。
- **圖片**：目前使用原生 `<img>` 搭配 `eslint-disable` 註解（未使用 `next/image`），新增圖片時沿用此慣例即可。
- **Commit 風格**：Conventional Commits 前綴 + 繁體中文描述，例：`feat: AI 虛擬試衣 MVP（上衣受控替換）`。
- **常數位置**：額度規則在 `src/lib/quota.ts`（`DAILY_GENERATION_LIMIT`、`PER_PRODUCT_RETRY_LIMIT`）；照片限制在 `src/lib/validation.ts`；輪詢間隔在 `TryOnLauncher.tsx`。調整規則直接改常數，不要散落新數字。
- **測試**：Vitest（`npm run test` 一次執行、`npm run test:watch` 監看模式），設定在 `vitest.config.ts`。已涵蓋 `quota.ts`（額度邊界、台北時區）、`validation.ts`（格式/大小/解析度邊界）、`vto/fashn.ts`（錯誤轉譯與輪詢分支）。測試完全離線：Supabase 用 `vi.mock`、FASHN 用 mock fetch，不碰真實服務也不花錢；測試註解說明「為什麼測這個邊界」。
- **Lint**：ESLint（`npm run lint`），flat config 在 `eslint.config.mjs`。底線開頭的參數視為刻意未使用；規則誤判或介面保留參數時，沿用「附繁中理由的 `eslint-disable` 註解」慣例（見 `TryOnLauncher.tsx`、`AddToCartButton.tsx`），不要整條規則關掉。
- **CI/CD**：目前專案中未明確定義。測試與 lint 需本機手動執行；端到端行為驗證仍以 `npm run dev` 手動走流程為輔（README「測試方式」一節有完整清單）。
- **部署方式**：目前專案中未明確定義（無 Vercel/Docker 等部署設定檔）。

## 6. AI 協作注意事項

**修改程式前必讀的規則：**

1. **先理解現有架構再動手**：讀完本文件與相關原始碼，確認要改的位置與既有分層（前端 → API route → lib → Supabase/provider）一致，再開始修改。
2. **不要任意重構整個專案**：不做大範圍搬移、改名、換資料夾結構；重構僅限於任務明確要求的範圍。
3. **不要刪除既有功能**：包括額度控管、失敗計入額度、刪除時保留 job 列、私有 bucket + signed URL 等刻意的設計取捨（原因都寫在對應檔案的註解裡）。
4. **不要自行更換技術棧**：不換框架、不換資料庫、不引入新的狀態管理或 UI 套件，除非使用者明確要求。
5. **不要硬編碼 API Key**：所有金鑰只能來自環境變數（`.env.local`），並更新 `.env.local.example` 的說明。
6. **不要把敏感資訊寫進前端**：`SUPABASE_SERVICE_ROLE_KEY`、`FASHN_API_KEY`、`src/lib/supabase.ts` 等後端模組絕對不可出現在任何 `"use client"` 元件的 import 鏈中；前端只能呼叫自家 `/api/*`。
7. **不確定需求時，做最小幅度、可回滾的修改**：小步修改、保留原行為、不要順手「順便改善」無關的程式。

**本專案特有的注意事項：**

- **Next.js 16 與你的訓練資料不同**（見根目錄 AGENTS.md）：寫任何 Next.js 相關程式前，先讀 `node_modules/next/dist/docs/` 的對應章節，並留意棄用警告。
- **額度機制不要改成計數器欄位**：額度 = 統計 `try_on_jobs` 當日筆數（台北時區 UTC+8），「建立 job」即「額度 +1」，沒有同步問題；改成計數器會重新引入不同步風險。
- **新增 VTO provider 的正確方式**：實作 `src/lib/vto/provider.ts` 的 `VTOProvider` 介面 → 在 `src/lib/vto/index.ts` factory 註冊名稱；API route 與前端不需要改。
- **改資料庫結構**：在 `supabase/migrations/` 新增 SQL 檔（目前只有 `001_init.sql`，需在 Supabase SQL Editor 手動執行），同時更新 `src/lib/types.ts` 的對應型別。
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
- **匿名 cookie 可被繞過**：清除 cookie 即可重置每日額度；MVP 接受此風險，未來加登入後可併入正式帳號（`users.email` 已預留）。
- **照片驗證只有基礎檢查**：格式/大小/解析度而已，不做電腦視覺判斷（多人、遮擋、背面照等交給 VTO API 端失敗後的錯誤轉譯）。
- **輪詢由前端驅動、無 webhook/queue**：使用者在生成期間關閉視窗，job 可能永遠停在 `processing`（provider 端已完成也不會回寫）。
- **無自動清理**：逾期人物照/結果圖不會定期刪除（README 列為 TODO），也沒有臉部模糊、GDPR 式資料匯出。
- **時區寫死台北（UTC+8）**：`quota.ts` 的「每日」邊界。
- **mock provider 只是視覺合成**：人物照 + 上衣縮圖 + 「MOCK 預覽」浮水印，非真實 AI 效果。
- **無 CI/CD**：單元測試與 ESLint 已就位（見第 5 節），但沒有自動化管線在 push/PR 時強制執行，仍靠開發者本機手動跑；API route 層也還沒有整合測試。
- **購物車是假的**：`AddToCartButton` 僅示範 UI。

## 8. 後續開發建議

依優先順序：

1. **把測試與 lint 接上 CI**：`quota.ts`／`validation.ts`／`vto/fashn.ts` 的單元測試與 ESLint 已就位，下一步是加 CI（如 GitHub Actions）在 PR 時自動執行 `npm run test` 與 `npm run lint`，並逐步把測試擴大到 API route 層（upload／try-on 的整合測試）。
2. **處理「輪詢中斷」的殘留 job**：加一個逾時回收機制（例如查詢時發現 `processing` 超過 N 分鐘就向 provider 查一次最終狀態或標記 failed），避免額度被永遠卡住的任務占用且狀態不準。
3. **照片生命週期管理**：定期清除逾期的 `person-uploads` / `try-on-results` 檔案（Supabase scheduled function 或外部 cron），兌現 README 的隱私承諾。
4. **擴充品類**：新增 `bottoms`/`dresses` 時，沿 `category` 欄位 + `garmentType` 參數 + provider factory 的既有預留擴充，不需要動架構。
5. **正式帳號系統**：導入 Supabase Auth，將匿名 `vto_uid` 併入正式帳號，解決額度繞過問題。
