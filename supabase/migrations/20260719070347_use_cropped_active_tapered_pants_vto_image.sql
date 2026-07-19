-- 保留商品頁展示圖，僅改用緊裁切版作為 FASHN 褲裝試穿輸入。
update public.products
set garment_image_url = '/garments/uniqlo-active-tapered-pants-coffee-vto.png'
where id = '00000000-0000-0000-0000-000000000007'::uuid;
