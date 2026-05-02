import { prisma } from "@/lib/prisma";

import type { ShopifyProductRaw, ShopifyVariantRaw } from "@/lib/extract-shopify";

const SHOPIFY_TRANSACTION_BATCH = 50;

type ShopifyVariantInput = {
  id: string;
  productId: string;
  sku: string;
  variantTitle: string | null;
  productTitle: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  price: string | null;
  inventoryQuantity: number | null;
  status: string | null;
  updatedAt: Date | null;
};

export type ShopifyLoadResult = {
  productsProcessed: number;
  variantsSeen: number;
  processed: number;
  inserted: number;
  updated: number;
  fallbackSkusApplied: number;
  skippedNullSkus: number;
  durationMs: number;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function normalizeVariant(
  product: ShopifyProductRaw,
  variant: ShopifyVariantRaw,
): { row: ShopifyVariantInput; usedFallbackSku: boolean } {
  const normalizedSku = variant.sku?.trim();
  const usedFallbackSku = !normalizedSku;
  const sku = normalizedSku || `NO-SKU-${variant.id}`;

  const updatedAt = product.updatedAt ? new Date(product.updatedAt) : null;
  const safeUpdatedAt = updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null;

  return {
    row: {
      id: variant.id,
      productId: product.id,
      sku,
      variantTitle: variant.title?.trim() || null,
      productTitle: product.title?.trim() || null,
      vendor: product.vendor?.trim() || null,
      productType: product.productType?.trim() || null,
      tags: product.tags ?? [],
      price: variant.price?.trim() || null,
      inventoryQuantity:
        typeof variant.inventoryQuantity === "number" && Number.isFinite(variant.inventoryQuantity)
          ? variant.inventoryQuantity
          : null,
      status: product.status?.trim() || null,
      updatedAt: safeUpdatedAt,
    },
    usedFallbackSku,
  };
}

export async function loadShopifyBatch(products: ShopifyProductRaw[]): Promise<ShopifyLoadResult> {
  const t0 = Date.now();

  const normalized: ShopifyVariantInput[] = [];
  let variantsSeen = 0;
  let fallbackSkusApplied = 0;

  for (const product of products) {
    const variants = Array.isArray(product.variants?.nodes) ? product.variants.nodes : [];
    for (const variant of variants) {
      variantsSeen += 1;
      const normalizedVariant = normalizeVariant(product, variant);
      if (normalizedVariant.usedFallbackSku) {
        fallbackSkusApplied += 1;
      }
      normalized.push(normalizedVariant.row);
    }
  }

  if (normalized.length === 0) {
    return {
      productsProcessed: products.length,
      variantsSeen,
      processed: 0,
      inserted: 0,
      updated: 0,
      fallbackSkusApplied,
      skippedNullSkus: 0,
      durationMs: Date.now() - t0,
    };
  }

  const ids = normalized.map((variant) => variant.id);
  const existing = await prisma.shopifyVariant.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });

  const existingSet = new Set(existing.map((row) => row.id));

  let processed = 0;

  // ✅ FIX: NO TRANSACTION — simple, stable upserts
  for (const row of normalized) {
    await prisma.shopifyVariant.upsert({
      where: { id: row.id },
      create: row,
      update: row,
    });
    processed += 1;
  }

  const inserted = normalized.filter((row) => !existingSet.has(row.id)).length;

  return {
    productsProcessed: products.length,
    variantsSeen,
    processed,
    inserted,
    updated: processed - inserted,
    fallbackSkusApplied,
    skippedNullSkus: 0,
    durationMs: Date.now() - t0,
  };
}