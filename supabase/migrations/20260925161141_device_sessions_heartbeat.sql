-- =============================================================================
-- Migration: device_sessions heartbeat columns
-- Purpose:   Allows the enrolment-mode/status Edge Function to upsert
--            last_seen and current_mode on every ESP32 poll, giving the
--            dashboard a lightweight online/offline indicator without a
--            separate heartbeat endpoint.
-- =============================================================================

-- Add last_seen: updated by the edge function on every /status poll.
-- NULL means the device has never polled (row may not exist yet either).
ALTER TABLE public.device_sessions
  ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

-- Add current_mode: the mode the ESP32 reported on its last poll
-- ('attend' or 'enrol'). Informational only -- the source of truth for
-- the actual mode is enrolment_mode_flag.active.
ALTER TABLE public.device_sessions
  ADD COLUMN IF NOT EXISTS current_mode TEXT
    CHECK (current_mode IN ('attend', 'enrol'));

COMMENT ON COLUMN public.device_sessions.last_seen IS
  'Timestamp of the most recent /status poll from this device. '
  'Set server-side by the enrolment-mode Edge Function on every GET /status. '
  'Used by the dashboard to determine online/offline status '
  '(threshold: ~16-20 s, i.e. roughly 2x the 8 s firmware poll interval).';

COMMENT ON COLUMN public.device_sessions.current_mode IS
  'The operating mode the ESP32 was in when it last polled. '
  '''attend'' = ATTEND_MODE, ''enrol'' = ENROL_MODE. '
  'Derived from enrolment_mode_flag.active on the server side.';
