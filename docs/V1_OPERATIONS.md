# V1.0 營運、安全與資料保留手冊

## 上線結論

本版已具備訂單／退款狀態機、Email outbox、客服、風險事件、員工 RBAC、管理操作稽核、私有圖片與資料保留工作。不過目前專案只有 Mock Payment；正式環境會預設拒絕 Mock。要讓真實使用者完成付款，仍必須選定真實金流供應商並完成付款、退款與 Webhook 驗證，這是不可跳過的上線阻擋項。

## 保守預設規則（上線前需營運／法務確認）

- 未付款或付款失敗：使用者可立即取消，庫存保留會釋放，不產生退款。
- 付款成功後 30 分鐘內：可提出取消，進入人工審核；核准後才呼叫金流退款。
- 訂單完成後 7 天內：可提出退款，進入人工審核；預設申請剩餘可退款全額，管理員可核准較低金額。
- 已出貨、超過取消窗或不符合退款狀態：不自動改訂單，改由客服處理。
- 退款必須依序 `requested → approved → processing → succeeded/failed`；不得由瀏覽器直接更改付款資料。
- 取消退款成功後只在「出貨前取消且全額退款」自動回補庫存；退貨退款不自動回補，避免未驗收商品就增加可售庫存。

## Email

- 註冊與 Email OTP 驗證信由 Supabase Auth 發送。正式環境必須設定自有 SMTP 或 Supabase Send Email Hook，驗證網域並完成 SPF、DKIM、DMARC。
- 訂單、付款狀態、取消、退款與客服通知寫入 `notification_outbox`。
- Vercel Cron 每 5 分鐘呼叫 `/api/internal/notifications/dispatch`，每批鎖定 20 封，失敗指數退避；5 次後進入 `dead`，由營運查核。
- `RESEND_API_KEY`、`EMAIL_FROM`、`CRON_SECRET` 只可存在後端環境變數。
- 若未同時設定 `RESEND_API_KEY` 與 `EMAIL_FROM`，系統進入測試用「只記錄通知」模式：outbox 會標記為 `skipped`，保留收件者、模板與內容稽核紀錄，但不對外寄送、不重試；日後設定完整 Resend 憑證後，才會寄送新通知。

## 員工權限

角色保存在 `public.user_roles`，不可使用可由使用者修改的 `user_metadata`：

- `admin`：全部營運功能。
- `operations`：退款、客服、風險處理。
- `support`：客服案件與回覆。
- `risk_analyst`：風險事件調查。

首次管理員需由受控 SQL Editor 建立，例如：

```sql
insert into public.user_roles (user_id, role)
values ('管理員的-auth-user-uuid', 'admin');
```

所有後台敏感操作都必須再次驗證 Supabase Auth 使用者，再查 `user_roles`；操作結果寫入 `admin_audit_logs`。

## RLS 與資料暴露

- 所有 public 營運表都啟用 RLS。
- 敏感表明確撤銷 `anon` 與 `authenticated` table grants，只允許後端 `service_role`；own-row policies 是未來誤加 grant 時的第二道防線。
- 應用後端每次查詢仍必須限制可信 Auth `user.id`，不能接受前端傳入的 `user_id`。
- Storage bucket 永遠保持 private。路徑第一段必須等於 Auth user ID；頁面只取得短效 signed URL。
- `SUPABASE_SERVICE_ROLE_KEY` 不得使用 `NEXT_PUBLIC_` 前綴，也不得出現在 Client Component。

## 風險監控

資料庫會建立下列事件：

- Email OTP 請求／驗證與 Google callback 只保存 HMAC 指紋，不保存原始 Email、IP 或 User-Agent；15 分鐘內失敗至少 5 次會建立高風險事件，並在更高門檻阻擋請求。
- 同一帳戶 10 分鐘內建立至少 5 筆訂單。
- 被忽略或晚到的付款 Webhook。
- 同一訂單 10 分鐘內至少 4 個付款事件。
- 同一帳戶 30 天內至少 3 次取消／退款申請。

營運後台 `/admin` 可標記調查中、已處理或誤報。正式營運另應在 Supabase 設定 Log Drain 到 Sentry／Datadog 等告警平台，針對 `high`、`critical` 事件建立即時通知。

## 資料保留

| 資料 | 預設期限 | 到期處理 |
|---|---:|---|
| 原始人物照 | 30 天 | 刪除 Storage 檔案，job path 設為 NULL |
| 試穿結果圖 | 90 天 | 刪除 Storage 檔案，job path 設為 NULL |
| Email／測試通知紀錄 | 180 天 | 每日工作刪除已成功寄送或已略過的紀錄 |
| 登入嘗試雜湊指紋 | 90 天 | 每日工作刪除，不保存原始 Email／IP／User-Agent |
| 客服紀錄 | 3 年 | 去識別化；期限需法務確認 |
| 訂單／付款 | 7 年 | 去識別化後保留必要會計與爭議資料；期限需法務確認 |
| 風險／稽核 | 7 年 | 去識別化保留；期限需法務確認 |

每日 Cron 呼叫 `/api/internal/retention/run`。帳戶刪除有 7 天緩衝，且存在未完成訂單或退款時不執行。staging 完整演練通過前，`ACCOUNT_DELETION_EXECUTION_ENABLED` 必須保持 `false`。

帳戶刪除工作會逐一移除明確的 Storage path、刪除地址與購物車、移除試穿照片、去識別化客服內容與 public profile，最後呼叫 Supabase Admin API 刪除 Auth 帳戶。訂單與付款只保留 pseudonymous subject ID 及法定營運必要欄位。

## 部署與驗證清單

1. 在 staging 依序套用 migration 001–012；不可直接先套 production。
2. 執行 Supabase Security Advisor 與 Performance Advisor，修完所有 ERROR／WARN。
   接著執行 `supabase/tests/011_v1_security_checks.sql`，確認 RLS、table grants、Storage 與 RPC 權限斷言全部通過。
3. 以兩個一般帳戶驗證無法跨帳戶讀取照片、訂單、付款、客服與退款。
4. 以無角色、support、operations、risk_analyst、admin 帳戶逐一驗證 `/admin` 權限矩陣。
5. 驗證 Email 成功、暫時失敗重試、5 次死信與重複事件去重。
6. 演練付款 Webhook 重送、晚到、衝突、取消窗邊界、部分退款、退款失敗與庫存回補。
7. 在 staging 複製測試帳戶後啟用帳戶刪除，確認 Auth、Storage、個資與保留資料結果。
8. 將 Supabase JWT expiry 維持 5–60 分鐘；敏感操作須由 `getUser()` 重新驗證，不信任 cookie 內未驗證資料。
9. 完成真實金流供應商與法務條款後，才可宣告 V1.0 對外正式營運。
