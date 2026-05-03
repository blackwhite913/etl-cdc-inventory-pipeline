import {
  fetchShopifyOrderLineItemsPage,
  fetchShopifyOrdersPage,
  type ShopifyOrder,
  type ShopifyOrderLineItem,
} from "@/lib/shopify";

const DEFAULT_WINDOW_DAYS = 90;

export type ShopifyOrderRaw = ShopifyOrder;
export type ShopifyOrderItemRaw = ShopifyOrderLineItem;

export type ExtractShopifyOrdersMeta = {
  totalOrdersFetched: number;
  totalItemsSeen: number;
  totalPagesFetched: number;
  totalItemSubPagesFetched: number;
  ordersWithItemOverflow: number;
  startedAt: number;
  finishedAt: number;
  totalTimeMs: number;
  query: string;
};

export type ExtractShopifyOrdersResult = {
  orders: ShopifyOrderRaw[];
  meta: ExtractShopifyOrdersMeta;
};

export type ExtractShopifyOrdersOptions = {
  createdAtGte?: Date;
  onBatch?: (orders: ShopifyOrderRaw[]) => Promise<void>;
};

function buildOrdersSearchQuery(createdAtGte?: Date): string {
  const windowStart =
    createdAtGte ??
    new Date(Date.now() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return `financial_status:paid created_at:>=${windowStart.toISOString()}`;
}

async function hydrateAllLineItems(
  order: ShopifyOrderRaw,
): Promise<{
  items: ShopifyOrderItemRaw[];
  subPagesFetched: number;
  fetchedOverflowPages: boolean;
}> {
  const items = Array.isArray(order.lineItems?.nodes) ? [...order.lineItems.nodes] : [];
  let cursor = order.lineItems?.pageInfo?.endCursor ?? null;
  let hasNextPage = Boolean(order.lineItems?.pageInfo?.hasNextPage);
  let subPagesFetched = 0;
  const fetchedOverflowPages = hasNextPage;

  while (hasNextPage) {
    if (!cursor) {
      throw new Error(`Line item pagination missing endCursor for order ${order.id}`);
    }

    const nextPage = await fetchShopifyOrderLineItemsPage({
      orderId: order.id,
      cursor,
    });
    subPagesFetched += 1;
    items.push(...nextPage.items);
    hasNextPage = nextPage.pageInfo.hasNextPage;
    cursor = nextPage.pageInfo.endCursor;
  }

  return {
    items,
    subPagesFetched,
    fetchedOverflowPages,
  };
}

export async function extractAllShopifyOrders(
  options: ExtractShopifyOrdersOptions = {},
): Promise<ExtractShopifyOrdersResult> {
  const startedAt = Date.now();
  const query = buildOrdersSearchQuery(options.createdAtGte);
  const isStreaming = typeof options.onBatch === "function";
  const accumulator: ShopifyOrderRaw[] = [];

  let cursor: string | null = null;
  let hasNextPage = true;
  let totalOrdersFetched = 0;
  let totalItemsSeen = 0;
  let totalPagesFetched = 0;
  let totalItemSubPagesFetched = 0;
  let ordersWithItemOverflow = 0;

  while (hasNextPage) {
    const page = await fetchShopifyOrdersPage({
      cursor,
      query,
    });
    totalPagesFetched += 1;
    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
      throw new Error(
        `[extract-shopify-orders] page ${totalPagesFetched} hasNextPage=true but endCursor is null`,
      );
    }

    const normalizedOrders: ShopifyOrderRaw[] = [];
    for (const order of page.orders) {
      totalOrdersFetched += 1;
      const hydrated = await hydrateAllLineItems(order);
      if (hydrated.fetchedOverflowPages) {
        ordersWithItemOverflow += 1;
      }
      totalItemSubPagesFetched += hydrated.subPagesFetched;
      totalItemsSeen += hydrated.items.length;

      normalizedOrders.push({
        ...order,
        lineItems: {
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
          },
          nodes: hydrated.items,
        },
      });
    }

    if (isStreaming) {
      if (normalizedOrders.length > 0) {
        await options.onBatch!(normalizedOrders);
      }
    } else {
      accumulator.push(...normalizedOrders);
    }

    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  const finishedAt = Date.now();
  return {
    orders: accumulator,
    meta: {
      totalOrdersFetched,
      totalItemsSeen,
      totalPagesFetched,
      totalItemSubPagesFetched,
      ordersWithItemOverflow,
      startedAt,
      finishedAt,
      totalTimeMs: finishedAt - startedAt,
      query,
    },
  };
}
