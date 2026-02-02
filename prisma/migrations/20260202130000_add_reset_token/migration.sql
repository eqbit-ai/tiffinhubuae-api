-- AlterTable
ALTER TABLE "User" ADD COLUMN "reset_token" TEXT,
ADD COLUMN "reset_token_expires" TIMESTAMP(3);
