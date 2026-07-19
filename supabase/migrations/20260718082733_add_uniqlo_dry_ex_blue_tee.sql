-- 使用者提供的藍色商品圖與商品資訊；庫存僅供 Demo 流程測試。
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
  '00000000-0000-0000-0000-000000000006',
  '男裝 DRY-EX T恤（短袖）（拼色）',
  590,
  '/garments/uniqlo-dry-ex-color-block-tee-blue.jpg',
  '/garments/uniqlo-dry-ex-color-block-tee-blue.jpg',
  'tops',
  '藍色',
  null,
  '40% 聚醯胺纖維、30% 聚酯纖維、30% 再生聚酯纖維',
  null,
  true
)
on conflict (id) do nothing;

-- 未提供實際量測尺寸，故僅建立可選尺寸變體。
insert into public.product_variants (product_id, size, stock_quantity, is_active)
select
  '00000000-0000-0000-0000-000000000006'::uuid,
  size,
  20,
  true
from unnest(array['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL']) as sizes(size)
on conflict (product_id, size) do nothing;
