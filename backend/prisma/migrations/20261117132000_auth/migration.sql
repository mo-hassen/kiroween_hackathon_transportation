-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('SUPPORT', 'VERIFICATION_OFFICER', 'FINANCE', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('REGISTER', 'LOGIN_STEP_UP', 'PASSWORD_RESET', 'STAFF_ACTIVATION', 'STAFF_MFA_ENROLLMENT');

-- AlterEnum
ALTER TYPE "AccountStatus" ADD VALUE 'PENDING_ACTIVATION';

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "trusted_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "authenticated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "rotated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mfa_enrolled_at" TIMESTAMPTZ(6),
ADD COLUMN     "mfa_last_used_step" BIGINT,
ADD COLUMN     "password_changed_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "retired_refresh_tokens" (
    "token_hash" TEXT NOT NULL,
    "session_id" UUID NOT NULL,
    "retired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retired_refresh_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "staff_role_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "StaffRole" NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "staff_role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "user_id" UUID,
    "installation_id" TEXT,
    "code_hash" TEXT,
    "ticket_hash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "retired_refresh_tokens_session_id_idx" ON "retired_refresh_tokens"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_role_assignments_user_id_role_key" ON "staff_role_assignments"("user_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "otp_challenges_ticket_hash_key" ON "otp_challenges"("ticket_hash");

-- CreateIndex
CREATE INDEX "otp_challenges_phone_e164_purpose_created_at_idx" ON "otp_challenges"("phone_e164", "purpose", "created_at" DESC);

-- CreateIndex
CREATE INDEX "otp_challenges_user_id_purpose_idx" ON "otp_challenges"("user_id", "purpose");

-- AddForeignKey
ALTER TABLE "retired_refresh_tokens" ADD CONSTRAINT "retired_refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_role_assignments" ADD CONSTRAINT "staff_role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_role_assignments" ADD CONSTRAINT "staff_role_assignments_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_role_assignments" ADD CONSTRAINT "staff_role_assignments_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints for Phase 3 (authentication).
-- Covered by test/integration/auth-db-constraints.spec.ts.
-- Note: 'PENDING_ACTIVATION' is added above and must not be referenced in this
-- migration (Postgres forbids using a new enum value in the same transaction).
-- ---------------------------------------------------------------------------

-- users: MFA is staff-only; an ACTIVE staff account always has an enrolled TOTP secret.
ALTER TABLE "users"
  ADD CONSTRAINT "users_mfa_last_used_step_chk" CHECK ("mfa_last_used_step" IS NULL OR "mfa_last_used_step" >= 0),
  ADD CONSTRAINT "users_customer_has_no_mfa_chk" CHECK (
    "account_type" = 'STAFF' OR ("mfa_secret_enc" IS NULL AND "mfa_enrolled_at" IS NULL AND "mfa_last_used_step" IS NULL)
  ),
  ADD CONSTRAINT "users_active_staff_has_mfa_chk" CHECK (
    "account_type" <> 'STAFF' OR "status" <> 'ACTIVE' OR ("mfa_enrolled_at" IS NOT NULL AND "mfa_secret_enc" IS NOT NULL)
  );

-- BR-ACC-2: an account never changes between customer and staff.
CREATE FUNCTION "users_account_type_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."account_type" IS DISTINCT FROM OLD."account_type" THEN
    RAISE EXCEPTION 'users.account_type is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "users_account_type_immutable"
  BEFORE UPDATE OF "account_type" ON "users"
  FOR EACH ROW EXECUTE FUNCTION "users_account_type_immutable"();

-- sessions / retired tokens: only SHA-256 hex digests are ever stored.
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_token_hash_format_chk" CHECK (
    "current_token_hash" ~ '^[0-9a-f]{64}$' AND ("previous_token_hash" IS NULL OR "previous_token_hash" ~ '^[0-9a-f]{64}$')
  );

ALTER TABLE "retired_refresh_tokens"
  ADD CONSTRAINT "retired_refresh_tokens_hash_format_chk" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

-- staff_role_assignments: no self-grant; revocation metadata consistent.
ALTER TABLE "staff_role_assignments"
  ADD CONSTRAINT "staff_roles_no_self_grant_chk" CHECK ("granted_by" IS NULL OR "granted_by" <> "user_id"),
  ADD CONSTRAINT "staff_roles_revoked_by_chk" CHECK ("revoked_by" IS NULL OR "revoked_at" IS NOT NULL);

-- Roles can only be held by, and granted by, staff accounts (BR-ACC-2).
CREATE FUNCTION "staff_role_assignments_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."user_id" AND "account_type" = 'STAFF') THEN
    RAISE EXCEPTION 'staff roles can only be held by staff accounts' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."granted_by" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."granted_by" AND "account_type" = 'STAFF') THEN
    RAISE EXCEPTION 'staff roles can only be granted by staff accounts' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "staff_role_assignments_guard"
  BEFORE INSERT OR UPDATE ON "staff_role_assignments"
  FOR EACH ROW EXECUTE FUNCTION "staff_role_assignments_guard"();

-- otp_challenges: hashes only, bounded attempts, purpose-specific shape.
ALTER TABLE "otp_challenges"
  ADD CONSTRAINT "otp_phone_format_chk" CHECK ("phone_e164" ~ '^\+251[79][0-9]{8}$'),
  ADD CONSTRAINT "otp_code_hash_format_chk" CHECK ("code_hash" IS NULL OR "code_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "otp_ticket_hash_format_chk" CHECK ("ticket_hash" IS NULL OR "ticket_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "otp_attempts_chk" CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts"),
  ADD CONSTRAINT "otp_max_attempts_chk" CHECK ("max_attempts" BETWEEN 1 AND 10),
  ADD CONSTRAINT "otp_expiry_chk" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "otp_consumed_time_chk" CHECK ("consumed_at" IS NULL OR "consumed_at" >= "created_at"),
  ADD CONSTRAINT "otp_purpose_shape_chk" CHECK (
    CASE "purpose"
      WHEN 'REGISTER' THEN "user_id" IS NULL AND "code_hash" IS NOT NULL AND "ticket_hash" IS NULL
      WHEN 'PASSWORD_RESET' THEN "user_id" IS NOT NULL AND "code_hash" IS NOT NULL AND "ticket_hash" IS NULL
      WHEN 'LOGIN_STEP_UP' THEN "user_id" IS NOT NULL AND "installation_id" IS NOT NULL
        AND "code_hash" IS NOT NULL AND "ticket_hash" IS NOT NULL
      WHEN 'STAFF_ACTIVATION' THEN "user_id" IS NOT NULL AND "code_hash" IS NOT NULL AND "ticket_hash" IS NULL
      WHEN 'STAFF_MFA_ENROLLMENT' THEN "user_id" IS NOT NULL AND "code_hash" IS NULL AND "ticket_hash" IS NOT NULL
    END
  );
