
-- CreateTable
CREATE TABLE "owner_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "owner_type" "OwnerType" NOT NULL,
    "organization_name" TEXT,
    "tin_enc" BYTEA,
    "tin_hmac" TEXT,
    "tin_last4" TEXT,
    "verification_status" "OwnerVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "submitted_at" TIMESTAMPTZ(6),
    "claimed_by" UUID,
    "claim_expires_at" TIMESTAMPTZ(6),
    "first_approved_by" UUID,
    "first_approved_at" TIMESTAMPTZ(6),
    "first_approval_note" TEXT,
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_reason_code" "ReviewReasonCode",
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "owner_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owner_documents" (
    "owner_profile_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "purpose" "DocumentPurpose" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_documents_pkey" PRIMARY KEY ("owner_profile_id","purpose")
);

-- CreateTable
CREATE TABLE "owner_review_events" (
    "id" UUID NOT NULL,
    "owner_profile_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "from_status" "OwnerVerificationStatus",
    "to_status" "OwnerVerificationStatus" NOT NULL,
    "reason_code" "ReviewReasonCode",
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_review_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "owner_profiles_user_id_key" ON "owner_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "owner_profiles_tin_hmac_key" ON "owner_profiles"("tin_hmac");

-- CreateIndex
CREATE INDEX "owner_profiles_verification_status_submitted_at_idx" ON "owner_profiles"("verification_status", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "owner_documents_document_id_key" ON "owner_documents"("document_id");

-- CreateIndex
CREATE INDEX "owner_review_events_owner_profile_id_created_at_idx" ON "owner_review_events"("owner_profile_id", "created_at");

-- AddForeignKey
ALTER TABLE "owner_profiles" ADD CONSTRAINT "owner_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_profiles" ADD CONSTRAINT "owner_profiles_claimed_by_fkey" FOREIGN KEY ("claimed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_profiles" ADD CONSTRAINT "owner_profiles_first_approved_by_fkey" FOREIGN KEY ("first_approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_profiles" ADD CONSTRAINT "owner_profiles_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_profiles" ADD CONSTRAINT "owner_profiles_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_documents" ADD CONSTRAINT "owner_documents_owner_profile_id_fkey" FOREIGN KEY ("owner_profile_id") REFERENCES "owner_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_documents" ADD CONSTRAINT "owner_documents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_review_events" ADD CONSTRAINT "owner_review_events_owner_profile_id_fkey" FOREIGN KEY ("owner_profile_id") REFERENCES "owner_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_review_events" ADD CONSTRAINT "owner_review_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Hand-written constraints for Phase 6 (owner verification).
-- Covered by test/integration/owner-db-constraints.spec.ts. The transition table below must
-- match OWNER_TRANSITIONS in src/modules/owners/owner-rules.ts.
-- ---------------------------------------------------------------------------

-- Organization documents are images only (the PDF check is a heuristic, not a sanitizer).
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_owner_purpose_mime_chk" CHECK (
    "purpose" NOT IN ('OWNER_TIN', 'OWNER_BUSINESS_LICENSE', 'OWNER_REPRESENTATIVE_LETTER')
    OR ("declared_mime_type" IN ('image/jpeg', 'image/png', 'image/webp')
        AND ("mime_type" IS NULL OR "mime_type" IN ('image/jpeg', 'image/png', 'image/webp')))
  );

-- owner_profiles: type-dependent shape, formats, claim/approval/decision consistency and the
-- four-eyes rule for organizations (two different officers).
ALTER TABLE "owner_profiles"
  ADD CONSTRAINT "owner_profiles_type_shape_chk" CHECK (
    ("owner_type" = 'INDIVIDUAL' AND "organization_name" IS NULL AND "tin_enc" IS NULL
      AND "tin_hmac" IS NULL AND "tin_last4" IS NULL)
    OR ("owner_type" = 'ORGANIZATION' AND "organization_name" IS NOT NULL AND "tin_enc" IS NOT NULL
      AND "tin_hmac" IS NOT NULL AND "tin_last4" IS NOT NULL)
  ),
  ADD CONSTRAINT "owner_profiles_org_name_chk" CHECK (
    "organization_name" IS NULL
    OR (length("organization_name") BETWEEN 2 AND 200 AND "organization_name" !~ '[[:cntrl:]]')
  ),
  ADD CONSTRAINT "owner_profiles_tin_format_chk" CHECK (
    ("tin_hmac" IS NULL OR "tin_hmac" ~ '^[0-9a-f]{64}$')
    AND ("tin_last4" IS NULL OR "tin_last4" ~ '^[A-Z0-9]{1,4}$')
  ),
  ADD CONSTRAINT "owner_profiles_notes_chk" CHECK (
    ("decision_note" IS NULL OR length("decision_note") <= 1000)
    AND ("first_approval_note" IS NULL OR length("first_approval_note") <= 1000)
  ),
  ADD CONSTRAINT "owner_profiles_submitted_chk" CHECK (
    "verification_status" = 'UNVERIFIED' OR "submitted_at" IS NOT NULL
  ),
  -- A claim is review bookkeeping, only while the case is PENDING.
  ADD CONSTRAINT "owner_profiles_claim_shape_chk" CHECK (
    ("claimed_by" IS NULL) = ("claim_expires_at" IS NULL)
    AND ("claimed_by" IS NULL OR "verification_status" = 'PENDING')
  ),
  ADD CONSTRAINT "owner_profiles_first_approval_chk" CHECK (
    ("first_approved_by" IS NULL) = ("first_approved_at" IS NULL)
    AND ("first_approved_by" IS NULL OR (
      "owner_type" = 'ORGANIZATION' AND "verification_status" NOT IN ('UNVERIFIED', 'REJECTED')
    ))
    AND ("first_approval_note" IS NULL OR "first_approved_by" IS NOT NULL)
  ),
  ADD CONSTRAINT "owner_profiles_verified_chk" CHECK (
    ("verified_by" IS NULL) = ("verified_at" IS NULL)
    AND ("verification_status" NOT IN ('VERIFIED', 'SUSPENDED') OR "verified_by" IS NOT NULL)
  ),
  ADD CONSTRAINT "owner_profiles_four_eyes_chk" CHECK (
    "owner_type" <> 'ORGANIZATION' OR "verified_by" IS NULL
    OR ("first_approved_by" IS NOT NULL AND "first_approved_by" <> "verified_by")
  ),
  ADD CONSTRAINT "owner_profiles_decision_chk" CHECK (
    "verification_status" NOT IN ('REJECTED', 'SUSPENDED')
    OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "decision_reason_code" IS NOT NULL)
  );

-- An active VERIFICATION_OFFICER staff account (role not revoked, account ACTIVE).
CREATE FUNCTION "is_active_verification_officer"(candidate uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "staff_role_assignments" r
    JOIN "users" u ON u."id" = r."user_id"
    WHERE r."user_id" = candidate AND r."role" = 'VERIFICATION_OFFICER' AND r."revoked_at" IS NULL
      AND u."account_type" = 'STAFF' AND u."status" = 'ACTIVE'
  );
$$;

-- Owner verification transitions (02 §3.4, Phase 6). Reviewers are active verification
-- officers and never the owner; owner details are frozen while a case is under review or
-- verified; the owner type can only change before a first submission or after a rejection.
CREATE FUNCTION "owner_profiles_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."user_id" AND "account_type" = 'CUSTOMER') THEN
      RAISE EXCEPTION 'owner profiles belong to customer accounts' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."verification_status" <> 'UNVERIFIED' OR NEW."claimed_by" IS NOT NULL
       OR NEW."first_approved_by" IS NOT NULL OR NEW."verified_by" IS NOT NULL OR NEW."decided_by" IS NOT NULL THEN
      RAISE EXCEPTION 'owner profiles start UNVERIFIED without review data' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'owner_profiles identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."verification_status" IS DISTINCT FROM OLD."verification_status" AND NOT (
    (OLD."verification_status" = 'UNVERIFIED' AND NEW."verification_status" = 'PENDING') OR
    (OLD."verification_status" = 'PENDING' AND NEW."verification_status" IN ('VERIFIED', 'REJECTED')) OR
    (OLD."verification_status" = 'REJECTED' AND NEW."verification_status" = 'PENDING') OR
    (OLD."verification_status" = 'VERIFIED' AND NEW."verification_status" IN ('SUSPENDED', 'EXPIRED', 'REVERIFICATION_REQUIRED')) OR
    (OLD."verification_status" = 'SUSPENDED' AND NEW."verification_status" IN ('VERIFIED', 'REVERIFICATION_REQUIRED')) OR
    (OLD."verification_status" = 'EXPIRED' AND NEW."verification_status" = 'PENDING') OR
    (OLD."verification_status" = 'REVERIFICATION_REQUIRED' AND NEW."verification_status" = 'PENDING')
  ) THEN
    RAISE EXCEPTION 'owner verification transition % -> % is not allowed', OLD."verification_status", NEW."verification_status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."owner_type" IS DISTINCT FROM OLD."owner_type"
      OR NEW."organization_name" IS DISTINCT FROM OLD."organization_name"
      OR NEW."tin_enc" IS DISTINCT FROM OLD."tin_enc"
      OR NEW."tin_hmac" IS DISTINCT FROM OLD."tin_hmac"
      OR NEW."tin_last4" IS DISTINCT FROM OLD."tin_last4")
     AND OLD."verification_status" NOT IN ('UNVERIFIED', 'REJECTED', 'EXPIRED', 'REVERIFICATION_REQUIRED') THEN
    RAISE EXCEPTION 'owner details cannot change while a case is pending or verified' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."owner_type" IS DISTINCT FROM OLD."owner_type" AND OLD."verification_status" NOT IN ('UNVERIFIED', 'REJECTED') THEN
    RAISE EXCEPTION 'the owner type can only change before submission or after a rejection' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."claimed_by" IS NOT NULL AND NEW."claimed_by" IS DISTINCT FROM OLD."claimed_by"
     AND (NEW."claimed_by" = NEW."user_id" OR NOT "is_active_verification_officer"(NEW."claimed_by")) THEN
    RAISE EXCEPTION 'only a verification officer other than the owner can claim a case' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."first_approved_by" IS NOT NULL AND NEW."first_approved_by" IS DISTINCT FROM OLD."first_approved_by"
     AND (NEW."first_approved_by" = NEW."user_id" OR NOT "is_active_verification_officer"(NEW."first_approved_by")
          OR NEW."verification_status" <> 'PENDING') THEN
    RAISE EXCEPTION 'only a verification officer other than the owner can record a first approval' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."verified_by" IS NOT NULL AND NEW."verified_by" IS DISTINCT FROM OLD."verified_by"
     AND (NEW."verified_by" = NEW."user_id" OR NOT "is_active_verification_officer"(NEW."verified_by")) THEN
    RAISE EXCEPTION 'only a verification officer other than the owner can verify an owner' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decided_by" IS NOT NULL AND NEW."decided_by" IS DISTINCT FROM OLD."decided_by"
     AND (NEW."decided_by" = NEW."user_id" OR NOT "is_active_verification_officer"(NEW."decided_by")) THEN
    RAISE EXCEPTION 'only a verification officer other than the owner can decide a case' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "owner_profiles_guard"
  BEFORE INSERT OR UPDATE ON "owner_profiles"
  FOR EACH ROW EXECUTE FUNCTION "owner_profiles_guard"();

-- owner_documents: organization documents only; the document is the owner's own with the
-- matching purpose; links change only while the profile can be edited.
ALTER TABLE "owner_documents"
  ADD CONSTRAINT "owner_documents_purpose_chk" CHECK (
    "purpose" IN ('OWNER_TIN', 'OWNER_BUSINESS_LICENSE', 'OWNER_REPRESENTATIVE_LETTER')
  );

CREATE FUNCTION "owner_documents_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  profile_id uuid := COALESCE(NEW."owner_profile_id", OLD."owner_profile_id");
BEGIN
  IF EXISTS (
    SELECT 1 FROM "owner_profiles" p WHERE p."id" = profile_id
      AND p."verification_status" NOT IN ('UNVERIFIED', 'REJECTED', 'EXPIRED', 'REVERIFICATION_REQUIRED')
  ) THEN
    RAISE EXCEPTION 'owner documents can only change while the profile can be edited' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "documents" d
    JOIN "owner_profiles" p ON p."id" = NEW."owner_profile_id"
    WHERE d."id" = NEW."document_id" AND d."owner_user_id" = p."user_id"
      AND d."purpose" = NEW."purpose" AND p."owner_type" = 'ORGANIZATION'
  ) THEN
    RAISE EXCEPTION 'owner documents must be the organization owner''s own, with the matching purpose' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "owner_documents_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "owner_documents"
  FOR EACH ROW EXECUTE FUNCTION "owner_documents_guard"();

-- owner_review_events: append-only history.
ALTER TABLE "owner_review_events"
  ADD CONSTRAINT "owner_review_events_action_chk" CHECK ("action" ~ '^[a-z_]{3,40}$'),
  ADD CONSTRAINT "owner_review_events_note_chk" CHECK ("note" IS NULL OR length("note") <= 1000);

CREATE FUNCTION "owner_review_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'owner_review_events is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "owner_review_events_append_only"
  BEFORE UPDATE OR DELETE ON "owner_review_events"
  FOR EACH ROW EXECUTE FUNCTION "owner_review_events_append_only"();
