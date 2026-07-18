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

export type TryOnErrorType =
  | "input_validation"
  | "authorization"
  | "product_lookup"
  | "quota"
  | "person_image_read"
  | "garment_image_read"
  | "provider_submit"
  | "provider_poll"
  | "provider_rejected"
  | "provider_output_download"
  | "enhancement"
  | "result_storage"
  | "database"
  | "timeout"
  | "internal";

export interface TryOnFeatureFlagSnapshotV1 {
  schemaVersion: 1;
  experimentId: string;
  variantId: string;
  variantRole: "control" | "candidate";
  rolloutMode: "off" | "evaluation" | "canary" | "on";
  rolloutPercentage: number;
  assignmentVersion: "deployment-control-v1" | "hmac-sha256-v1" | "forced-test-v1";
  saltVersion: string;
  requestedModel: TryOnModel | null;
  requestedProviderName: "fashn" | "fashn-max" | "mock";
}

export interface TryOnConfigSnapshotV1 {
  schemaVersion: 1;
  // v1 golden 與 migration 前資料沒有此欄位；production 新 job 一律由 server-only
  // Feature Flag resolver 寫入，保留 optional 只為唯讀相容既有凍結證據。
  experiment?: TryOnFeatureFlagSnapshotV1;
  provider: {
    name: "fashn" | "fashn-max" | "mock";
    modelName: "tryon-v1.6" | "tryon-max" | "mock";
    mode: "quality" | "balanced" | null;
    resolution: "1k" | null;
    outputFormat: "jpeg";
    outputCount: 1;
  };
  generation: {
    seed: number;
    garmentType: "tops" | null;
    garmentPhotoType: "flat-lay" | null;
  };
  preprocessing: {
    personImage: {
      version: "person-image-v1";
      maxWidth: 1440;
      outputFormat: "jpeg";
      jpegQuality: 92;
    };
    garmentImage: {
      version: "garment-image-v1";
      maxWidth: 1024;
      outputFormat: "png";
    };
  };
  enhancement: {
    provider: "none" | "realesrgan";
    modelVersion: string | null;
    scale: 2 | null;
  };
  prompt: {
    version: "none";
    hash: null;
    value: "" | null;
  };
}

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

export interface AddressBookEntry {
  id: string;
  label: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  updatedAt: string;
}

export interface ShippingMethod {
  code: string;
  name: string;
  fee: number;
}

export type OrderStatus =
  | "pending_payment"
  | "processing"
  | "payment_failed"
  | "cancellation_requested"
  | "cancelled"
  | "shipped"
  | "completed"
  | "refund_pending"
  | "partially_refunded"
  | "refunded"
  | "expired";

export type PaymentStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "refund_pending"
  | "partially_refunded"
  | "refunded";
export type MockPaymentOutcome = "success" | "failure" | "cancelled" | "expired";
export type InventoryReservationStatus = "active" | "completed" | "released";

export interface OrderItemView {
  id: string;
  productId: string;
  variantId: string;
  productName: string;
  variantSize: string;
  imageUrl: string;
  unitPrice: number;
  quantity: number;
  lineSubtotal: number;
}

export interface OrderView {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  shippingMethodCode: string;
  shippingMethodName: string;
  shippingFee: number;
  subtotal: number;
  total: number;
  createdAt: string;
  items: OrderItemView[];
  payment: PaymentView | null;
  reservation: InventoryReservationView | null;
}

export interface InventoryReservationView {
  status: InventoryReservationStatus;
  expiresAt: string;
}

export interface PaymentEventView {
  id: string;
  eventId: string;
  result: Extract<PaymentStatus, "succeeded" | "failed" | "cancelled" | "expired">;
  ignored: boolean;
  processedAt: string;
}

export interface PaymentView {
  id: string;
  transactionId: string;
  status: PaymentStatus;
  failureReason: string | null;
  paidAt: string | null;
  refundedAmount: number;
  updatedAt: string;
  events: PaymentEventView[];
}

export type RefundRequestStatus =
  | "requested"
  | "reviewing"
  | "approved"
  | "processing"
  | "succeeded"
  | "rejected"
  | "failed"
  | "cancelled";

export interface RefundRequestView {
  id: string;
  orderId: string;
  requestType: "cancellation" | "refund";
  status: RefundRequestStatus;
  reason: string;
  requestedAmount: number;
  approvedAmount: number | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SupportTicketStatus = "open" | "waiting_customer" | "in_progress" | "resolved" | "closed";
export type SupportCategory = "order" | "payment" | "refund" | "try_on" | "privacy" | "account" | "other";

export interface SupportMessageView {
  id: string;
  senderRole: "customer" | "staff" | "system";
  body: string;
  createdAt: string;
}

export interface SupportTicketView {
  id: string;
  ticketNumber: string;
  orderId: string | null;
  category: SupportCategory;
  subject: string;
  status: SupportTicketStatus;
  priority: "low" | "normal" | "high" | "urgent";
  lastActivityAt: string;
  createdAt: string;
  messages: SupportMessageView[];
}

export interface OrderListItem {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  total: number;
  createdAt: string;
}

export interface TryOnJob {
  id: string;
  user_id: string;
  source_hash: string | null; // 舊匿名測試資料欄位；正式會員流程不再讀寫
  product_id: string;
  person_image_url: string | null; // Storage 路徑，不是公開 URL；保留政策清除後為 null
  garment_image_url: string;
  result_image_url: string | null; // Storage 路徑，不是公開 URL
  provider: string;
  provider_job_id: string | null;
  status: JobStatus;
  cost_estimate: number;
  budget_reservation: number;
  retry_count: number;
  error_message: string | null;
  config_snapshot: TryOnConfigSnapshotV1 | Record<string, never>;
  seed: number | null;
  started_at: string | null;
  provider_submitted_at: string | null;
  completed_at: string | null;
  last_polled_at: string | null;
  error_type: TryOnErrorType | null;
  error_code: string | null;
  provider_http_status: number | null;
  idempotency_key: string | null;
  request_fingerprint: string | null;
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
