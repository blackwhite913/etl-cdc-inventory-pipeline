-- CreateTable
CREATE TABLE "CwStockSnapshot" (
    "productCode" TEXT NOT NULL,
    "warehouseCode" TEXT NOT NULL,
    "description" TEXT,
    "productGroup" TEXT,
    "qtyOnHand" INTEGER NOT NULL,
    "allocatedQty" INTEGER NOT NULL,
    "availableQty" INTEGER NOT NULL,
    "onPurchase" INTEGER NOT NULL,
    "avgCost" DOUBLE PRECISION,
    "totalCost" DOUBLE PRECISION,
    "daysSinceLastSale" INTEGER,
    "lastModified" TIMESTAMP(3),
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CwStockSnapshot_pkey" PRIMARY KEY ("productCode","warehouseCode")
);

-- CreateIndex
CREATE INDEX "CwStockSnapshot_productCode_idx" ON "CwStockSnapshot"("productCode");

-- CreateIndex
CREATE INDEX "CwStockSnapshot_warehouseCode_idx" ON "CwStockSnapshot"("warehouseCode");

-- CreateIndex
CREATE INDEX "CwStockSnapshot_lastModified_idx" ON "CwStockSnapshot"("lastModified");
