-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "owner_profile_id" UUID NOT NULL,
    "vehicle_type" "VehicleType" NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" SMALLINT NOT NULL,
    "color" TEXT,
    "seats" SMALLINT NOT NULL,
    "transmission" "VehicleTransmission" NOT NULL,
    "fuel_type" "VehicleFuelType" NOT NULL,
    "plate_region" TEXT NOT NULL,
    "plate_code" TEXT NOT NULL,
    "plate_number" TEXT NOT NULL,
    "plate_normalized" TEXT NOT NULL,
    "plate_key" TEXT,
    "vin_enc" BYTEA,
    "vin_hmac" TEXT,
    "vin_key" TEXT,
    "vin_last4" TEXT,
    "engine_number_enc" BYTEA,
    "status" "VehicleStatus" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMPTZ(6),
    "claimed_by" UUID,
    "claim_expires_at" TIMESTAMPTZ(6),
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_reason_code" "ReviewReasonCode",
    "decision_note" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_documents" (
    "vehicle_id" UUID NOT NULL,
    "slot" "VehicleEvidenceSlot" NOT NULL,
    "document_id" UUID NOT NULL,
    "purpose" "DocumentPurpose" NOT NULL,
    "expires_on" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_documents_pkey" PRIMARY KEY ("vehicle_id","slot")
);

-- CreateTable
CREATE TABLE "vehicle_review_events" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "from_status" "VehicleStatus",
    "to_status" "VehicleStatus" NOT NULL,
    "reason_code" "ReviewReasonCode",
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_review_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_plate_key_key" ON "vehicles"("plate_key");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vin_key_key" ON "vehicles"("vin_key");

-- CreateIndex
CREATE INDEX "vehicles_owner_profile_id_created_at_idx" ON "vehicles"("owner_profile_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "vehicles_status_submitted_at_idx" ON "vehicles"("status", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_documents_document_id_key" ON "vehicle_documents"("document_id");

-- CreateIndex
CREATE INDEX "vehicle_review_events_vehicle_id_created_at_idx" ON "vehicle_review_events"("vehicle_id", "created_at");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_owner_profile_id_fkey" FOREIGN KEY ("owner_profile_id") REFERENCES "owner_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_claimed_by_fkey" FOREIGN KEY ("claimed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_review_events" ADD CONSTRAINT "vehicle_review_events_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_review_events" ADD CONSTRAINT "vehicle_review_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written constraints for Phase 7 (vehicle registration and verification).
-- Covered by test/integration/vehicle-db-constraints.spec.ts. The transition table below must
-- match VEHICLE_TRANSITIONS in src/modules/vehicles/vehicle-rules.ts.
-- ---------------------------------------------------------------------------

-- Vehicle evidence is images only (the PDF check is a heuristic, not a sanitizer).
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_vehicle_purpose_mime_chk" CHECK (
    "purpose" NOT IN ('VEHICLE_REGISTRATION', 'VEHICLE_OWNERSHIP', 'VEHICLE_INSURANCE', 'VEHICLE_INSPECTION', 'VEHICLE_PHOTO')
    OR ("declared_mime_type" IN ('image/jpeg', 'image/png', 'image/webp')
        AND ("mime_type" IS NULL OR "mime_type" IN ('image/jpeg', 'image/png', 'image/webp')))
  );

ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_text_chk" CHECK (
    length("make") BETWEEN 1 AND 60 AND "make" !~ '[[:cntrl:]]'
    AND length("model") BETWEEN 1 AND 60 AND "model" !~ '[[:cntrl:]]'
    AND ("color" IS NULL OR (length("color") BETWEEN 1 AND 30 AND "color" !~ '[[:cntrl:]]'))
  ),
  ADD CONSTRAINT "vehicles_range_chk" CHECK (
    "year" BETWEEN 1980 AND 2100 AND "seats" BETWEEN 1 AND 60
  ),
  ADD CONSTRAINT "vehicles_plate_chk" CHECK (
    length("plate_region") BETWEEN 1 AND 12 AND "plate_region" !~ '[[:cntrl:]]'
    AND length("plate_code") BETWEEN 1 AND 12 AND "plate_code" !~ '[[:cntrl:]]'
    AND length("plate_number") BETWEEN 1 AND 12 AND "plate_number" !~ '[[:cntrl:]]'
    AND length("plate_normalized") BETWEEN 3 AND 36 AND "plate_normalized" !~ '[[:cntrl:][:space:]]'
  ),
  -- The unique-key columns hold the value while the vehicle is active and are NULL once archived.
  ADD CONSTRAINT "vehicles_plate_key_chk" CHECK (
    ("archived_at" IS NULL AND "plate_key" = "plate_normalized")
    OR ("archived_at" IS NOT NULL AND "plate_key" IS NULL)
  ),
  ADD CONSTRAINT "vehicles_vin_shape_chk" CHECK (
    ("vin_enc" IS NULL) = ("vin_hmac" IS NULL) AND ("vin_enc" IS NULL) = ("vin_last4" IS NULL)
    AND ("vin_hmac" IS NULL OR "vin_hmac" ~ '^[0-9a-f]{64}$')
    AND ("vin_last4" IS NULL OR "vin_last4" ~ '^[A-Z0-9]{1,4}$')
  ),
  ADD CONSTRAINT "vehicles_vin_key_chk" CHECK (
    ("archived_at" IS NULL AND "vin_key" IS NOT DISTINCT FROM "vin_hmac")
    OR ("archived_at" IS NOT NULL AND "vin_key" IS NULL)
  ),
  ADD CONSTRAINT "vehicles_archived_chk" CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL)),
  ADD CONSTRAINT "vehicles_note_chk" CHECK ("decision_note" IS NULL OR length("decision_note") <= 1000),
  ADD CONSTRAINT "vehicles_submitted_chk" CHECK (
    "status" IN ('DRAFT', 'ARCHIVED') OR "submitted_at" IS NOT NULL
  ),
  -- A claim is review bookkeeping, only while the case is UNDER_REVIEW.
  ADD CONSTRAINT "vehicles_claim_shape_chk" CHECK (
    ("claimed_by" IS NULL) = ("claim_expires_at" IS NULL)
    AND ("claimed_by" IS NULL OR "status" = 'UNDER_REVIEW')
  ),
  ADD CONSTRAINT "vehicles_decision_chk" CHECK (
    ("decided_by" IS NULL) = ("decided_at" IS NULL)
    AND ("status" NOT IN ('APPROVED', 'REJECTED', 'SUSPENDED') OR "decided_by" IS NOT NULL)
    AND ("status" NOT IN ('REJECTED', 'SUSPENDED') OR "decision_reason_code" IS NOT NULL)
  );

-- Vehicle transitions (02 §3.3, Phase 7). Reviewers are active verification officers and never
-- the vehicle's owner; a vehicle can only be created for a VERIFIED owner of an ACTIVE account;
-- the owner never changes; material details change only while the vehicle can be edited (or in
-- the same statement that sends an approved vehicle back to SUBMITTED); a suspension for fraud
-- is lifted by a different officer than the one who suspended it.
CREATE FUNCTION "vehicles_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_user uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "owner_profiles" p JOIN "users" u ON u."id" = p."user_id"
      WHERE p."id" = NEW."owner_profile_id" AND p."verification_status" = 'VERIFIED' AND u."status" = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'vehicles can only be registered by a verified owner' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'DRAFT' OR NEW."claimed_by" IS NOT NULL OR NEW."decided_by" IS NOT NULL
       OR NEW."submitted_at" IS NOT NULL OR NEW."archived_at" IS NOT NULL THEN
      RAISE EXCEPTION 'vehicles start as DRAFT without review data' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."owner_profile_id" IS DISTINCT FROM OLD."owner_profile_id" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'vehicle ownership cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "user_id" INTO owner_user FROM "owner_profiles" WHERE "id" = NEW."owner_profile_id";

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('SUBMITTED', 'ARCHIVED')) OR
    (OLD."status" = 'SUBMITTED' AND NEW."status" = 'UNDER_REVIEW') OR
    (OLD."status" = 'UNDER_REVIEW' AND NEW."status" IN ('SUBMITTED', 'APPROVED', 'REJECTED')) OR
    (OLD."status" = 'REJECTED' AND NEW."status" IN ('DRAFT', 'ARCHIVED')) OR
    (OLD."status" = 'APPROVED' AND NEW."status" IN ('SUBMITTED', 'EXPIRED', 'SUSPENDED', 'ARCHIVED')) OR
    (OLD."status" = 'SUSPENDED' AND NEW."status" IN ('APPROVED', 'EXPIRED')) OR
    (OLD."status" = 'EXPIRED' AND NEW."status" IN ('DRAFT', 'ARCHIVED'))
  ) THEN
    RAISE EXCEPTION 'vehicle status transition % -> % is not allowed', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW."vehicle_type" IS DISTINCT FROM OLD."vehicle_type"
      OR NEW."make" IS DISTINCT FROM OLD."make"
      OR NEW."model" IS DISTINCT FROM OLD."model"
      OR NEW."year" IS DISTINCT FROM OLD."year"
      OR NEW."plate_normalized" IS DISTINCT FROM OLD."plate_normalized"
      OR NEW."vin_hmac" IS DISTINCT FROM OLD."vin_hmac"
      OR NEW."engine_number_enc" IS DISTINCT FROM OLD."engine_number_enc")
     AND NOT (OLD."status" IN ('DRAFT', 'REJECTED', 'EXPIRED')
              OR (OLD."status" = 'APPROVED' AND NEW."status" = 'SUBMITTED')) THEN
    RAISE EXCEPTION 'vehicle details cannot change while the vehicle is under review, approved or suspended'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."claimed_by" IS NOT NULL AND NEW."claimed_by" IS DISTINCT FROM OLD."claimed_by"
     AND (NEW."claimed_by" = owner_user OR NOT "is_active_verification_officer"(NEW."claimed_by")) THEN
    RAISE EXCEPTION 'only a verification officer other than the owner can claim a vehicle' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decided_by" IS NOT NULL AND NEW."decided_by" IS DISTINCT FROM OLD."decided_by"
     AND (NEW."decided_by" = owner_user OR NOT "is_active_verification_officer"(NEW."decided_by")) THEN
    RAISE EXCEPTION 'only a verification officer other than the owner can decide a vehicle' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'SUSPENDED' AND NEW."status" = 'APPROVED' AND OLD."decision_reason_code" = 'SUSPECTED_FRAUD'
     AND NEW."decided_by" IS NOT DISTINCT FROM OLD."decided_by" THEN
    RAISE EXCEPTION 'a fraud suspension must be lifted by a different officer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "vehicles_guard"
  BEFORE INSERT OR UPDATE ON "vehicles"
  FOR EACH ROW EXECUTE FUNCTION "vehicles_guard"();

-- vehicle_documents: slot and purpose agree, only insurance and inspection carry an expiry, the
-- document is the owner's own with the matching purpose, and links change only while the
-- vehicle can be edited (an approved vehicle's change is followed by a return to SUBMITTED in
-- the same transaction, enforced by the service).
ALTER TABLE "vehicle_documents"
  ADD CONSTRAINT "vehicle_documents_slot_purpose_chk" CHECK (
    ("slot" = 'REGISTRATION' AND "purpose" = 'VEHICLE_REGISTRATION')
    OR ("slot" = 'OWNERSHIP' AND "purpose" = 'VEHICLE_OWNERSHIP')
    OR ("slot" = 'INSURANCE' AND "purpose" = 'VEHICLE_INSURANCE')
    OR ("slot" = 'INSPECTION' AND "purpose" = 'VEHICLE_INSPECTION')
    OR ("slot" IN ('PHOTO_FRONT', 'PHOTO_BACK', 'PHOTO_LEFT', 'PHOTO_RIGHT', 'PHOTO_PLATE', 'PHOTO_INTERIOR')
        AND "purpose" = 'VEHICLE_PHOTO')
  ),
  ADD CONSTRAINT "vehicle_documents_expiry_chk" CHECK (
    ("slot" IN ('INSURANCE', 'INSPECTION')) = ("expires_on" IS NOT NULL)
  );

CREATE FUNCTION "vehicle_documents_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  vehicle_id uuid := COALESCE(NEW."vehicle_id", OLD."vehicle_id");
BEGIN
  IF EXISTS (
    SELECT 1 FROM "vehicles" v WHERE v."id" = vehicle_id
      AND v."status" NOT IN ('DRAFT', 'REJECTED', 'EXPIRED', 'APPROVED')
  ) THEN
    RAISE EXCEPTION 'vehicle evidence can only change while the vehicle can be edited' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "documents" d
    JOIN "vehicles" v ON v."id" = NEW."vehicle_id"
    JOIN "owner_profiles" p ON p."id" = v."owner_profile_id"
    WHERE d."id" = NEW."document_id" AND d."owner_user_id" = p."user_id" AND d."purpose" = NEW."purpose"
  ) THEN
    RAISE EXCEPTION 'vehicle evidence must be the owner''s own document with the matching purpose' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "vehicle_documents_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "vehicle_documents"
  FOR EACH ROW EXECUTE FUNCTION "vehicle_documents_guard"();

-- vehicle_review_events: append-only history.
ALTER TABLE "vehicle_review_events"
  ADD CONSTRAINT "vehicle_review_events_action_chk" CHECK ("action" ~ '^[a-z_]{3,40}$'),
  ADD CONSTRAINT "vehicle_review_events_note_chk" CHECK ("note" IS NULL OR length("note") <= 1000);

CREATE FUNCTION "vehicle_review_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vehicle_review_events is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "vehicle_review_events_append_only"
  BEFORE UPDATE OR DELETE ON "vehicle_review_events"
  FOR EACH ROW EXECUTE FUNCTION "vehicle_review_events_append_only"();
