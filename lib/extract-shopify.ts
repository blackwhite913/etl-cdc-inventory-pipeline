import { fetchShopifyProductsPage, fetchShopifyVariantsPage } from "@/lib/shopify";

export type ShopifyVariantRaw = {
  id: string;
  sku: string | null;
  title: string | null;
  price: string | null;
  inventoryQuantity: number | null;
};

export type ShopifyProductRaw = {
  id: string;
  title: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  status: string | null;
  updatedAt: string | null;
  variants: {
    nodes: ShopifyVariantRaw[];
    pageInfo?: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
};

export type ExtractShopifyMeta = {
  totalProductsFetched: number;
  totalVariantsSeen: number;
  totalVariantsIfActiveOnly: number;
  skippedNullSkus: number;
  totalVariantsAfterFilter: number;
  totalPagesFetched: number;
  totalVariantSubPagesFetched: number;
  productsWithVariantOverflow: number;
  maxVariantsPerProduct: number;
  statusBreakdown: Record<string, number>;
  startedAt: number;
  finishedAt: number;
  totalTimeMs: number;
};

export type ExtractShopifyResult = {
  products: ShopifyProductRaw[];
  meta: ExtractShopifyMeta;
};

export type ExtractShopifyOptions = {
  updatedAtGte?: Date;
  onBatch?: (products: ShopifyProductRaw[]) => Promise<void>;
};

function buildShopifySearchQuery(updatedAtGte?: Date): string {
  if (!updatedAtGte) return "";
  return `updated_at:>=${updatedAtGte.toISOString()}`;
}

function normalizeStatus(status: string | null): string {
  const normalized = status?.trim().toUpperCase();
  return normalized && normalized.length > 0 ? normalized : "UNKNOWN";
}

async function hydrateAllVariants(
  product: ShopifyProductRaw,
): Promise<{
  variants: ShopifyVariantRaw[];
  subPagesFetched: number;
  fetchedOverflowPages: boolean;
}> {
  const variants = Array.isArray(product.variants?.nodes) ? [...product.variants.nodes] : [];
  let cursor = null as string | null;
  let hasNextPage = Boolean(product.variants?.pageInfo?.hasNextPage);
  let subPagesFetched = 0;
  const fetchedOverflowPages = hasNextPage;

  cursor = product.variants?.pageInfo?.endCursor ?? null;

  while (hasNextPage) {
    if (!cursor) {
      throw new Error(`Variant pagination missing endCursor for product ${product.id}`);
    }

    const nextPage = await fetchShopifyVariantsPage({
      productId: product.id,
      cursor,
    });
    subPagesFetched += 1;
    variants.push(...nextPage.variants);
    hasNextPage = nextPage.pageInfo.hasNextPage;
    cursor = nextPage.pageInfo.endCursor;
  }

  return {
    variants,
    subPagesFetched,
    fetchedOverflowPages,
  };
}

export async function extractAllShopify(options: ExtractShopifyOptions = {}): Promise<ExtractShopifyResult> {
  const startedAt = Date.now();
  const searchQuery = buildShopifySearchQuery(options.updatedAtGte);
  const isStreaming = typeof options.onBatch === "function";
  const accumulator: ShopifyProductRaw[] = [];

  let cursor: string | null = null;
  let hasNextPage = true;
  let totalProductsFetched = 0;
  let totalVariantsSeen = 0;
  let totalVariantsIfActiveOnly = 0;
  let skippedNullSkus = 0;
  let totalVariantsAfterFilter = 0;
  let totalPagesFetched = 0;
  let totalVariantSubPagesFetched = 0;
  let productsWithVariantOverflow = 0;
  let maxVariantsPerProduct = 0;
  const statusBreakdown = new Map<string, number>();

  while (hasNextPage) {
    const page = await fetchShopifyProductsPage({
      cursor,
      query: searchQuery,
    });
    totalPagesFetched += 1;
    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
      throw new Error(`[extract-shopify] page ${totalPagesFetched} hasNextPage=true but endCursor is null`);
    }

    const normalizedProducts: ShopifyProductRaw[] = [];

    for (const product of page.products) {
      totalProductsFetched += 1;
      const status = normalizeStatus(product.status);
      statusBreakdown.set(status, (statusBreakdown.get(status) ?? 0) + 1);

      const hydrated = await hydrateAllVariants(product as ShopifyProductRaw);
      if (hydrated.fetchedOverflowPages) {
        productsWithVariantOverflow += 1;
      }
      totalVariantSubPagesFetched += hydrated.subPagesFetched;

      const variants = hydrated.variants;
      maxVariantsPerProduct = Math.max(maxVariantsPerProduct, variants.length);
      if (status === "ACTIVE") {
        totalVariantsIfActiveOnly += variants.length;
      }
      totalVariantsSeen += variants.length;
      for (const variant of variants) {
        if (variant.sku === null || variant.sku.trim().length === 0) {
          skippedNullSkus += 1;
        }
        totalVariantsAfterFilter += 1;
      }

      normalizedProducts.push({
        ...product,
        variants: { nodes: variants },
      });
    }

    if (isStreaming) {
      if (normalizedProducts.length > 0) {
        await options.onBatch!(normalizedProducts);
      }
    } else {
      accumulator.push(...normalizedProducts);
    }

    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  const finishedAt = Date.now();
  return {
    products: accumulator,
    meta: {
      totalProductsFetched,
      totalVariantsSeen,
      totalVariantsIfActiveOnly,
      skippedNullSkus,
      totalVariantsAfterFilter,
      totalPagesFetched,
      totalVariantSubPagesFetched,
      productsWithVariantOverflow,
      maxVariantsPerProduct,
      statusBreakdown: Object.fromEntries(statusBreakdown),
      startedAt,
      finishedAt,
      totalTimeMs: finishedAt - startedAt,
    },
  };
}
