-- =============================================================================
-- Migration: Session Heartbeat (Auto-close)
-- Purpose:   Adds last_ping column and pg_cron job to close abandoned sessions.
-- =============================================================================

-- 1. Add last_ping column to sessions
ALTER TABLE public.sessions ADD COLUMN last_ping TIMESTAMP WITH TIME ZONE;

-- 2. Create RPC for heartbeat
CREATE OR REPLACE FUNCTION public.ping_session(p_session_id UUID)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE public.sessions
  SET last_ping = NOW()
  WHERE id = p_session_id;
$$;

-- 3. Enable pg_cron (requires superuser; in Supabase it is enabled via dashboard, but we can try)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 4. Create cron job to close abandoned sessions
-- If a session hasn't been pinged in 30 seconds, it's abandoned. Runs every minute.
SELECT cron.schedule(
  'close_abandoned_sessions',
  '* * * * *',
  $$
  WITH closed_sessions AS (
    UPDATE public.sessions
    SET ends_at = NOW()
    WHERE ends_at IS NULL
      AND last_ping IS NOT NULL
      AND last_ping < NOW() - INTERVAL '1 hour'
    RETURNING id
  )
  UPDATE public.device_sessions ds
  SET session_id = NULL
  FROM closed_sessions cs
  WHERE ds.session_id = cs.id;
  $$
);
