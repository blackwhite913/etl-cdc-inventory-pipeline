const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_FETCH_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 400;
const DEFAULT_API_VERSION = "2026-04";

class ShopifyRateLimitError extends Error {
  constructor(public readonly waitMs: number) {
    super(`Shopify throttled request (429); retrying in ${waitMs}ms`);
    this.name = "ShopifyRateLimitError";
  }
}

type ShopifyPageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

type ShopifyVariantNode = {
  id: string;
  sku: string | null;
  title: string | null;
  price: string | null;
  inventoryQuantity: number | null;
};

type ShopifyProductNode = {
  id: string;
  title: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  status: string | null;
  updatedAt: string | null;
  variants: ShopifyVariantsConnection;
};

type ShopifyVariantsConnection = {
  pageInfo: ShopifyPageInfo;
  nodes: ShopifyVariantNode[];
};

type ShopifyProductsConnection = {
  pageInfo: ShopifyPageInfo;
  nodes: ShopifyProductNode[];
};

type ShopifyMoneyAmount = {
  amount: string;
};

type ShopifyMoneySet = {
  shopMoney: ShopifyMoneyAmount | null;
};

type ShopifyOrderLineItemNode = {
  id: string;
  sku: string | null;
  title: string | null;
  quantity: number | null;
  originalUnitPriceSet: ShopifyMoneySet | null;
};

type ShopifyOrderLineItemsConnection = {
  pageInfo: ShopifyPageInfo;
  nodes: ShopifyOrderLineItemNode[];
};

type ShopifyOrderNode = {
  id: string;
  name: string | null;
  createdAt: string | null;
  subtotalPriceSet: ShopifyMoneySet | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  lineItems: ShopifyOrderLineItemsConnection;
};

type ShopifyOrdersConnection = {
  pageInfo: ShopifyPageInfo;
  nodes: ShopifyOrderNode[];
};

type ShopifyGraphqlData = {
  products: ShopifyProductsConnection;
};

type ShopifyProductVariantsData = {
  product: {
    variants: ShopifyVariantsConnection;
  } | null;
};

type ShopifyOrdersGraphqlData = {
  orders: ShopifyOrdersConnection;
};

type ShopifyOrderLineItemsData = {
  order: {
    lineItems: ShopifyOrderLineItemsConnection;
  } | null;
};

type ShopifyGraphqlError = {
  message?: string;
  extensions?: {
    code?: string;
  };
};

type ShopifyGraphqlResponse<TData> = {
  data?: TData;
  errors?: ShopifyGraphqlError[];
};

export type FetchShopifyPageOptions = {
  cursor?: string | null;
  query: string;
};

export type ShopifyProductsPage = {
  pageInfo: ShopifyPageInfo;
  products: ShopifyProductNode[];
};

export type FetchShopifyVariantsPageOptions = {
  productId: string;
  cursor?: string | null;
};

export type ShopifyVariantsPage = {
  pageInfo: ShopifyPageInfo;
  variants: ShopifyVariantNode[];
};

export type FetchShopifyOrdersPageOptions = {
  cursor?: string | null;
  query: string;
};

export type ShopifyOrderLineItem = {
  id: string;
  sku: string | null;
  title: string | null;
  quantity: number | null;
  price: string | null;
};

export type ShopifyOrder = {
  id: string;
  orderNumber: string | null;
  createdAt: string | null;
  subtotalPrice: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  lineItems: {
    pageInfo: ShopifyPageInfo;
    nodes: ShopifyOrderLineItem[];
  };
};

export type ShopifyOrdersPage = {
  pageInfo: ShopifyPageInfo;
  orders: ShopifyOrder[];
};

export type FetchShopifyOrderLineItemsPageOptions = {
  orderId: string;
  cursor?: string | null;
};

export type ShopifyOrderLineItemsPage = {
  pageInfo: ShopifyPageInfo;
  items: ShopifyOrderLineItem[];
};

function parseNonNegativeIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[shopify] invalid ${name}=${raw}; using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  return null;
}

function getShopifyCredentials() {
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN?.trim();
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN?.trim();
  const apiVersion = process.env.SHOPIFY_API_VERSION?.trim() || DEFAULT_API_VERSION;

  if (!accessToken || !storeDomain) {
    throw new Error("Missing SHOPIFY_ACCESS_TOKEN or SHOPIFY_STORE_DOMAIN");
  }

  return { accessToken, storeDomain, apiVersion };
}

function buildShopifyGraphqlUrl(): string {
  const { storeDomain, apiVersion } = getShopifyCredentials();
  const normalizedDomain = storeDomain.startsWith("http://") || storeDomain.startsWith("https://")
    ? storeDomain
    : `https://${storeDomain}`;
  const withoutTrailingSlash = normalizedDomain.replace(/\/+$/, "");
  return `${withoutTrailingSlash}/admin/api/${apiVersion}/graphql.json`;
}

function buildProductsQuery(): string {
  return `
    query FetchProducts($cursor: String, $query: String!) {
      products(first: 100, after: $cursor, query: $query) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          vendor
          productType
          tags
          status
          updatedAt
          variants(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              sku
              title
              price
              inventoryQuantity
            }
          }
        }
      }
    }
  `;
}

function buildVariantsQuery(): string {
  return `
    query FetchProductVariants($productId: ID!, $cursor: String) {
      product(id: $productId) {
        variants(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            sku
            title
            price
            inventoryQuantity
          }
        }
      }
    }
  `;
}

function buildOrdersQuery(): string {
  return `
    query FetchOrders($cursor: String, $query: String!) {
      orders(first: 100, after: $cursor, query: $query) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          name
          createdAt
          subtotalPriceSet {
            shopMoney {
              amount
            }
          }
          displayFinancialStatus
          displayFulfillmentStatus
          lineItems(first: 250) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              sku
              title
              quantity
              originalUnitPriceSet {
                shopMoney {
                  amount
                }
              }
            }
          }
        }
      }
    }
  `;
}

function buildOrderLineItemsQuery(): string {
  return `
    query FetchOrderLineItems($orderId: ID!, $cursor: String) {
      order(id: $orderId) {
        lineItems(first: 250, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            sku
            title
            quantity
            originalUnitPriceSet {
              shopMoney {
                amount
              }
            }
          }
        }
      }
    }
  `;
}

function toShopifyOrderLineItem(node: ShopifyOrderLineItemNode): ShopifyOrderLineItem {
  return {
    id: node.id,
    sku: node.sku,
    title: node.title,
    quantity: node.quantity,
    price: node.originalUnitPriceSet?.shopMoney?.amount ?? null,
  };
}

function toShopifyOrder(node: ShopifyOrderNode): ShopifyOrder {
  return {
    id: node.id,
    orderNumber: node.name,
    createdAt: node.createdAt,
    subtotalPrice: node.subtotalPriceSet?.shopMoney?.amount ?? null,
    financialStatus: node.displayFinancialStatus,
    fulfillmentStatus: node.displayFulfillmentStatus,
    lineItems: {
      pageInfo: node.lineItems.pageInfo,
      nodes: (node.lineItems.nodes ?? []).map(toShopifyOrderLineItem),
    },
  };
}

async function postShopifyGraphql<TData>(
  query: string,
  variables: Record<string, unknown>,
  requestLabel: string,
): Promise<TData> {
  const { accessToken } = getShopifyCredentials();
  const requestUrl = buildShopifyGraphqlUrl();
  const timeoutMs = parseNonNegativeIntEnv("SHOPIFY_FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS);
  const maxRetries = parseNonNegativeIntEnv("SHOPIFY_FETCH_RETRIES", DEFAULT_FETCH_RETRIES);
  const baseDelayMs = parseNonNegativeIntEnv("SHOPIFY_RETRY_BASE_DELAY_MS", DEFAULT_RETRY_BASE_DELAY_MS);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({
          query,
          variables,
        }),
      });

      if (response.status === 429) {
        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
        const waitMs = retryAfter ?? baseDelayMs * (attempt + 1);
        throw new ShopifyRateLimitError(waitMs);
      }

      const payload = (await response.json()) as ShopifyGraphqlResponse<TData>;
      if (!response.ok) {
        const detail =
          payload.errors?.map((e) => e.message).filter(Boolean).join("; ") || response.statusText;
        throw new Error(`Shopify API request failed: ${response.status} ${detail}`);
      }

      if (payload.errors && payload.errors.length > 0) {
        const detail = payload.errors.map((err) => err.message ?? "Unknown GraphQL error").join("; ");
        throw new Error(`Shopify GraphQL errors: ${detail}`);
      }

      if (!payload.data) {
        throw new Error("Shopify response missing data payload");
      }

      return payload.data;
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Shopify request timed out after ${timeoutMs}ms (retries=${maxRetries})`);
        }
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      const waitMs = error instanceof ShopifyRateLimitError ? error.waitMs : baseDelayMs * (attempt + 1);
      console.warn(
        `[shopify] retrying ${requestLabel} attempt=${attempt + 1}/${maxRetries} error=${errorMessage}`,
      );
      await delay(waitMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Failed to fetch Shopify ${requestLabel}`);
}

export async function fetchShopifyProductsPage(
  options: FetchShopifyPageOptions,
): Promise<ShopifyProductsPage> {
  const data = await postShopifyGraphql<ShopifyGraphqlData>(
    buildProductsQuery(),
    {
      cursor: options.cursor ?? null,
      query: options.query,
    },
    "products page",
  );

  const products = data.products;
  if (!products) {
    throw new Error("Shopify response missing products payload");
  }

  return {
    pageInfo: products.pageInfo,
    products: products.nodes ?? [],
  };
}

export async function fetchShopifyVariantsPage(
  options: FetchShopifyVariantsPageOptions,
): Promise<ShopifyVariantsPage> {
  const data = await postShopifyGraphql<ShopifyProductVariantsData>(
    buildVariantsQuery(),
    {
      productId: options.productId,
      cursor: options.cursor ?? null,
    },
    "product variants page",
  );

  if (!data.product?.variants) {
    throw new Error(`Shopify response missing variants for product ${options.productId}`);
  }

  return {
    pageInfo: data.product.variants.pageInfo,
    variants: data.product.variants.nodes ?? [],
  };
}

export async function fetchShopifyOrdersPage(
  options: FetchShopifyOrdersPageOptions,
): Promise<ShopifyOrdersPage> {
  const data = await postShopifyGraphql<ShopifyOrdersGraphqlData>(
    buildOrdersQuery(),
    {
      cursor: options.cursor ?? null,
      query: options.query,
    },
    "orders page",
  );

  if (!data.orders) {
    throw new Error("Shopify response missing orders payload");
  }

  return {
    pageInfo: data.orders.pageInfo,
    orders: (data.orders.nodes ?? []).map(toShopifyOrder),
  };
}

export async function fetchShopifyOrderLineItemsPage(
  options: FetchShopifyOrderLineItemsPageOptions,
): Promise<ShopifyOrderLineItemsPage> {
  const data = await postShopifyGraphql<ShopifyOrderLineItemsData>(
    buildOrderLineItemsQuery(),
    {
      orderId: options.orderId,
      cursor: options.cursor ?? null,
    },
    "order line items page",
  );

  if (!data.order?.lineItems) {
    throw new Error(`Shopify response missing line items for order ${options.orderId}`);
  }

  return {
    pageInfo: data.order.lineItems.pageInfo,
    items: (data.order.lineItems.nodes ?? []).map(toShopifyOrderLineItem),
  };
}
