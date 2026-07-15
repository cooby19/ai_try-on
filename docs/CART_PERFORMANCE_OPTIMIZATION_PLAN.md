# 購物車效能優化規劃

## 目的

將登入使用者的購物車操作從目前約 2～3 秒的後端確認時間，逐步降低為少量遠端往返；同時保留帳號隔離、伺服器端價格／庫存驗證、跨裝置同步與同帳號併發安全。

這份文件可直接貼給 AI 作為後續優化需求。執行前先讀現有購物車實作、migration 與測試；不要以刪除驗證或降低資料正確性來換取速度。

## 已完成

- [x] 前端樂觀更新：使用者點擊加減／刪除後，UI 應立即反映預期結果；背景 API 完成後以伺服器資料校正，失敗才回滾並提示。

本規劃不重做樂觀更新，除非後續 API 回傳格式變更而必須調整其校正／回滾邏輯。

## 現況與瓶頸

目前登入購物車的每次操作會經過多個**串行**遠端請求：

| 操作 | 目前流程 | 主要問題 |
|---|---|---|
| 加入／更新數量 | Auth `getUser` → 寫入 RPC → `reconcile_cart_stock` → 查 cart ID → 查完整品項 | 寫入後重新讀取購物車需額外 3 次 Supabase 請求 |
| 刪除 | Auth `getUser` → 查 cart ID → delete → 更新 cart 時間 → reconciliation → 再查 cart ID → 查完整品項 | 重複查 cart ID，且 `updated_at` 是獨立請求 |

注意：資料庫使用同帳號 advisory lock 來避免跨裝置競態。它應保留；連續操作的前端應合併／排隊請求，而不是移除 lock。

## 不可破壞的約束

- 所有登入 API 必須以 Supabase Auth session 取得可信 `user.id`，不可接受前端傳入的 `user_id`。
- 商品價格、庫存、可售狀態、小計與總額都必須以伺服器／資料庫資料為準。
- 同商品同尺寸只能有一筆 cart item；數量上限為 `min(99, stock_quantity)`。
- 訪客購物車登入合併必須保留 `guestCartId` 的冪等語意，避免斷線重送重複累加。
- 下架、停用與缺貨品項仍應能在購物車顯示並移除，但不計入總額。
- 不可將登入使用者購物車做成共享 CDN／靜態快取。

## 優化階段

### P2：將單次異動收斂為一個購物車交易

目標：新增、改數量、刪除都由單一資料庫 RPC／交易完成「驗證 → 寫入 → 更新 cart 時間 → 讀取權威購物車 DTO」，API 只回傳一次 `CartView`。

實作要求：

- 新增或擴充資料庫函式，使其回傳與現有 `CartView` 相容的 JSON：`items`、`itemCount`、`subtotal`、`notices`。
- 在同一個資料庫交易內完成商品／規格可售檢查、庫存上限、cart item 寫入與 cart `updated_at` 更新。
- 回傳 DTO 時以目前 `products.price`、`products.is_active`、`product_variants.stock_quantity`、`product_variants.is_active` 計算，不採用前端資料。
- `add` 達庫存上限時回傳調整後數量與 notice；`set quantity` 超過庫存回傳 422 與 `maxQuantity`；刪除不存在或不屬於目前帳號的品項回傳 404。
- API route 不得在 RPC 成功後再次呼叫目前的完整 `getCartView()`，以避免額外網路往返。
- 保持現有 HTTP API 路徑與 `CartView` 前端契約；若必須變更，需同步更新 `CartProvider`、測試與文件。

預期效果：登入後的加入／調整／刪除由多次 Supabase 往返降低為「Auth 驗證 + 一次購物車 RPC」。

### P3：將庫存 reconciliation 改為有條件執行

目標：不要在每次正常異動後都執行全面 `reconcile_cart_stock`。

實作要求：

- 新增與直接改數量的寫入 RPC 已在交易內檢查目前庫存，因此成功寫入後不需再立即全車 reconciliation。
- 將 `reconcile_cart_stock` 保留在下列時機：
  - `GET /api/cart` 或購物車頁初始載入；
  - 使用者重新聚焦頁面、需要取得其他裝置變更時；
  - 未來結帳前；
  - 後台庫存異動後的明確同步機制（若實作）。
- reconciliation 只下修「仍可售且庫存大於 0」但超出新庫存的數量；缺貨／下架品項保留於購物車並標示不可購買。
- 若 API 回傳因 reconciliation 產生的調整，需保留友善 notice。

預期效果：一般按鈕操作少一次 RPC，並降低同帳號 lock 的等待機會。

### P4：消除獨立查詢與寫入

目標：移除不必要的 `findCartId` 與單獨更新時間請求。

實作要求：

- 刪除操作不得先查 cart ID、刪除後再查一次 cart ID。
- 優先讓刪除 RPC 以 `p_user_id + p_variant_id` 完成所有權過濾、刪除、更新時間與 DTO 回傳。
- 若仍保留 REST 查詢，改為透過 `carts.user_id` 關聯一次完成篩選，避免先取 `cart_id` 再查 item。
- cart 的 `updated_at` 應由同一交易更新；可評估 DB trigger，但不得造成不必要的額外 API 請求。

預期效果：刪除操作不再有額外 cart lookup 與獨立 update 往返。

### P5：安全地降低 Auth 驗證成本

目標：確認每個 API 的 Auth 驗證是否為主要延遲之一，僅在不降低安全性的前提下優化。

實作要求：

- 先以 Server-Timing 或 log 量測 `requireUser()` 所花時間。
- 若 Auth 呼叫佔比高，評估使用 Supabase 的**已驗證** JWT claims／受信任 server-side 驗證機制，並確認 token 過期、撤銷與 refresh 行為正確。
- 不可單純相信 browser local session，也不可把未驗證的 `getSession()` 當成授權依據。
- 每次購物車 DB 存取仍須以伺服器取得的可信 user ID 過濾。

### P6：部署與資料庫延遲

目標：避免 Next.js server 與 Supabase 之間的跨區延遲放大多次往返成本。

實作要求：

- 在 Vercel 將 function region 設為 Supabase 專案所在區域或最近區域。
- 分別量測本機 `npm run dev`、production build（`npm run build && npm start`）與正式部署。開發模式首次請求可能受到 Turbopack 編譯影響，不可只用首次結果判斷。
- 檢查冷啟動、Auth、RPC、資料讀取各自的 P50/P95；不要只看總時間。

## 量測與驗收

優化前先加入可移除或可控制的量測，至少記錄：

- API 總耗時。
- Auth 驗證耗時。
- 寫入 RPC 耗時。
- reconciliation 耗時。
- cart 查詢／DTO 組裝耗時。
- HTTP status、操作類型、是否庫存截斷；不得記錄 email、token 或其他敏感資料。

可使用 `Server-Timing` response header，並用瀏覽器 Network 面板與 Supabase Dashboard 驗證。驗收目標：

| 指標 | 目標 |
|---|---|
| 樂觀 UI 可見更新 | 小於 100ms |
| 已登入加入／改數量 API P50 | 小於 500ms |
| 已登入刪除 API P50 | 小於 500ms |
| 已登入購物車操作 API P95 | 小於 1 秒 |
| 同帳號快速連續操作 | 不遺失、不重複，最終數量與伺服器一致 |

若網路、區域或免費方案限制使絕對數字無法達標，仍必須證明遠端往返數已顯著減少，且 UI 維持立即回應。

## 必要測試

- 未登入無法讀寫帳號購物車；不可用 body 偽造其他 `user_id`。
- 加入、更新、刪除的成功回應都包含權威 `CartView`，不需要後續 GET 才能渲染。
- 重複加入、庫存上限、數量小於 1、直接輸入超量、缺貨、下架、停用與不存在規格。
- 刪除不屬於目前帳號的 item 一律 404，且不得影響其他帳號。
- 價格變動後回傳資料使用最新資料庫價格；不可採用前端價格。
- 訪客登入合併可重送但不重複累加。
- 同帳號在兩個瀏覽器同時加減／刪除，最終購物車一致且不超庫存。
- 樂觀更新失敗時正確回滾與顯示錯誤；成功後使用伺服器回傳資料校正。
- 執行 `npm test`、`npm run lint`、`npm run build`。

## 給 AI 的執行提示

請先閱讀 `src/lib/cart.ts`、`src/components/CartProvider.tsx`、`supabase/migrations/007_persistent_cart.sql` 與購物車測試。實作 P2～P4 時，優先以「單一資料庫交易回傳權威購物車」取代「寫入後重新呼叫多次 Supabase API」。保留現有安全檢查、資料庫 lock、冪等合併與 API 行為；完成後提供實際往返數比較、測試結果與 migration 說明。
