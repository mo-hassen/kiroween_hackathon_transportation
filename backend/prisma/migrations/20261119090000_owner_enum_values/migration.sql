-- Phase 6: new enum types and values. Kept in their own migration: PostgreSQL cannot use
-- an enum value in the transaction that adds it (the next migration's CHECKs do).

-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('INDIVIDUAL', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "OwnerVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED', 'EXPIRED', 'REVERIFICATION_REQUIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentPurpose" ADD VALUE 'OWNER_TIN';
ALTER TYPE "DocumentPurpose" ADD VALUE 'OWNER_BUSINESS_LICENSE';
ALTER TYPE "DocumentPurpose" ADD VALUE 'OWNER_REPRESENTATIVE_LETTER';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReviewReasonCode" ADD VALUE 'INVALID_ORGANIZATION_DETAILS';
ALTER TYPE "ReviewReasonCode" ADD VALUE 'REPRESENTATIVE_NOT_AUTHORIZED';
