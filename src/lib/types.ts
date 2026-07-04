// 共用型別定義：對應 supabase/migrations/001_init.sql 的資料表

export type JobStatus = "pending" | "processing" | "success" | "failed";
export type FeedbackRating = "satisfied" | "unsatisfied";

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
  created_at: string;
}

export interface TryOnJob {
  id: string;
  user_id: string;
  product_id: string;
  person_image_url: string; // Storage 路徑，不是公開 URL
  garment_image_url: string;
  result_image_url: string | null; // Storage 路徑，不是公開 URL
  provider: string;
  provider_job_id: string | null;
  status: JobStatus;
  cost_estimate: number;
  retry_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

// API 回傳給前端的 job 狀態（圖片一律換成短期 signed URL）
export interface TryOnJobView {
  jobId: string;
  status: JobStatus;
  personImageUrl: string | null;
  resultImageUrl: string | null;
  costEstimate: number;
  retryCount: number;
  message?: string;
}
