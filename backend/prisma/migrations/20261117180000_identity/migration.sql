-- CreateEnum
CREATE TYPE "IdentityProviderCode" AS ENUM ('DEV', 'FAYDA_ESIGNET');

-- CreateEnum
CREATE TYPE "IdentityVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'CANCELLED', 'SUPERSEDED', 'SUSPENDED', 'REVERIFICATION_REQUIRED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "identity_subject_hmac" TEXT;

-- CreateTable
CREATE TABLE "identity_verifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "IdentityProviderCode" NOT NULL,
    "status" "IdentityVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "previous_identity_status" "IdentityStatus" NOT NULL,
    "consented_at" TIMESTAMPTZ(6) NOT NULL,
    "state_hash" TEXT NOT NULL,
    "request_secrets_enc" BYTEA,
    "session_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "callback_received_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "subject_hmac" TEXT,
    "verified_claims_enc" BYTEA,
    "assurance_level" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "valid_until" TIMESTAMPTZ(6),
    "outcome_code" TEXT,
    "reviewed_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "identity_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "identity_verifications_state_hash_key" ON "identity_verifications"("state_hash");

-- CreateIndex
CREATE INDEX "identity_verifications_user_id_created_at_idx" ON "identity_verifications"("user_id", "created_at" DESC);

-- CreateIndex (partial, unique: one open attempt per user)
CREATE UNIQUE INDEX "identity_verifications_one_pending_per_user" ON "identity_verifications"("user_id", "status") WHERE "status" = 'PENDING';

-- CreateIndex (partial, unique: one current verified identity per user)
CREATE UNIQUE INDEX "identity_verifications_one_current_per_user" ON "identity_verifications"("user_id") WHERE "status" IN ('VERIFIED', 'SUSPENDED', 'REVERIFICATION_REQUIRED');

-- CreateIndex (partial, unique: BR-ID-2 on the attempt table as well as on users)
CREATE UNIQUE INDEX "identity_verifications_verified_subject_key" ON "identity_verifications"("subject_hmac") WHERE "status" = 'VERIFIED';

-- CreateIndex (partial: expiry sweeps)
CREATE INDEX "identity_verifications_pending_expiry_idx" ON "identity_verifications"("session_expires_at") WHERE "status" = 'PENDING';

-- CreateIndex (partial: expiry sweeps)
CREATE INDEX "identity_verifications_verified_validity_idx" ON "identity_verifications"("valid_until") WHERE "status" = 'VERIFIED';

-- CreateIndex
CREATE UNIQUE INDEX "users_identity_subject_hmac_key" ON "users"("identity_subject_hmac");

-- AddForeignKey
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints for Phase 4 (identity verification).
-- Covered by test/integration/identity-db-constraints.spec.ts. The transition tables
-- below must match src/modules/identity/identity-state.ts.
-- ---------------------------------------------------------------------------

-- users: staff accounts have no customer identity (an officer can never verify, or
-- review, their own identity); the subject hash is a hex HMAC.
ALTER TABLE "users"
  ADD CONSTRAINT "users_identity_subject_format_chk" CHECK (
    "identity_subject_hmac" IS NULL OR "identity_subject_hmac" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "users_staff_has_no_identity_chk" CHECK (
    "account_type" = 'CUSTOMER' OR ("identity_status" = 'UNVERIFIED' AND "identity_subject_hmac" IS NULL)
  );

-- users.identity_status: only the transitions of 02 §3.2 (Phase 4 refinement); VERIFIED
-- requires a VERIFIED attempt for the same subject (no self-verification, even by a bug).
-- users.identity_subject_hmac is set once.
CREATE FUNCTION "users_identity_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."identity_subject_hmac" IS NOT NULL
     AND NEW."identity_subject_hmac" IS DISTINCT FROM OLD."identity_subject_hmac" THEN
    RAISE EXCEPTION 'users.identity_subject_hmac cannot be changed once set' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."identity_status" IS DISTINCT FROM OLD."identity_status" THEN
    IF NOT (
      (OLD."identity_status" = 'UNVERIFIED' AND NEW."identity_status" = 'PENDING') OR
      (OLD."identity_status" = 'PENDING' AND NEW."identity_status" IN ('VERIFIED', 'REJECTED', 'UNVERIFIED', 'EXPIRED', 'REVERIFICATION_REQUIRED', 'SUSPENDED')) OR
      (OLD."identity_status" = 'VERIFIED' AND NEW."identity_status" IN ('EXPIRED', 'REVERIFICATION_REQUIRED', 'SUSPENDED')) OR
      (OLD."identity_status" = 'REJECTED' AND NEW."identity_status" = 'PENDING') OR
      (OLD."identity_status" = 'EXPIRED' AND NEW."identity_status" = 'PENDING') OR
      (OLD."identity_status" = 'REVERIFICATION_REQUIRED' AND NEW."identity_status" IN ('PENDING', 'SUSPENDED')) OR
      (OLD."identity_status" = 'SUSPENDED' AND NEW."identity_status" = 'REVERIFICATION_REQUIRED')
    ) THEN
      RAISE EXCEPTION 'identity status transition % -> % is not allowed', OLD."identity_status", NEW."identity_status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."identity_status" = 'VERIFIED' AND (
      NEW."identity_subject_hmac" IS NULL OR NOT EXISTS (
        SELECT 1 FROM "identity_verifications"
        WHERE "user_id" = NEW."id" AND "status" = 'VERIFIED' AND "subject_hmac" = NEW."identity_subject_hmac"
      )
    ) THEN
      RAISE EXCEPTION 'VERIFIED requires a verified attempt for the bound identity' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "users_identity_guard"
  BEFORE UPDATE OF "identity_status", "identity_subject_hmac" ON "users"
  FOR EACH ROW EXECUTE FUNCTION "users_identity_guard"();

-- identity_verifications: hashes only; secrets only while open; verified attempts carry
-- their (encrypted) result; non-trivial outcomes carry a reason code.
ALTER TABLE "identity_verifications"
  ADD CONSTRAINT "identity_state_hash_format_chk" CHECK ("state_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "identity_subject_hmac_format_chk" CHECK ("subject_hmac" IS NULL OR "subject_hmac" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "identity_outcome_code_format_chk" CHECK ("outcome_code" IS NULL OR "outcome_code" ~ '^[A-Z_]{3,40}$'),
  ADD CONSTRAINT "identity_assurance_length_chk" CHECK ("assurance_level" IS NULL OR length("assurance_level") <= 200),
  ADD CONSTRAINT "identity_session_expiry_chk" CHECK ("session_expires_at" > "created_at"),
  ADD CONSTRAINT "identity_secrets_only_while_pending_chk" CHECK ("status" = 'PENDING' OR "request_secrets_enc" IS NULL),
  ADD CONSTRAINT "identity_pending_shape_chk" CHECK (
    "status" <> 'PENDING' OR ("completed_at" IS NULL AND "verified_at" IS NULL AND "request_secrets_enc" IS NOT NULL)
  ),
  ADD CONSTRAINT "identity_completed_shape_chk" CHECK ("status" = 'PENDING' OR "completed_at" IS NOT NULL),
  ADD CONSTRAINT "identity_outcome_required_chk" CHECK ("status" IN ('PENDING', 'VERIFIED') OR "outcome_code" IS NOT NULL),
  ADD CONSTRAINT "identity_verified_shape_chk" CHECK (
    "status" NOT IN ('VERIFIED', 'SUSPENDED', 'REVERIFICATION_REQUIRED') OR (
      "verified_at" IS NOT NULL AND "valid_until" IS NOT NULL AND "subject_hmac" IS NOT NULL AND "verified_claims_enc" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "identity_claims_only_if_verified_chk" CHECK ("verified_claims_enc" IS NULL OR "verified_at" IS NOT NULL),
  ADD CONSTRAINT "identity_validity_chk" CHECK ("valid_until" IS NULL OR ("verified_at" IS NOT NULL AND "valid_until" > "verified_at"));

-- Attempts start PENDING, only for customer accounts; identifying columns never change;
-- the callback marker, subject and verification time are set once; status changes follow
-- the transition table.
CREATE FUNCTION "identity_verifications_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'identity verifications start PENDING' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."user_id" AND "account_type" = 'CUSTOMER') THEN
      RAISE EXCEPTION 'identity verification is for customer accounts only' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."previous_identity_status" IS DISTINCT FROM OLD."previous_identity_status"
     OR NEW."consented_at" IS DISTINCT FROM OLD."consented_at"
     OR NEW."state_hash" IS DISTINCT FROM OLD."state_hash"
     OR NEW."session_expires_at" IS DISTINCT FROM OLD."session_expires_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (OLD."callback_received_at" IS NOT NULL AND NEW."callback_received_at" IS DISTINCT FROM OLD."callback_received_at")
     OR (OLD."subject_hmac" IS NOT NULL AND NEW."subject_hmac" IS DISTINCT FROM OLD."subject_hmac")
     OR (OLD."verified_at" IS NOT NULL AND NEW."verified_at" IS DISTINCT FROM OLD."verified_at") THEN
    RAISE EXCEPTION 'identity verification columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'CANCELLED', 'SUPERSEDED')) OR
    (OLD."status" = 'VERIFIED' AND NEW."status" IN ('EXPIRED', 'REVERIFICATION_REQUIRED', 'SUSPENDED')) OR
    (OLD."status" = 'REVERIFICATION_REQUIRED' AND NEW."status" IN ('SUSPENDED', 'SUPERSEDED')) OR
    (OLD."status" = 'SUSPENDED' AND NEW."status" = 'REVERIFICATION_REQUIRED')
  ) THEN
    RAISE EXCEPTION 'identity verification transition % -> % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "identity_verifications_guard"
  BEFORE INSERT OR UPDATE ON "identity_verifications"
  FOR EACH ROW EXECUTE FUNCTION "identity_verifications_guard"();
