import { prisma } from "@/lib/prisma";

import type { ShopifyOrderRaw } from "@/lib/extract-shopify-orders";

const SHOPIFY_ORDERS_TRANSACTION_BATCH = 50;

type ShopifyOrderInput = {
  id: string;
  orderNumber: string;
  createdAt: Date;
  subtotalPrice: string | null;
  financialStatus: string;
  fulfillmentStatus: string | null;
  syncedAt: Date;
};

type ShopifyOrderItemInput = {
  id: string;
  orderId: string;
  sku: string;
  title: string;
  quantity: number;
  price: string | null;
};

export type ShopifyOrdersLoadResult = {
  ordersProcessed: number;
  itemsProcessed: number;
  insertedOrders: number;
  updatedOrders: number;
  durationMs: number;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function normalizeFinancialStatus(status: string | null): string {
  const normalized = status?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

function shouldIncludeLineItem(sku: string | null, title: string | null): boolean {
  const normalizedSku = sku?.trim();
  if (!normalizedSku) return false;
  if (normalizedSku.toUpperCase().startsWith("PAC-")) return false;

  const lowerTitle = (title ?? "").toLowerCase();
  if (lowerTitle.includes("gift")) return false;
  if (lowerTitle.includes("personalisation")) return false;
  return true;
}

function normalizeOrder(order: ShopifyOrderRaw, syncedAt: Date): ShopifyOrderInput | null {
  const financialStatus = normalizeFinancialStatus(order.financialStatus);
  if (financialStatus !== "paid") {
    return null;
  }

  const createdAt = order.createdAt ? new Date(order.createdAt) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) {
    return null;
  }

  const normalizedOrderNumber = order.orderNumber?.trim();
  if (!normalizedOrderNumber) {
    return null;
  }

  return {
    id: order.id,
    orderNumber: normalizedOrderNumber,
    createdAt,
    subtotalPrice: order.subtotalPrice?.trim() || null,
    financialStatus,
    fulfillmentStatus: order.fulfillmentStatus?.trim() || null,
    syncedAt,
  };
}

function normalizeOrderItems(order: ShopifyOrderRaw): ShopifyOrderItemInput[] {
  const items = Array.isArray(order.lineItems?.nodes) ? order.lineItems.nodes : [];
  const normalized: ShopifyOrderItemInput[] = [];

  for (const item of items) {
    if (!shouldIncludeLineItem(item.sku, item.title)) continue;

    const sku = item.sku!.trim();
    const title = item.title?.trim() || "";
    const quantity =
      typeof item.quantity === "number" && Number.isFinite(item.quantity) ? Math.max(0, item.quantity) : 0;
    if (quantity <= 0) continue;

    normalized.push({
      id: item.id,
      orderId: order.id,
      sku,
      title,
      quantity,
      price: item.price?.trim() || null,
    });
  }

  return normalized;
}

export async function loadShopifyOrdersBatch(orders: ShopifyOrderRaw[]): Promise<ShopifyOrdersLoadResult> {
  const t0 = Date.now();
  const syncedAt = new Date();

  const normalizedOrders: ShopifyOrderInput[] = [];
  const allItemsByOrderId = new Map<string, ShopifyOrderItemInput[]>();

  for (const order of orders) {
    const normalizedOrder = normalizeOrder(order, syncedAt);
    if (!normalizedOrder) continue;
    normalizedOrders.push(normalizedOrder);
    allItemsByOrderId.set(order.id, normalizeOrderItems(order));
  }

  if (normalizedOrders.length === 0) {
    return {
      ordersProcessed: 0,
      itemsProcessed: 0,
      insertedOrders: 0,
      updatedOrders: 0,
      durationMs: Date.now() - t0,
    };
  }

  let insertedOrders = 0;
  let updatedOrders = 0;
  let itemsProcessed = 0;

  for (const orderChunk of chunk(normalizedOrders, SHOPIFY_ORDERS_TRANSACTION_BATCH)) {
    const chunkIds = orderChunk.map((row) => row.id);
    const existingRows = await prisma.shopifyOrder.findMany({
      where: { id: { in: chunkIds } },
      select: { id: true },
    });
    const existingSet = new Set(existingRows.map((row) => row.id));

    const createRows = orderChunk.filter((row) => !existingSet.has(row.id));
    const updateRows = orderChunk.filter((row) => existingSet.has(row.id));
    const itemRows = orderChunk.flatMap((row) => allItemsByOrderId.get(row.id) ?? []);

    await prisma.$transaction([
      ...(createRows.length > 0
        ? [
            prisma.shopifyOrder.createMany({
              data: createRows,
              skipDuplicates: true,
            }),
          ]
        : []),
      ...updateRows.map((row) =>
        prisma.shopifyOrder.update({
          where: { id: row.id },
          data: {
            orderNumber: row.orderNumber,
            createdAt: row.createdAt,
            subtotalPrice: row.subtotalPrice,
            financialStatus: row.financialStatus,
            fulfillmentStatus: row.fulfillmentStatus,
            syncedAt: row.syncedAt,
          },
        }),
      ),
      prisma.shopifyOrderItem.deleteMany({
        where: { orderId: { in: chunkIds } },
      }),
      ...(itemRows.length > 0
        ? [
            prisma.shopifyOrderItem.createMany({
              data: itemRows,
            }),
          ]
        : []),
    ]);

    insertedOrders += createRows.length;
    updatedOrders += updateRows.length;
    itemsProcessed += itemRows.length;
  }

  return {
    ordersProcessed: normalizedOrders.length,
    itemsProcessed,
    insertedOrders,
    updatedOrders,
    durationMs: Date.now() - t0,
  };
}
