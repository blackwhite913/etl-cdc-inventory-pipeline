import crypto from "node:crypto";

const UNLEASHED_API_BASE_URL = "https://api.unleashedsoftware.com";

type UnleashedPagination = {
  NumberOfItems: number;
  PageSize: number;
  PageNumber: number;
  NumberOfPages: number;
};

export type UnleashedStockOnHandResponse = {
  Pagination: UnleashedPagination;
  Items: Record<string, unknown>[];
};

export class UnleashedHttpError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly responseBody: string,
    page: number,
  ) {
    const bodyPreview = responseBody.slice(0, 500);
    const base = `Unleashed API request failed for page ${page}: ${httpStatus} — ${bodyPreview}`;
    super(
      httpStatus === 403
        ? `Unleashed API returned 403 Forbidden (page ${page}). In Unleashed, open API access, confirm this API Id matches the company, and rotate or paste the private key into UNLEASHED_API_KEY in .env.local, then restart the dev server. If you recently added invalid query parameters (e.g. a comma list for warehouseCode), Unleashed may return 403 — use post-fetch filtering for multiple warehouses.`
        : base,
    );
    this.name = "UnleashedHttpError";
  }
}

function getUnleashedCredentials() {
  const apiId = process.env.UNLEASHED_API_ID?.trim();
  const apiKey = process.env.UNLEASHED_API_KEY?.trim();

  if (!apiId || !apiKey) {
    throw new Error("Missing UNLEASHED_API_ID or UNLEASHED_API_KEY");
  }

  return { apiId, apiKey };
}

/**
 * Unleashed signs HMAC-SHA256(apiKey) over the **query string only** (no `?`, no path).
 * @see https://apidocs.unleashedsoftware.com/AuthenticationHelp
 */
function signUnleashedQueryString(queryString: string): string {
  const { apiKey } = getUnleashedCredentials();
  return crypto
    .createHmac("sha256", apiKey)
    .update(queryString, "utf8")
    .digest("base64");
}

export function buildUnleashedAuthHeaders(queryString: string): HeadersInit {
  const { apiId } = getUnleashedCredentials();
  const signature = signUnleashedQueryString(queryString);

  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "api-auth-id": apiId,
    "api-auth-signature": signature,
    "client-type": "etl/stockonhand",
  };
}

type StockOnHandQueryOptions = {
  warehouseCode?: string;
  /**
   * ISO datetime in `YYYY-MM-DDTHH:mm:ss` (UTC, no `Z`) — Unleashed format.
   * Use {@link formatUnleashedModifiedSince} to build this string from a Date.
   */
  modifiedSince?: string;
};

function buildStockOnHandQueryString(options: StockOnHandQueryOptions = {}): string {
  const q = new URLSearchParams();
  if (options.modifiedSince) {
    q.set("modifiedSince", options.modifiedSince);
  }
  if (options.warehouseCode) {
    q.set("warehouseCode", options.warehouseCode);
  }
  return q.toString();
}

/**
 * For this Unleashed tenant, StockOnHand `modifiedSince` accepts date-only
 * (`YYYY-MM-DD`). Datetime formats return 403 on this endpoint.
 */
export function formatUnleashedModifiedSince(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function fetchStockOnHandPage(
  page: number,
  options: StockOnHandQueryOptions = {},
): Promise<UnleashedStockOnHandResponse> {
  const queryString = buildStockOnHandQueryString(options);
  const requestUrl = `${UNLEASHED_API_BASE_URL}/StockOnHand/${page}${
    queryString ? `?${queryString}` : ""
  }`;
  const headers = buildUnleashedAuthHeaders(queryString);

  const response = await fetch(requestUrl, {
    method: "GET",
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new UnleashedHttpError(response.status, errorText, page);
  }

  const payload = (await response.json()) as UnleashedStockOnHandResponse;
  return payload;
}
