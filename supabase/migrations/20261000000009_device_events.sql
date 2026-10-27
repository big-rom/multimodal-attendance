-- =============================================================================
-- Migration: Hardware Device Events and Telemetry for Live Dashboard Feedback
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.device_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT NOT NULL,
    event_type TEXT NOT NULL, -- 'enrol_success', 'enrol_error', 'tap_success', 'tap_error', 'tap_warning'
    status TEXT NOT NULL,     -- 'success', 'error', 'warning', 'info'
    message TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_events_device_created
ON public.device_events (device_id, created_at DESC);

-- Enable RLS
ALTER TABLE public.device_events ENABLE ROW LEVEL SECURITY;

-- Allow authenticated lecturers and admins to view device events
CREATE POLICY "Lecturers and admins can view device events"
ON public.device_events
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.profiles 
        WHERE id = auth.uid() AND role IN ('lecturer', 'admin')
    )
);

-- Enable Supabase Realtime broadcast for live UI reflection
ALTER PUBLICATION supabase_realtime ADD TABLE public.device_events;
