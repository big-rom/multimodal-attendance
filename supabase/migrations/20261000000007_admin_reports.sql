-- =============================================================================
-- Migration: Admin System Attendance Report
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_system_attendance_report()
RETURNS TABLE (
    course_id UUID,
    course_code TEXT,
    course_title TEXT,
    lecturer_name TEXT,
    total_sessions BIGINT,
    total_attendances BIGINT
) 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        c.id as course_id,
        c.course_code,
        c.course_title,
        p.full_name as lecturer_name,
        COUNT(DISTINCT s.id) as total_sessions,
        COUNT(DISTINCT a.id) as total_attendances
    FROM public.courses c
    LEFT JOIN public.profiles p ON p.id = c.lecturer_id
    LEFT JOIN public.sessions s ON s.course_id = c.id
    LEFT JOIN public.attendance_logs a ON a.session_id = s.id
    GROUP BY c.id, c.course_code, c.course_title, p.full_name
    ORDER BY c.course_code ASC;
END;
$$;
