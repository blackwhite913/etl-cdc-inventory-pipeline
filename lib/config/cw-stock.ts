/**
 * 3PL warehouses fetched by the CW Logistics stock ETL.
 *
 * CW Logistics is a third-party logistics provider; its stock-on-hand is
 * refreshed once a day inside the daily ETL job, not on the 2-minute U10/U3
 * cadence. Unleashed accepts a single `warehouseCode` per request, so each
 * code here is fetched separately (see extractAllStock).
 */
export const CW_WAREHOUSE_CODES = ["CWL_001"] as const;
export const CW_WAREHOUSES = new Set<string>(CW_WAREHOUSE_CODES);
