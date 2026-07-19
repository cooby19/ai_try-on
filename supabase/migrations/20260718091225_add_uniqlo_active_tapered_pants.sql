-- 使用者提供的商品圖與規格；庫存僅供 Demo 與試穿流程測試。
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
  '00000000-0000-0000-0000-000000000007',
  '男裝 特級彈性 Active 窄管長褲',
  990,
  '/garments/uniqlo-active-tapered-pants-coffee.jpg',
  '/garments/uniqlo-active-tapered-pants-coffee.jpg',
  'bottoms',
  '咖啡色',
  '窄管',
  '大身：67% 聚酯纖維、33% 再生聚酯纖維／口袋布：100% 聚酯纖維',
  null,
  true
)
on conflict (id) do nothing;

-- 未提供實際量測尺寸，故僅建立可選尺寸變體。
insert into public.product_variants (product_id, size, stock_quantity, is_active)
select
  '00000000-0000-0000-0000-000000000007'::uuid,
  size,
  20,
  true
from unnest(array['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL']) as sizes(size)
on conflict (product_id, size) do nothing;
