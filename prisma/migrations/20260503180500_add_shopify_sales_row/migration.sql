-- CreateTable
CREATE TABLE "ShopifySalesRow" (
    "sku" TEXT NOT NULL,
    "description" TEXT,
    "units7d" INTEGER NOT NULL DEFAULT 0,
    "units30d" INTEGER NOT NULL DEFAULT 0,
    "units90d" INTEGER NOT NULL DEFAULT 0,
    "revenue7d" DECIMAL NOT NULL DEFAULT 0,
    "revenue30d" DECIMAL NOT NULL DEFAULT 0,
    "revenue90d" DECIMAL NOT NULL DEFAULT 0,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifySalesRow_pkey" PRIMARY KEY ("sku")
);

-- CreateIndex
CREATE INDEX "ShopifySalesRow_units30d_idx" ON "ShopifySalesRow"("units30d");
