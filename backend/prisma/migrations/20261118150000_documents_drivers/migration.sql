-- CreateEnum
CREATE TYPE "DocumentPurpose" AS ENUM ('DRIVER_LICENSE_FRONT', 'DRIVER_LICENSE_BACK');

-- CreateEnum
CREATE TYPE "DocumentUploadStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING', 'AVAILABLE', 'INVALID', 'INFECTED', 'DELETED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "DriverEligibility" AS ENUM ('INELIGIBLE', 'ELIGIBLE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AddisSubCity" AS ENUM ('ADDIS_KETEMA', 'AKAKY_KALITI', 'ARADA', 'BOLE', 'GULLELE', 'KIRKOS', 'KOLFE_KERANIO', 'LIDETA', 'NIFAS_SILK_LAFTO', 'YEKA', 'LEMI_KURA');

-- CreateEnum
CREATE TYPE "ReviewReasonCode" AS ENUM ('BLURRY', 'MISMATCH_NAME', 'EXPIRED', 'NOT_OWNER', 'INCOMPLETE', 'INVALID_LICENSE_DETAILS', 'SUSPECTED_FRAUD', 'SAFETY_CONCERN', 'OTHER');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "purpose" "DocumentPurpose" NOT NULL,
    "upload_key" TEXT NOT NULL,
    "storage_key" TEXT,
    "declared_mime_type" TEXT NOT NULL,
    "declared_size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "stored_sha256" TEXT,
    "upload_status" "DocumentUploadStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "failure_code" TEXT,
    "upload_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "processing_at" TIMESTAMPTZ(6),
    "processed_at" TIMESTAMPTZ(6),
    "scan_engine" TEXT,
    "expires_on" DATE,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "eligibility_status" "DriverEligibility" NOT NULL DEFAULT 'INELIGIBLE',
    "years_licensed" SMALLINT,
    "bio" TEXT,
    "home_sub_city" "AddisSubCity",
    "suspended_reason" "ReviewReasonCode",
    "suspended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "driver_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_licenses" (
    "id" UUID NOT NULL,
    "driver_profile_id" UUID NOT NULL,
    "license_number_enc" BYTEA NOT NULL,
    "license_number_hmac" TEXT NOT NULL,
    "license_number_last4" TEXT NOT NULL,
    "categories" TEXT[],
    "issued_on" DATE NOT NULL,
    "expires_on" DATE NOT NULL,
    "issuing_authority" TEXT NOT NULL,
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMPTZ(6),
    "claimed_by" UUID,
    "claim_expires_at" TIMESTAMPTZ(6),
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_reason_code" "ReviewReasonCode",
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "driver_licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_license_documents" (
    "driver_license_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "purpose" "DocumentPurpose" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_license_documents_pkey" PRIMARY KEY ("driver_license_id","purpose")
);

-- CreateTable
CREATE TABLE "driver_review_events" (
    "id" UUID NOT NULL,
    "driver_license_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "from_status" "ReviewStatus",
    "to_status" "ReviewStatus" NOT NULL,
    "reason_code" "ReviewReasonCode",
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_review_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "title_key" TEXT NOT NULL,
    "body_key" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "deep_link" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_upload_key_key" ON "documents"("upload_key");

-- CreateIndex
CREATE UNIQUE INDEX "documents_storage_key_key" ON "documents"("storage_key");

-- CreateIndex
CREATE INDEX "documents_owner_user_id_created_at_idx" ON "documents"("owner_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "documents_unfinished_idx" ON "documents"("upload_expires_at") WHERE "upload_status" IN ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING');

-- CreateIndex
CREATE INDEX "documents_approved_expiry_idx" ON "documents"("expires_on") WHERE "review_status" = 'APPROVED';

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_user_id_key" ON "driver_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_licenses_driver_profile_id_key" ON "driver_licenses"("driver_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_licenses_license_number_hmac_key" ON "driver_licenses"("license_number_hmac");

-- CreateIndex
CREATE INDEX "driver_licenses_review_status_submitted_at_idx" ON "driver_licenses"("review_status", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "driver_license_documents_document_id_key" ON "driver_license_documents"("document_id");

-- CreateIndex
CREATE INDEX "driver_review_events_driver_license_id_created_at_idx" ON "driver_review_events"("driver_license_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_created_at_idx" ON "notifications"("recipient_user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_recipient_user_id_dedupe_key_key" ON "notifications"("recipient_user_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_licenses" ADD CONSTRAINT "driver_licenses_driver_profile_id_fkey" FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_licenses" ADD CONSTRAINT "driver_licenses_claimed_by_fkey" FOREIGN KEY ("claimed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_licenses" ADD CONSTRAINT "driver_licenses_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_license_documents" ADD CONSTRAINT "driver_license_documents_driver_license_id_fkey" FOREIGN KEY ("driver_license_id") REFERENCES "driver_licenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_license_documents" ADD CONSTRAINT "driver_license_documents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_review_events" ADD CONSTRAINT "driver_review_events_driver_license_id_fkey" FOREIGN KEY ("driver_license_id") REFERENCES "driver_licenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_review_events" ADD CONSTRAINT "driver_review_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written constraints for Phase 5 (documents, driver verification).
-- Covered by test/integration/driver-db-constraints.spec.ts. The review transition table
-- below must match src/modules/drivers/driver-review-state.ts.
-- ---------------------------------------------------------------------------

-- documents: server-generated keys, hex digests, bounded sizes, consistent processing data.
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_upload_key_format_chk" CHECK ("upload_key" ~ '^incoming/[0-9a-f-]{36}$'),
  ADD CONSTRAINT "documents_storage_key_format_chk" CHECK ("storage_key" IS NULL OR "storage_key" ~ '^documents/[0-9]{4}/[0-9]{2}/[0-9a-f-]{36}$'),
  ADD CONSTRAINT "documents_sha256_format_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$' AND ("stored_sha256" IS NULL OR "stored_sha256" ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT "documents_mime_chk" CHECK (
    "declared_mime_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
    AND ("mime_type" IS NULL OR "mime_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'))
  ),
  ADD CONSTRAINT "documents_size_chk" CHECK (
    "declared_size_bytes" BETWEEN 1 AND 10485760 AND ("size_bytes" IS NULL OR "size_bytes" BETWEEN 1 AND 10485760)
  ),
  ADD CONSTRAINT "documents_failure_code_format_chk" CHECK ("failure_code" IS NULL OR "failure_code" ~ '^[A-Z_]{3,40}$'),
  ADD CONSTRAINT "documents_available_shape_chk" CHECK (
    "upload_status" <> 'AVAILABLE' OR (
      "storage_key" IS NOT NULL AND "mime_type" IS NOT NULL AND "size_bytes" IS NOT NULL
      AND "stored_sha256" IS NOT NULL AND "processed_at" IS NOT NULL AND "scan_engine" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "documents_storage_only_if_available_chk" CHECK ("storage_key" IS NULL OR "upload_status" IN ('AVAILABLE', 'DELETED')),
  ADD CONSTRAINT "documents_failed_has_code_chk" CHECK ("upload_status" NOT IN ('INVALID', 'INFECTED') OR "failure_code" IS NOT NULL),
  ADD CONSTRAINT "documents_review_needs_available_chk" CHECK ("review_status" = 'DRAFT' OR "upload_status" IN ('AVAILABLE', 'DELETED'));

-- Documents belong to customer accounts; owner, purpose, keys and declared facts never change;
-- terminal upload statuses stay terminal.
CREATE FUNCTION "documents_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."upload_status" <> 'PENDING_UPLOAD' OR NEW."review_status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'documents start PENDING_UPLOAD/DRAFT' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."owner_user_id" AND "account_type" = 'CUSTOMER') THEN
      RAISE EXCEPTION 'documents belong to customer accounts' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."upload_key" IS DISTINCT FROM OLD."upload_key"
     OR NEW."declared_mime_type" IS DISTINCT FROM OLD."declared_mime_type"
     OR NEW."declared_size_bytes" IS DISTINCT FROM OLD."declared_size_bytes"
     OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (OLD."storage_key" IS NOT NULL AND NEW."storage_key" IS DISTINCT FROM OLD."storage_key") THEN
    RAISE EXCEPTION 'document identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."upload_status" IN ('INVALID', 'INFECTED', 'DELETED') AND NEW."upload_status" IS DISTINCT FROM OLD."upload_status" THEN
    RAISE EXCEPTION 'document upload status % is terminal', OLD."upload_status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."upload_status" = 'AVAILABLE' AND NEW."upload_status" NOT IN ('AVAILABLE', 'DELETED') THEN
    RAISE EXCEPTION 'an available document can only be deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "documents_guard"
  BEFORE INSERT OR UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION "documents_guard"();

-- driver_profiles: customers only; bounded fields; suspension data consistent.
ALTER TABLE "driver_profiles"
  ADD CONSTRAINT "driver_profiles_years_chk" CHECK ("years_licensed" IS NULL OR "years_licensed" BETWEEN 0 AND 60),
  ADD CONSTRAINT "driver_profiles_bio_chk" CHECK ("bio" IS NULL OR length("bio") <= 500),
  ADD CONSTRAINT "driver_profiles_suspension_chk" CHECK (
    ("suspended_at" IS NULL) = ("suspended_reason" IS NULL)
    AND (("eligibility_status" = 'SUSPENDED') = ("suspended_at" IS NOT NULL))
  );

CREATE FUNCTION "driver_profiles_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."user_id" AND "account_type" = 'CUSTOMER') THEN
    RAISE EXCEPTION 'driver profiles belong to customer accounts' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."user_id" IS DISTINCT FROM OLD."user_id" THEN
    RAISE EXCEPTION 'driver_profiles.user_id is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "driver_profiles_guard"
  BEFORE INSERT OR UPDATE ON "driver_profiles"
  FOR EACH ROW EXECUTE FUNCTION "driver_profiles_guard"();

-- driver_licenses: dates, formats, claim and decision shape.
ALTER TABLE "driver_licenses"
  ADD CONSTRAINT "driver_licenses_dates_chk" CHECK ("expires_on" > "issued_on"),
  ADD CONSTRAINT "driver_licenses_hmac_format_chk" CHECK ("license_number_hmac" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "driver_licenses_last4_chk" CHECK ("license_number_last4" ~ '^[A-Z0-9]{1,4}$'),
  ADD CONSTRAINT "driver_licenses_categories_chk" CHECK (
    cardinality("categories") BETWEEN 1 AND 10
    AND array_to_string("categories", ',') ~ '^[A-Z0-9][A-Z0-9-]{0,9}(,[A-Z0-9][A-Z0-9-]{0,9})*$'
  ),
  ADD CONSTRAINT "driver_licenses_authority_chk" CHECK (length("issuing_authority") BETWEEN 2 AND 120),
  ADD CONSTRAINT "driver_licenses_note_chk" CHECK ("decision_note" IS NULL OR length("decision_note") <= 1000),
  ADD CONSTRAINT "driver_licenses_claim_shape_chk" CHECK (
    ("claimed_by" IS NULL) = ("claim_expires_at" IS NULL)
    AND ("review_status" = 'UNDER_REVIEW') = ("claimed_by" IS NOT NULL)
  ),
  ADD CONSTRAINT "driver_licenses_submitted_chk" CHECK ("review_status" IN ('DRAFT') OR "submitted_at" IS NOT NULL),
  ADD CONSTRAINT "driver_licenses_decision_chk" CHECK (
    "review_status" NOT IN ('APPROVED', 'REJECTED', 'SUSPENDED') OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "driver_licenses_reason_chk" CHECK (
    "review_status" NOT IN ('REJECTED', 'SUSPENDED') OR "decision_reason_code" IS NOT NULL
  );

-- Review transitions (02 §3.3, Phase 5); a reviewer is staff with an active
-- VERIFICATION_OFFICER role and never the driver; details are frozen outside DRAFT.
CREATE FUNCTION "driver_licenses_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  driver_user uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."review_status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'driver licences start DRAFT' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."driver_profile_id" IS DISTINCT FROM OLD."driver_profile_id" THEN
    RAISE EXCEPTION 'driver_licenses.driver_profile_id is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."review_status" IS DISTINCT FROM OLD."review_status" AND NOT (
    (OLD."review_status" = 'DRAFT' AND NEW."review_status" = 'SUBMITTED') OR
    (OLD."review_status" = 'SUBMITTED' AND NEW."review_status" = 'UNDER_REVIEW') OR
    (OLD."review_status" = 'UNDER_REVIEW' AND NEW."review_status" IN ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED')) OR
    (OLD."review_status" = 'REJECTED' AND NEW."review_status" = 'DRAFT') OR
    (OLD."review_status" = 'APPROVED' AND NEW."review_status" IN ('EXPIRED', 'SUSPENDED')) OR
    (OLD."review_status" = 'SUSPENDED' AND NEW."review_status" IN ('APPROVED', 'EXPIRED')) OR
    (OLD."review_status" = 'EXPIRED' AND NEW."review_status" = 'DRAFT')
  ) THEN
    RAISE EXCEPTION 'driver review transition % -> % is not allowed', OLD."review_status", NEW."review_status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."review_status" <> 'DRAFT' AND (
    NEW."license_number_hmac" IS DISTINCT FROM OLD."license_number_hmac"
    OR NEW."license_number_enc" IS DISTINCT FROM OLD."license_number_enc"
    OR NEW."categories" IS DISTINCT FROM OLD."categories"
    OR NEW."issued_on" IS DISTINCT FROM OLD."issued_on"
    OR NEW."expires_on" IS DISTINCT FROM OLD."expires_on"
    OR NEW."issuing_authority" IS DISTINCT FROM OLD."issuing_authority"
  ) THEN
    RAISE EXCEPTION 'licence details can only change in DRAFT' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "user_id" INTO driver_user FROM "driver_profiles" WHERE "id" = NEW."driver_profile_id";
  IF NEW."claimed_by" IS NOT NULL AND NEW."claimed_by" IS DISTINCT FROM OLD."claimed_by" AND (
    NEW."claimed_by" = driver_user OR NOT EXISTS (
      SELECT 1 FROM "staff_role_assignments"
      WHERE "user_id" = NEW."claimed_by" AND "role" = 'VERIFICATION_OFFICER' AND "revoked_at" IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'only a verification officer other than the driver can claim a case' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decided_by" IS NOT NULL AND NEW."decided_by" IS DISTINCT FROM OLD."decided_by" AND (
    NEW."decided_by" = driver_user OR NOT EXISTS (
      SELECT 1 FROM "staff_role_assignments"
      WHERE "user_id" = NEW."decided_by" AND "role" = 'VERIFICATION_OFFICER' AND "revoked_at" IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'only a verification officer other than the driver can decide a case' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "driver_licenses_guard"
  BEFORE INSERT OR UPDATE ON "driver_licenses"
  FOR EACH ROW EXECUTE FUNCTION "driver_licenses_guard"();

-- driver_license_documents: the document is the driver's own and has the matching purpose.
CREATE FUNCTION "driver_license_documents_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "documents" d
    JOIN "driver_licenses" l ON l."id" = NEW."driver_license_id"
    JOIN "driver_profiles" p ON p."id" = l."driver_profile_id"
    WHERE d."id" = NEW."document_id" AND d."owner_user_id" = p."user_id" AND d."purpose" = NEW."purpose"
  ) THEN
    RAISE EXCEPTION 'licence documents must be the driver''s own, with the matching purpose' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "driver_license_documents_guard"
  BEFORE INSERT OR UPDATE ON "driver_license_documents"
  FOR EACH ROW EXECUTE FUNCTION "driver_license_documents_guard"();

ALTER TABLE "driver_license_documents"
  ADD CONSTRAINT "driver_license_documents_purpose_chk" CHECK ("purpose" IN ('DRIVER_LICENSE_FRONT', 'DRIVER_LICENSE_BACK'));

-- driver_review_events: append-only history.
ALTER TABLE "driver_review_events"
  ADD CONSTRAINT "driver_review_events_action_chk" CHECK ("action" ~ '^[a-z_]{3,40}$'),
  ADD CONSTRAINT "driver_review_events_note_chk" CHECK ("note" IS NULL OR length("note") <= 1000);

CREATE FUNCTION "driver_review_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'driver_review_events is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "driver_review_events_append_only"
  BEFORE UPDATE OR DELETE ON "driver_review_events"
  FOR EACH ROW EXECUTE FUNCTION "driver_review_events_append_only"();

-- notifications: template keys only (no free text from users).
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_keys_chk" CHECK (
    "title_key" ~ '^[a-z][a-zA-Z0-9_.]{2,80}$' AND "body_key" ~ '^[a-z][a-zA-Z0-9_.]{2,80}$'
  );
