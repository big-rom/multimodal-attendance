-- =============================================================================
-- Migration: 20260709165807_attendance_logs_verification_method.sql
-- Project:   Multimodal University Attendance Verification System
-- Depends:   002_courses_sessions_attendance.sql  (public.attendance_logs must exist)
--
-- Purpose:
--   Adds a `verification_method` column to public.attendance_logs that carries
--   the fine-grained identity of which channel recorded the attendance row.
--
--   This column is intentionally separate from the existing `method` column:
--     * `method`              -- coarse enum: 'nfc' | 'qr'
--                                (legacy; retained for backwards compatibility)
--     * `verification_method` -- precise channel: 'esp32_nfc' | 'web_nfc' | 'qr'
--                                (new; every insert path must supply this value)
--
-- Allowed values and their meaning:
--   'esp32_nfc'  A physical ESP32 device read the student's NFC card.
--   'web_nfc'    The Web NFC API on the student's browser read the card.
--   'qr'         The student scanned a lecturer-generated QR code.
--
-- Design decisions:
--   * NO DEFAULT -- every write path (Edge Function or otherwise) must
--     explicitly set verification_method. Silently defaulting the column
--     would mask bugs in new insert paths and produce misleading audit data.
--
--   * NOT NULL -- a row with an unknown verification channel is not auditable.
--     Forcing NOT NULL at the DB level means a missing value from application
--     code raises a clear constraint error rather than storing a NULL silently.
--
--   * Named CHECK constraint -- naming it 'chk_verification_method_values'
--     lets callers inspect the constraint_name field of the Postgres error
--     (code 23514) to return a precise error message instead of a generic one.
--
--   * Existing rows -- if the production database already has rows in
--     attendance_logs, this migration will fail because NOT NULL without a
--     DEFAULT means Postgres cannot supply a value for existing rows.
--     In that case the operator must backfill first:
--       ALTER TABLE public.attendance_logs
--         ADD COLUMN verification_method TEXT;
--       UPDATE public.attendance_logs SET verification_method = method;
--       ALTER TABLE public.attendance_logs
--         ALTER COLUMN verification_method SET NOT NULL,
--         ADD CONSTRAINT chk_verification_method_values
--           CHECK (verification_method IN ('esp32_nfc', 'web_nfc', 'qr'));
--
-- =============================================================================

ALTER TABLE public.attendance_logs
  ADD COLUMN verification_method TEXT NOT NULL
  CONSTRAINT chk_verification_method_values
    CHECK (verification_method IN ('esp32_nfc', 'web_nfc', 'qr'));

COMMENT ON COLUMN public.attendance_logs.verification_method IS
  'Fine-grained attendance channel. '
  '''esp32_nfc'' = physical ESP32 NFC reader; '
  '''web_nfc'' = browser Web NFC API; '
  '''qr'' = QR code scan. '
  'No default -- every insert path must supply this value explicitly.';

-- Index: verification_method will appear in WHERE / GROUP BY clauses when
-- producing per-channel attendance breakdowns (e.g. "how many students tapped
-- vs scanned today?"). Prevents a seq-scan on large tables for analytics queries.
CREATE INDEX IF NOT EXISTS idx_attendance_verification_method
  ON public.attendance_logs (verification_method);

-- =============================================================================
-- END OF MIGRATION 20260709165807
-- =============================================================================
