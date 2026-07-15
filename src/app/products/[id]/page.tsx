// ProductPage（規格書第十節）：商品資訊 + AI 試穿按鈕 + 加入購物車
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabaseAdmin, isSupabaseConfigured } from "@/lib/supabase";
import type { Product, ProductVariant } from "@/lib/types";
import TryOnLauncher from "@/components/TryOnLauncher";
import AddToCartButton from "@/components/AddToCartButton";
import { getCurrentUser } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) notFound();

  const supabase = getSupabaseAdmin();
  const { data: product } = await supabase
    .from("products")
    .select("*")
    .eq("id", id)
    .eq("is_active", true)
    .single<Product>();
  if (!product) notFound();
  const { data: variants } = await supabase
    .from("product_variants")
    .select("*")
    .eq("product_id", id)
    .order("created_at")
    .returns<ProductVariant[]>();
  const user = await getCurrentUser();

  return (
    <div>
      <Link href="/" className="text-sm text-stone-500 hover:underline">
        ← 回商品列表
      </Link>
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={product.image_url}
          alt={product.name}
          className="w-full rounded-xl border border-stone-200 bg-stone-100 object-cover aspect-square"
        />
        <div>
          <h1 className="text-2xl font-semibold">{product.name}</h1>
          <p className="mt-2 text-xl font-semibold">NT$ {Math.round(product.price)}</p>

          <dl className="mt-6 space-y-2 text-sm">
            <Row label="顏色" value={product.color} />
            <Row label="版型" value={product.fit} />
            <Row label="材質" value={product.material} />
          </dl>

          {product.size_chart && (
            <div className="mt-6">
              <h2 className="text-sm font-medium mb-2">尺寸表</h2>
              <table className="w-full text-sm border border-stone-200 rounded-lg overflow-hidden">
                <tbody>
                  {sortSizes(Object.entries(product.size_chart)).map(([size, spec]) => (
                    <tr key={size} className="border-b border-stone-100 last:border-0">
                      <td className="px-3 py-1.5 font-medium bg-stone-50 w-16">{size}</td>
                      <td className="px-3 py-1.5 text-stone-600">{spec}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-stone-400">
                根據你平常穿的尺寸與此商品版型，建議先參考原本常穿尺寸。實際尺寸仍請以商品尺寸表為準。
              </p>
            </div>
          )}

          <div className="mt-8 flex flex-col sm:flex-row gap-3">
            <TryOnLauncher product={product} variants={variants ?? []} isAuthenticated={Boolean(user)} />
            <AddToCartButton productName={product.name} variants={variants ?? []} />
          </div>
        </div>
      </div>
    </div>
  );
}

// jsonb 的 key 沒有固定順序，依常見尺寸序排列；未知尺寸排最後
const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL"];
function sizeRank(size: string): number {
  const idx = SIZE_ORDER.indexOf(size);
  return idx === -1 ? SIZE_ORDER.length : idx;
}
function sortSizes(entries: [string, string][]): [string, string][] {
  return entries.sort(([a], [b]) => sizeRank(a) - sizeRank(b));
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-3">
      <dt className="w-14 text-stone-400">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
