-- Phase 4 security fix: same-device confirmation of identity results.
--
-- The provider callback no longer links an identity by itself. It stores the validated
-- result (encrypted) and hands a one-time confirmation token to the browser's return link,
-- which opens the app on the same device. The account holder's app session that started
-- the attempt must present that token (POST /identity/verifications/:id/confirm) before the
-- identity is linked. A forwarded provider link therefore cannot link a victim's identity
-- to the attacker's account (cross-device consent phishing). See docs/reports/phase-04.md.

-- AlterTable
ALTER TABLE "identity_verifications" ADD COLUMN     "confirmation_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "confirmation_hash" TEXT,
ADD COLUMN     "initiated_session_id" UUID,
ADD COLUMN     "pending_result_enc" BYTEA;

-- AddForeignKey
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_initiated_session_id_fkey" FOREIGN KEY ("initiated_session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints. Covered by test/integration/identity-db-constraints.spec.ts.
-- ---------------------------------------------------------------------------

-- A received result waits only while the attempt is PENDING; the token, its expiry and the
-- result exist together; a result implies the callback was received.
ALTER TABLE "identity_verifications"
  ADD CONSTRAINT "identity_confirmation_hash_format_chk" CHECK (
    "confirmation_hash" IS NULL OR "confirmation_hash" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "identity_result_only_while_pending_chk" CHECK (
    "status" = 'PENDING' OR ("pending_result_enc" IS NULL AND "confirmation_hash" IS NULL AND "confirmation_expires_at" IS NULL)
  ),
  ADD CONSTRAINT "identity_result_shape_chk" CHECK (
    ("pending_result_enc" IS NULL) = ("confirmation_hash" IS NULL)
    AND ("confirmation_hash" IS NULL) = ("confirmation_expires_at" IS NULL)
  ),
  ADD CONSTRAINT "identity_result_after_callback_chk" CHECK (
    "pending_result_enc" IS NULL OR "callback_received_at" IS NOT NULL
  );

-- The session that started an attempt never changes (the confirmation is bound to it).
CREATE FUNCTION "identity_verifications_session_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."initiated_session_id" IS DISTINCT FROM OLD."initiated_session_id" THEN
    RAISE EXCEPTION 'identity_verifications.initiated_session_id is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "identity_verifications_session_guard"
  BEFORE UPDATE OF "initiated_session_id" ON "identity_verifications"
  FOR EACH ROW EXECUTE FUNCTION "identity_verifications_session_guard"();
