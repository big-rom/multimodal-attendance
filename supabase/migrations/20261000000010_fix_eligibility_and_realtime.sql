-- =============================================================================
-- Migration: Recalculate Eligibility on Session Creation & Add attendance_logs to Realtime
-- =============================================================================

-- 1. Recalculate course eligibility for all enrolled students when a new session is created
--    Ensures absentee students' attendance percentage drops dynamically when new sessions occur.
CREATE OR REPLACE FUNCTION public.recalc_course_eligibility()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN 
        SELECT student_id 
        FROM public.course_enrollments
        WHERE course_id = NEW.course_id 
          AND status = 'approved'
    LOOP
        PERFORM public.calculate_eligibility(r.student_id, NEW.course_id);
    END LOOP;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_session_created ON public.sessions;

CREATE TRIGGER on_session_created
    AFTER INSERT ON public.sessions
    FOR EACH ROW
    EXECUTE FUNCTION public.recalc_course_eligibility();

-- 2. Add attendance_logs to Supabase Realtime publication
--    Enables instant (<3s) websocket broadcast to lecturer dashboard on QR scan and NFC taps.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' 
          AND schemaname = 'public' 
          AND tablename = 'attendance_logs'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_logs;
    END IF;
END $$;
