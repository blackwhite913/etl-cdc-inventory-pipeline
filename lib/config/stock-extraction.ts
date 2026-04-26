/**
 * Target warehouses for stock-on-hand extraction.
 *
 * Runtime evidence: Unleashed accepts a single `warehouseCode` per request, but
 * rejects `warehouseCode=U10,U3` with 403. Fetch each target warehouse separately,
 * then keep the backend safety filter before aggregation.
 */
export const TARGET_WAREHOUSE_CODES = ["U10", "U3"] as const;
export const TARGET_WAREHOUSES = new Set<string>(TARGET_WAREHOUSE_CODES);
