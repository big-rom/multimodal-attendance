-- =============================================================================
-- Migration: 20260921000000_course_registration.sql
-- Purpose:   Implements explicit student signup and course approval workflow.
-- =============================================================================

-- =============================================================================
-- 1. PROFILES & SIGNUP TRIGGER
-- =============================================================================

-- Update signup trigger to enforce role='student' and concatenate name fields
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_surname TEXT;
    v_firstname TEXT;
    v_other_names TEXT;
    v_full_name TEXT;
    v_matric TEXT;
BEGIN
    v_surname := trim(NEW.raw_user_meta_data ->> 'surname');
    v_firstname := trim(NEW.raw_user_meta_data ->> 'firstname');
    v_other_names := trim(NEW.raw_user_meta_data ->> 'other_names');
    v_matric := upper(trim(NEW.raw_user_meta_data ->> 'matric_number'));
    
    -- Construct full name securely
    v_full_name := concat_ws(' ', v_surname, v_firstname, NULLIF(v_other_names, ''));
    IF v_full_name = '' THEN
        v_full_name := split_part(NEW.email, '@', 1);
    END IF;

    INSERT INTO public.profiles (id, full_name, role, matric_number)
    VALUES (
        NEW.id,
        v_full_name,
        'student', -- ALWAYS hardcoded, ignores client input
        NULLIF(v_matric, '')
    );

    RETURN NEW;
END;
$$;

-- Add CHECK constraint on matric_number for students
ALTER TABLE public.profiles ADD CONSTRAINT chk_matric_format 
CHECK (
    role = 'lecturer' OR 
    (role = 'student' AND matric_number ~ '^CSC/\d{4}/\d{3}$')
) NOT VALID;

-- Drop student update access entirely. Lecturers can still update themselves.
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;

CREATE POLICY "Lecturers can update their own profile"
    ON public.profiles
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = id AND role = 'lecturer')
    WITH CHECK (auth.uid() = id AND role = 'lecturer');


-- Update lecturer read access on profiles
DROP POLICY IF EXISTS "Lecturers can view all student profiles" ON public.profiles;

CREATE OR REPLACE FUNCTION public.is_lecturer() RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'lecturer');
$$;

CREATE OR REPLACE FUNCTION public.lecturer_has_student(p_student_id UUID) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM public.course_enrollments ce
    JOIN public.courses c ON c.id = ce.course_id
    WHERE ce.student_id = p_student_id
    AND c.lecturer_id = auth.uid()
  );
$$;

CREATE POLICY "Lecturers can view their students"
    ON public.profiles
    FOR SELECT
    TO authenticated
    USING (
        public.is_lecturer()
        AND role = 'student'
        AND public.lecturer_has_student(id)
    );

-- =============================================================================
-- 2. COURSES
-- =============================================================================

COMMENT ON COLUMN public.courses.lecturer_id IS 'Must reference a profile with role = ''lecturer''. This lecturer is the sole coordinator for the course.';

CREATE OR REPLACE VIEW public.available_courses AS
SELECT 
    c.id, 
    c.course_code, 
    c.course_title, 
    c.lecturer_id AS coordinator_id, 
    p.full_name AS coordinator_full_name
FROM public.courses c
JOIN public.profiles p ON p.id = c.lecturer_id;

GRANT SELECT ON public.available_courses TO authenticated;


-- =============================================================================
-- 3. COURSE ENROLLMENTS
-- =============================================================================

ALTER TABLE public.course_enrollments
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
    ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS decided_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

ALTER TABLE public.course_enrollments
    ADD CONSTRAINT chk_rejection_reason_length
    CHECK (
        status != 'rejected' OR 
        (rejection_reason IS NOT NULL AND length(trim(rejection_reason)) >= 5)
    );

-- Remove mutation policies
DROP POLICY IF EXISTS "Lecturers can enroll students in their courses" ON public.course_enrollments;
DROP POLICY IF EXISTS "Lecturers can remove enrollments from their courses" ON public.course_enrollments;


-- =============================================================================
-- 4. ENROLLMENT FUNCTIONS
-- =============================================================================

-- request_course_enrollment
CREATE OR REPLACE FUNCTION public.request_course_enrollment(p_course_id UUID)
RETURNS public.course_enrollments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_enrollment public.course_enrollments;
    v_course_exists BOOLEAN;
    v_role TEXT;
BEGIN
    SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
    IF v_role != 'student' THEN
        RAISE EXCEPTION 'Only students can request course enrollment.';
    END IF;

    SELECT EXISTS (SELECT 1 FROM public.courses WHERE id = p_course_id) INTO v_course_exists;
    IF NOT v_course_exists THEN
        RAISE EXCEPTION 'Course not found.';
    END IF;

    SELECT * INTO v_enrollment FROM public.course_enrollments WHERE student_id = auth.uid() AND course_id = p_course_id;

    IF FOUND THEN
        IF v_enrollment.status = 'rejected' THEN
            UPDATE public.course_enrollments
            SET status = 'pending',
                rejection_reason = NULL,
                decided_by = NULL,
                decided_at = NULL,
                requested_at = now()
            WHERE id = v_enrollment.id
            RETURNING * INTO v_enrollment;
            RETURN v_enrollment;
        ELSE
            RAISE EXCEPTION 'Enrollment already %.', v_enrollment.status;
        END IF;
    ELSE
        INSERT INTO public.course_enrollments (student_id, course_id, status)
        VALUES (auth.uid(), p_course_id, 'pending')
        RETURNING * INTO v_enrollment;
        RETURN v_enrollment;
    END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.request_course_enrollment(UUID) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.request_course_enrollment(UUID) TO authenticated;


-- decide_enrollment
CREATE OR REPLACE FUNCTION public.decide_enrollment(
    p_enrollment_id UUID,
    p_decision TEXT,
    p_reason TEXT DEFAULT NULL
)
RETURNS public.course_enrollments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_enrollment public.course_enrollments;
    v_course_lecturer UUID;
BEGIN
    IF p_decision NOT IN ('approve', 'reject') THEN
        RAISE EXCEPTION 'Decision must be approve or reject.';
    END IF;

    SELECT * INTO v_enrollment
    FROM public.course_enrollments
    WHERE id = p_enrollment_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Enrollment request not found.';
    END IF;

    SELECT lecturer_id INTO v_course_lecturer
    FROM public.courses
    WHERE id = v_enrollment.course_id;

    IF v_course_lecturer != auth.uid() THEN
        RAISE EXCEPTION 'You are not the coordinator for this course.';
    END IF;

    IF v_enrollment.status != 'pending' THEN
        RAISE EXCEPTION 'Enrollment is already %.', v_enrollment.status;
    END IF;

    IF p_decision = 'approve' THEN
        UPDATE public.course_enrollments
        SET status = 'approved',
            decided_by = auth.uid(),
            decided_at = now(),
            rejection_reason = NULL
        WHERE id = p_enrollment_id
        RETURNING * INTO v_enrollment;
    ELSE
        IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
            RAISE EXCEPTION 'A rejection reason of at least 5 characters is required.';
        END IF;
        
        UPDATE public.course_enrollments
        SET status = 'rejected',
            decided_by = auth.uid(),
            decided_at = now(),
            rejection_reason = trim(p_reason)
        WHERE id = p_enrollment_id
        RETURNING * INTO v_enrollment;
    END IF;

    RETURN v_enrollment;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.decide_enrollment(UUID, TEXT, TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.decide_enrollment(UUID, TEXT, TEXT) TO authenticated;


-- =============================================================================
-- 5. UPDATE CALCULATE_ELIGIBILITY
-- =============================================================================

CREATE OR REPLACE FUNCTION public.calculate_eligibility(
    p_student_id  UUID,
    p_course_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total_sessions   INTEGER;
    v_attended         INTEGER;
    v_percentage       NUMERIC;
    v_enrollment_exists BOOLEAN;
BEGIN
    -- Now requires status = 'approved'
    SELECT EXISTS (
        SELECT 1
        FROM   public.course_enrollments
        WHERE  student_id = p_student_id
        AND    course_id  = p_course_id
        AND    status = 'approved'
    ) INTO v_enrollment_exists;

    IF NOT v_enrollment_exists THEN
        RAISE NOTICE
            'calculate_eligibility: no approved enrollment row found for student % in course %. Skipping update.',
            p_student_id, p_course_id;
        RETURN;
    END IF;

    SELECT COUNT(*)
    INTO   v_total_sessions
    FROM   public.sessions
    WHERE  course_id = p_course_id;

    IF v_total_sessions = 0 THEN
        v_percentage := 0;
    ELSE
        SELECT COUNT(*)
        INTO   v_attended
        FROM   public.attendance_logs  al
        JOIN   public.sessions         s  ON s.id = al.session_id
        WHERE  al.student_id = p_student_id
        AND    s.course_id   = p_course_id;

        v_percentage := ROUND(
            (v_attended::NUMERIC / v_total_sessions::NUMERIC) * 100,
            2
        );
    END IF;

    UPDATE public.course_enrollments
    SET    eligibility_percentage = v_percentage
    WHERE  student_id = p_student_id
    AND    course_id  = p_course_id
    AND    status = 'approved';

    RAISE NOTICE
        'calculate_eligibility: student % course % → attended=% total=% pct=%',
        p_student_id, p_course_id, v_attended, v_total_sessions, v_percentage;
END;
$$;
