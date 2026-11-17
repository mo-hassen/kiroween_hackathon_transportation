-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('CUSTOMER', 'STAFF');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING_PHONE', 'ACTIVE', 'LOCKED', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "IdentityStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED', 'EXPIRED', 'REVERIFICATION_REQUIRED');

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('en', 'am');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS', 'WEB');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'STAFF', 'SYSTEM', 'PROVIDER');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT NOT NULL,
    "account_type" "AccountType" NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'PENDING_PHONE',
    "identity_status" "IdentityStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "display_name" TEXT,
    "preferred_locale" "Locale" NOT NULL DEFAULT 'en',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "mfa_secret_enc" BYTEA,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "installation_id" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "model" TEXT,
    "app_version" TEXT,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "refresh_token_family" UUID NOT NULL,
    "current_token_hash" TEXT NOT NULL,
    "previous_token_hash" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,
    "ip" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "seq" BIGSERIAL NOT NULL,
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "actor_type" "AuditActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "request_id" TEXT,
    "ip" INET,
    "user_agent" TEXT,
    "reason" TEXT,
    "changes" JSONB,
    "prev_hash" TEXT,
    "hash" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "principal" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" INTEGER,
    "response_body" JSONB,
    "locked_until" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "request_id" TEXT,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_e164_key" ON "users"("phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "devices_user_id_installation_id_key" ON "devices"("user_id", "installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_current_token_hash_key" ON "sessions"("current_token_hash");

-- CreateIndex
CREATE INDEX "sessions_active_user_idx" ON "sessions"("user_id") WHERE "revoked_at" IS NULL;

-- CreateIndex
CREATE INDEX "sessions_previous_token_hash_idx" ON "sessions"("previous_token_hash");

-- CreateIndex
CREATE INDEX "sessions_refresh_token_family_idx" ON "sessions"("refresh_token_family");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_id_key" ON "audit_logs"("id");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_occurred_at_idx" ON "audit_logs"("target_type", "target_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_occurred_at_idx" ON "audit_logs"("actor_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs"("occurred_at");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_scope_principal_key_key" ON "idempotency_records"("scope", "principal", "key");

-- CreateIndex
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events"("available_at") WHERE "processed_at" IS NULL;

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_idx" ON "outbox_events"("aggregate_type", "aggregate_id");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints (not expressible in schema.prisma).
-- See docs/architecture/03-database-schema.md. Covered by test/integration/db-constraints.spec.ts.
-- ---------------------------------------------------------------------------

-- users
ALTER TABLE "users"
  ADD CONSTRAINT "users_phone_e164_format_chk" CHECK ("phone_e164" ~ '^\+251[79][0-9]{8}$'),
  ADD CONSTRAINT "users_email_normalized_chk" CHECK (
    "email" IS NULL OR ("email" = lower("email") AND "email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
  ),
  ADD CONSTRAINT "users_password_hash_nonempty_chk" CHECK (length("password_hash") > 0),
  ADD CONSTRAINT "users_failed_login_count_chk" CHECK ("failed_login_count" >= 0),
  ADD CONSTRAINT "users_version_chk" CHECK ("version" >= 0),
  ADD CONSTRAINT "users_closed_consistency_chk" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL)),
  ADD CONSTRAINT "users_display_name_length_chk" CHECK ("display_name" IS NULL OR char_length("display_name") BETWEEN 1 AND 100);

-- devices
ALTER TABLE "devices"
  ADD CONSTRAINT "devices_installation_id_length_chk" CHECK (char_length("installation_id") BETWEEN 8 AND 128);

-- sessions
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_expiry_after_creation_chk" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "sessions_revocation_reason_chk" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL)),
  ADD CONSTRAINT "sessions_token_rotation_chk" CHECK ("previous_token_hash" IS DISTINCT FROM "current_token_hash");

-- idempotency_records
ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_key_format_chk" CHECK ("key" ~ '^[A-Za-z0-9_-]{8,128}$'),
  ADD CONSTRAINT "idempotency_response_status_chk" CHECK ("response_status" IS NULL OR "response_status" BETWEEN 100 AND 599),
  ADD CONSTRAINT "idempotency_completed_has_response_chk" CHECK ("status" <> 'COMPLETED' OR "response_status" IS NOT NULL),
  ADD CONSTRAINT "idempotency_expiry_chk" CHECK ("expires_at" > "created_at");

-- outbox_events
ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_attempts_chk" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "outbox_event_type_format_chk" CHECK ("event_type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');

-- audit_logs
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_action_format_chk" CHECK ("action" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  ADD CONSTRAINT "audit_hash_pair_chk" CHECK ("prev_hash" IS NULL OR "hash" IS NOT NULL);

-- audit_logs is append-only. The only permitted UPDATE is sealing a row once:
-- setting prev_hash/hash from NULL while every other column stays identical.
CREATE FUNCTION "audit_logs_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_logs is append-only (DELETE rejected)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."hash" IS NOT NULL
     OR NEW."hash" IS NULL
     OR (to_jsonb(NEW) - 'prev_hash' - 'hash') IS DISTINCT FROM (to_jsonb(OLD) - 'prev_hash' - 'hash') THEN
    RAISE EXCEPTION 'audit_logs is append-only (UPDATE rejected)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "audit_logs_guard"();

CREATE FUNCTION "audit_logs_reject_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (TRUNCATE rejected)' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "audit_logs_no_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_logs_reject_truncate"();
