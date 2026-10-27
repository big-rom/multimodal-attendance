-- Migration: enrolment_mode_flag
-- Replaces the in-memory / Deno KV approach with a database-backed flag so
-- that the stateless Edge Function can share state across all invocations.

CREATE TABLE IF NOT EXISTS public.enrolment_mode_flag (
  id           INTEGER PRIMARY KEY DEFAULT 1,
  -- Only one row ever exists (id is always 1)
  active       BOOLEAN NOT NULL DEFAULT false,
  activated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ,
  CONSTRAINT single_row CHECK (id = 1)
);

-- Insert the single row immediately so UPDATE always finds it
INSERT INTO public.enrolment_mode_flag (id, active)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

-- Row Level Security
ALTER TABLE public.enrolment_mode_flag ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Lecturers can toggle enrolment mode"
  ON public.enrolment_mode_flag
  FOR UPDATE TO authenticated
  USING (
    (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'lecturer'
  );

CREATE POLICY "Anyone authenticated can read enrolment mode status"
  ON public.enrolment_mode_flag
  FOR SELECT TO authenticated
  USING (true);
