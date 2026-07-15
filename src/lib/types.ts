// 共用型別定義：對應 supabase/migrations/001_init.sql 的資料表

export type JobStatus = "pending" | "processing" | "success" | "failed";
export type FeedbackRating = "satisfied" | "unsatisfied";
export type AccountDeletionRequestStatus =
  | "pending"
  | "processing"
  | "completed"
  | "rejected"
  | "cancelled";

// 使用者可選的生成模型（對外名稱）。刻意不用 provider 內部名稱（fashn / fashn-max），
// 對外與對內的映射由後端白名單控制（見 src/lib/vto/index.ts），前端無法注入任意 provider。
export type TryOnModel = "v1.6" | "max";

export interface Product {
  id: string;
  name: string;
  price: number;
  image_url: string;
  garment_image_url: string;
  category: string;
  color: string | null;
  fit: string | null;
  material: string | null;
  size_chart: Record<string, string> | null;
  is_active: boolean;
  created_at: string;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  size: string;
  stock_quantity: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface LocalCartItem {
  variantId: string;
  quantity: number;
}

export interface StoredGuestCart {
  version: 1;
  guestCartId: string;
  items: LocalCartItem[];
}

export type CartUnavailableReason = "product_inactive" | "variant_inactive" | "out_of_stock";

export interface CartItemView {
  variantId: string;
  productId: string;
  name: string;
  imageUrl: string;
  size: string;
  unitPrice: number;
  quantity: number;
  maxQuantity: number;
  available: boolean;
  unavailableReason: CartUnavailableReason | null;
  lineSubtotal: number;
}

export interface CartView {
  items: CartItemView[];
  itemCount: number;
  subtotal: number;
  notices: string[];
}

export interface TryOnJob {
  id: string;
  user_id: string;
  source_hash: string | null; // 舊匿名測試資料欄位；正式會員流程不再讀寫
  product_id: string;
  person_image_url: string; // Storage 路徑，不是公開 URL
  garment_image_url: string;
  result_image_url: string | null; // Storage 路徑，不是公開 URL
  provider: string;
  provider_job_id: string | null;
  status: JobStatus;
  cost_estimate: number;
  budget_reservation: number;
  retry_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

// API 回傳給前端的 job 狀態（圖片換成私有 Storage 的 1 小時 signed URL，非永久公開 URL）
export interface TryOnJobView {
  jobId: string;
  status: JobStatus;
  personImageUrl: string | null;
  resultImageUrl: string | null;
  costEstimate: number;
  retryCount: number;
  message?: string;
}

// /account Server Component 傳給互動元件的最小資料；不包含 Storage path、user_id、
// provider 成本或其他不需要進入瀏覽器的欄位。
export interface AccountTryOnItem {
  jobId: string;
  productId: string;
  productName: string;
  createdAt: string;
  status: JobStatus;
  resultImageUrl: string | null;
  photosDeleted: boolean;
}

export interface AccountDeletionRequestView {
  id: string;
  requestedAt: string;
  status: AccountDeletionRequestStatus;
  reason: string | null;
}
