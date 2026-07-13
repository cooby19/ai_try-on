-- 003：前端直傳人物照的 bucket 防線。
-- 舊專案已由 001 建立 bucket，必須另跑本 migration 才會補上限制。
-- signed upload URL 不需要開放 anon RLS policy；它本身就是只允許指定 path 的能力憑證。
update storage.buckets
set
  public = false,
  file_size_limit = 8388608, -- 8 MiB
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']::text[]
where id = 'person-uploads';
