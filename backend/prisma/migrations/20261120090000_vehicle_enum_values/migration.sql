-- Phase 7: new enum types and values. Kept in their own migration: PostgreSQL cannot use
-- an enum value in the transaction that adds it (the next migration's CHECKs do).
-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('SEDAN', 'HATCHBACK', 'SUV', 'MINIBUS', 'PICKUP', 'THREE_WHEELER', 'OTHER');

-- CreateEnum
CREATE TYPE "VehicleTransmission" AS ENUM ('MANUAL', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "VehicleFuelType" AS ENUM ('PETROL', 'DIESEL', 'ELECTRIC', 'HYBRID', 'OTHER');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "VehicleEvidenceSlot" AS ENUM ('REGISTRATION', 'OWNERSHIP', 'INSURANCE', 'INSPECTION', 'PHOTO_FRONT', 'PHOTO_BACK', 'PHOTO_LEFT', 'PHOTO_RIGHT', 'PHOTO_PLATE', 'PHOTO_INTERIOR');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentPurpose" ADD VALUE 'VEHICLE_REGISTRATION';
ALTER TYPE "DocumentPurpose" ADD VALUE 'VEHICLE_OWNERSHIP';
ALTER TYPE "DocumentPurpose" ADD VALUE 'VEHICLE_INSURANCE';
ALTER TYPE "DocumentPurpose" ADD VALUE 'VEHICLE_INSPECTION';
ALTER TYPE "DocumentPurpose" ADD VALUE 'VEHICLE_PHOTO';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReviewReasonCode" ADD VALUE 'VEHICLE_DETAILS_MISMATCH';
ALTER TYPE "ReviewReasonCode" ADD VALUE 'INVALID_DOCUMENT';

