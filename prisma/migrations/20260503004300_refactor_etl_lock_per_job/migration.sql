-- AlterTable
ALTER TABLE "EtlLock" DROP CONSTRAINT "EtlLock_pkey",
DROP COLUMN "holder",
DROP COLUMN "id",
ADD COLUMN     "jobName" TEXT NOT NULL,
ALTER COLUMN "acquiredAt" DROP DEFAULT,
ADD CONSTRAINT "EtlLock_pkey" PRIMARY KEY ("jobName");

