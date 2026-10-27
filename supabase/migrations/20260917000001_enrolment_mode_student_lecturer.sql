-- Migration: add student_id and lecturer_id to enrolment_mode_flag
-- These columns store the enrolment target chosen by the lecturer at the moment
-- they activate enrolment mode from the dashboard.  The ESP32 reads them back
-- via GET /enrolment-mode/status and includes them verbatim in its POST to
-- enrol-card, where they are validated against the stored values before the
-- anon-key path is allowed to proceed.

ALTER TABLE public.enrolment_mode_flag
  ADD COLUMN IF NOT EXISTS student_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lecturer_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
