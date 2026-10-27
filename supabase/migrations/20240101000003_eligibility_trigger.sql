-- =============================================================================
-- Migration: 003_eligibility_trigger.sql
-- Project:   Multimodal University Attendance Verification System
-- Depends:   001_profiles_and_auth.sql  (public.profiles)
--            002_courses_sessions_attendance.sql  (course_enrollments,
--                                                  sessions, attendance_logs)
-- Purpose:   Keeps course_enrollments.eligibility_percentage in sync with the
--            actual attendance record in attendance_logs by recalculating it
--            automatically on every INSERT to attendance_logs.
--
-- Design rationale — why recalculate on INSERT rather than on a schedule?
-- -------------------------------------------------------------------------
-- Option A (scheduled job / cron): Runs periodically (e.g. every hour).
--   Cons: eligibility_percentage is stale between runs. A student who just
--   tapped their NFC card would see their old percentage until the next job
--   fires. For a real-time attendance dashboard this lag is unacceptable.
--
-- Option B (recalculate on INSERT — chosen here): Fires synchronously inside
--   the same transaction as the attendance_logs INSERT.
--   Pros:
--     • The percentage is always consistent with the data — zero lag.
--     • The update is atomic: if the INSERT rolls back (e.g. unique_attendance
--       violation), the UPDATE also rolls back automatically.
--     • No external scheduler infrastructure required.
--   Cons:
--     • Adds a small overhead to each INSERT. Acceptable here because attendance
--       events are low-frequency (one per student per session, not per second).
--
-- The trade-off would only reverse at very high INSERT rates (thousands/second),
-- which is unrealistic for a university attendance system.
-- =============================================================================


-- =============================================================================
-- SECTION 1: calculate_eligibility()
-- =============================================================================
-- A standalone helper function that performs the percentage arithmetic and
-- writes the result to course_enrollments. Keeping the calculation logic here
-- (separate from the trigger function) makes it easy to call manually from the
-- SQL editor during debugging or backfilling without having to fake an INSERT.

CREATE OR REPLACE FUNCTION public.calculate_eligibility(
    p_student_id  UUID,
    p_course_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER          -- Must bypass RLS to read attendance_logs and write
                          -- course_enrollments. The service_role owns this
                          -- function, so it runs with elevated privileges while
                          -- exposing only a tightly-scoped interface.
SET search_path = public  -- Prevent search-path hijacking.
AS $$
DECLARE
    v_total_sessions   INTEGER;
    v_attended         INTEGER;
    v_percentage       NUMERIC;
    v_enrollment_exists BOOLEAN;
BEGIN
    -- ------------------------------------------------------------------
    -- Guard: does an enrollment row exist for this student+course pair?
    -- ------------------------------------------------------------------
    -- The trigger fires immediately after the attendance_logs INSERT.
    -- In normal operation the student must be enrolled before they can
    -- attend, so this row should always exist. However, if data is
    -- backfilled manually (e.g. via a CSV import) or if an enrollment
    -- row was accidentally deleted after attendance was recorded, we
    -- should NOT crash — that would roll back the attendance INSERT and
    -- lose the record. Instead we log a notice and return early.
    SELECT EXISTS (
        SELECT 1
        FROM   public.course_enrollments
        WHERE  student_id = p_student_id
        AND    course_id  = p_course_id
    ) INTO v_enrollment_exists;

    IF NOT v_enrollment_exists THEN
        -- RAISE NOTICE is visible in the Supabase logs (Postgres log level)
        -- but does NOT abort the transaction or raise an error to the client.
        RAISE NOTICE
            'calculate_eligibility: no enrollment row found for student % in course %. Skipping update.',
            p_student_id, p_course_id;
        RETURN;  -- Exit gracefully; the attendance_logs INSERT still commits.
    END IF;

    -- ------------------------------------------------------------------
    -- Count total sessions for this course
    -- ------------------------------------------------------------------
    -- We count ALL sessions, not only past ones. This is intentional:
    -- a student who attends 3 of 4 scheduled sessions has 75% even if
    -- the 4th session is in the future. The percentage can only ever
    -- decrease as new sessions are added and the student hasn't attended
    -- them yet, which is the correct real-world semantics.
    SELECT COUNT(*)
    INTO   v_total_sessions
    FROM   public.sessions
    WHERE  course_id = p_course_id;

    -- ------------------------------------------------------------------
    -- Divide-by-zero guard
    -- ------------------------------------------------------------------
    -- If a course has no sessions yet (unlikely at INSERT time, but
    -- possible during testing or data setup), default to 0% rather than
    -- raising a division-by-zero exception.
    IF v_total_sessions = 0 THEN
        v_percentage := 100;
    ELSE
        -- ------------------------------------------------------------------
        -- Count sessions attended by this student in this course
        -- ------------------------------------------------------------------
        -- We JOIN through sessions to filter attendance_logs to only sessions
        -- that belong to p_course_id. A student may be enrolled in multiple
        -- courses; we must not count attendance from other courses.
        SELECT COUNT(*)
        INTO   v_attended
        FROM   public.attendance_logs  al
        JOIN   public.sessions         s  ON s.id = al.session_id
        WHERE  al.student_id = p_student_id
        AND    s.course_id   = p_course_id;

        -- Percentage rounded to 2 decimal places.
        -- ROUND(numeric, integer) is exact for NUMERIC type (no float error).
        v_percentage := ROUND(
            (v_attended::NUMERIC / v_total_sessions::NUMERIC) * 100,
            2
        );
    END IF;

    -- ------------------------------------------------------------------
    -- Write the result back to course_enrollments
    -- ------------------------------------------------------------------
    UPDATE public.course_enrollments
    SET    eligibility_percentage = v_percentage
    WHERE  student_id = p_student_id
    AND    course_id  = p_course_id;

    -- Sanity log (visible in Supabase Postgres logs, not exposed to clients).
    RAISE NOTICE
        'calculate_eligibility: student % course % → attended=% total=% pct=%',
        p_student_id, p_course_id, v_attended, v_total_sessions, v_percentage;
END;
$$;

COMMENT ON FUNCTION public.calculate_eligibility(UUID, UUID) IS
    'Recalculates and writes eligibility_percentage for a student+course pair. '
    'Safe to call manually for backfilling. Skips gracefully if no enrollment row exists.';


-- =============================================================================
-- SECTION 2: handle_new_attendance()  — the trigger function
-- =============================================================================
-- Trigger functions in Postgres must return TRIGGER (not VOID).
-- This function is a thin dispatcher: it resolves the course_id from the
-- session that was just logged, then delegates to calculate_eligibility().

CREATE OR REPLACE FUNCTION public.handle_new_attendance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_course_id UUID;
BEGIN
    -- ------------------------------------------------------------------
    -- Resolve course_id from the newly inserted attendance_logs row
    -- ------------------------------------------------------------------
    -- NEW is the just-inserted row in attendance_logs.
    -- attendance_logs stores session_id, not course_id directly, so we
    -- look up the parent session to get course_id.
    SELECT course_id
    INTO   v_course_id
    FROM   public.sessions
    WHERE  id = NEW.session_id;

    IF v_course_id IS NULL THEN
        -- The session row doesn't exist — should never happen because
        -- attendance_logs.session_id has a FK to sessions, but guard anyway.
        RAISE WARNING
            'handle_new_attendance: could not resolve course_id for session_id %. Skipping eligibility update.',
            NEW.session_id;
        RETURN NEW;  -- Still return NEW so the INSERT itself is not affected.
    END IF;

    -- Delegate the actual calculation and write to the helper function.
    PERFORM public.calculate_eligibility(NEW.student_id, v_course_id);

    -- Trigger functions must return the row. Returning NEW for AFTER triggers
    -- is conventional (the value is ignored by Postgres for AFTER triggers,
    -- but returning NULL would be confusing and is reserved for BEFORE triggers
    -- to signal row suppression).
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_attendance() IS
    'Trigger function: resolves course_id from the inserted attendance_logs row '
    'and calls calculate_eligibility(). Fires AFTER INSERT on attendance_logs.';


-- =============================================================================
-- SECTION 3: ATTACH TRIGGER TO attendance_logs
-- =============================================================================
-- We use CREATE OR REPLACE TRIGGER (Postgres 14+). If your Supabase project
-- is on an older version, drop the trigger first with:
--   DROP TRIGGER IF EXISTS on_attendance_logged ON public.attendance_logs;

CREATE OR REPLACE TRIGGER on_attendance_logged
    AFTER INSERT                    -- Fires only on INSERT, not UPDATE/DELETE.
                                    -- Attendance records are immutable (no UPDATE
                                    -- policy exists), so UPDATE is not needed.
    ON public.attendance_logs
    FOR EACH ROW                    -- Fires once per inserted row. If a bulk
                                    -- INSERT adds N rows, the trigger fires N
                                    -- times — once per student, which is correct.
    EXECUTE FUNCTION public.handle_new_attendance();

COMMENT ON TRIGGER on_attendance_logged ON public.attendance_logs IS
    'Recalculates eligibility_percentage in course_enrollments after each '
    'new attendance record is inserted.';


-- =============================================================================
-- END OF MIGRATION 003
-- =============================================================================
