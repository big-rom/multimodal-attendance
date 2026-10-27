-- =============================================================================
-- Migration: Backfill Course Eligibility for Approved Enrollments
-- =============================================================================

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN 
        SELECT student_id, course_id 
        FROM public.course_enrollments 
        WHERE status = 'approved'
    LOOP
        PERFORM public.calculate_eligibility(r.student_id, r.course_id);
    END LOOP;
END;
$$;
