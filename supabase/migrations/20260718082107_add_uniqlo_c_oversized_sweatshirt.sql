-- 將使用者提供的商品圖加入示範型商品目錄。
-- 價格採此款在台灣的歷史原價 NT$990；庫存為 demo 用數量，並非即時庫存。
insert into public.products (
  id,
  name,
  price,
  image_url,
  garment_image_url,
  category,
  color,
  fit,
  material,
  size_chart,
  is_active
)
values (
  '00000000-0000-0000-0000-000000000005',
  'UNIQLO : C 男裝／男女適穿 寬版休閒上衣（長袖）',
  990,
  '/garments/uniqlo-c-oversized-sweatshirt-oatmeal.jpg',
  '/garments/uniqlo-c-oversized-sweatshirt-oatmeal.jpg',
  'tops',
  '燕麥色',
  '寬鬆 Oversize',
  '67% 聚酯纖維、33% 棉／羅紋部分：82% 棉、18% 聚酯纖維',
  null,
  true
)
on conflict (id) do nothing;

-- 尺寸資料僅提供可選範圍，未提供實際量測表，因此不寫入 size_chart。
-- 庫存 20 為目前 Demo 的預設可購買數量，並不代表品牌即時庫存。
insert into public.product_variants (product_id, size, stock_quantity, is_active)
select
  '00000000-0000-0000-0000-000000000005'::uuid,
  size,
  20,
  true
from unnest(array['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL']) as sizes(size)
on conflict (product_id, size) do nothing;
