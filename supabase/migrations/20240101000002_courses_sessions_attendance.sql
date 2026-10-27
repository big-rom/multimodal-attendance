-- =============================================================================
-- Migration: 002_courses_sessions_attendance.sql
-- Project:   Multimodal University Attendance Verification System
-- Depends:   001_profiles_and_auth.sql  (public.profiles must exist)
-- Purpose:   Creates the four core domain tables for tracking courses,
--            enrollments, class sessions, and attendance records.
--            Row Level Security is applied to every table.
--
-- Table dependency order (bottom depends on top):
--   profiles  ← (migration 001)
--   courses
--   course_enrollments  (references profiles + courses)
--   sessions            (references profiles + courses)
--   attendance_logs     (references profiles + sessions)
-- =============================================================================


-- =============================================================================
-- SECTION 1: COURSES
-- =============================================================================
-- A course is owned by exactly one lecturer. The lecturer_id foreign key points
-- to profiles, but we further enforce at the application/trigger layer that the
-- referenced profile has role = 'lecturer'. A CHECK at this level alone would
-- require a sub-SELECT and is not directly supported in a FK constraint; the
-- recommended pattern is a separate trigger (see note below the table).

CREATE TABLE IF NOT EXISTS public.courses (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Short institutional code, e.g. "CSC401", "MTH302". Must be unique
    -- across the entire university catalogue.
    course_code   TEXT        NOT NULL UNIQUE,

    course_title  TEXT        NOT NULL,

    -- The lecturer responsible for this course. References public.profiles
    -- (not auth.users directly) because we need the role column.
    -- ON DELETE RESTRICT prevents orphaning a course if a lecturer account
    -- is deleted — an admin must reassign first.
    lecturer_id   UUID        NOT NULL
                              REFERENCES public.profiles (id) ON DELETE RESTRICT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.courses             IS 'University course catalogue entries, each owned by one lecturer.';
COMMENT ON COLUMN public.courses.course_code IS 'Short institutional code, e.g. CSC401. Unique across the catalogue.';
COMMENT ON COLUMN public.courses.lecturer_id IS 'Must reference a profile with role = ''lecturer''.';

-- Note on lecturer-only enforcement:
-- A CHECK constraint cannot cross tables, so the role = 'lecturer' rule is
-- enforced by the RLS INSERT policy below (only authenticated lecturers can
-- create courses) plus a trigger in migration 003 if stricter DB-level
-- enforcement is required.


-- =============================================================================
-- SECTION 2: COURSE ENROLLMENTS
-- =============================================================================
-- Records which students are officially registered for which course.
-- The eligibility_percentage column starts at 0 and is recalculated by a
-- trigger (migration 003) each time an attendance_log row is inserted.

CREATE TABLE IF NOT EXISTS public.course_enrollments (
    id                      UUID     PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The enrolled student.
    student_id              UUID     NOT NULL
                                     REFERENCES public.profiles (id) ON DELETE CASCADE,

    -- The course the student is enrolled in.
    course_id               UUID     NOT NULL
                                     REFERENCES public.courses (id) ON DELETE CASCADE,

    -- Attendance eligibility as a percentage (0–100). Computed automatically;
    -- clients should treat this as read-only.
    eligibility_percentage  NUMERIC  NOT NULL DEFAULT 100
                                     CHECK (eligibility_percentage BETWEEN 0 AND 100),

    -- Prevent duplicate enrollment rows for the same student+course pair.
    -- This is a data-integrity guarantee, not just an application concern.
    CONSTRAINT unique_enrollment UNIQUE (student_id, course_id)
);

COMMENT ON TABLE  public.course_enrollments                      IS 'Maps students to courses they are officially enrolled in.';
COMMENT ON COLUMN public.course_enrollments.eligibility_percentage IS 'Attendance %. Recomputed by trigger on every attendance_logs insert.';


-- =============================================================================
-- SECTION 3: SESSIONS
-- =============================================================================
-- A session represents a single scheduled class meeting (e.g. a lecture on a
-- specific date). Attendance is recorded against a session, not a course,
-- so that per-meeting granularity is preserved.

CREATE TABLE IF NOT EXISTS public.sessions (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which course this session belongs to.
    course_id     UUID        NOT NULL
                              REFERENCES public.courses (id) ON DELETE CASCADE,

    -- Calendar date of the class. Stored separately from the timestamp to make
    -- date-range queries (e.g. "all sessions this week") cheap without
    -- timezone conversion arithmetic.
    session_date  DATE        NOT NULL DEFAULT CURRENT_DATE,

    -- Wall-clock start time of the session (timezone-aware).
    starts_at     TIMESTAMPTZ NOT NULL,

    -- Wall-clock end time. NULL means the session is still ongoing or the
    -- lecturer has not yet closed it.
    ends_at       TIMESTAMPTZ,

    -- The lecturer who opened/created this session record. Must equal the
    -- courses.lecturer_id for that course — enforced by RLS below.
    created_by    UUID        NOT NULL
                              REFERENCES public.profiles (id) ON DELETE RESTRICT,

    -- Sanity check: end time must come after start time when provided.
    CONSTRAINT session_times_valid CHECK (ends_at IS NULL OR ends_at > starts_at)
);

COMMENT ON TABLE  public.sessions            IS 'A single class meeting for a course. Attendance is recorded per session.';
COMMENT ON COLUMN public.sessions.ends_at    IS 'NULL while the session is open. Set by the lecturer when closing.';
COMMENT ON COLUMN public.sessions.created_by IS 'Must be the lecturer who owns the parent course.';


-- =============================================================================
-- SECTION 4: ATTENDANCE LOGS
-- =============================================================================
-- This is the most critical table in the system. Each row records that a
-- specific student was verified as present at a specific session, via a
-- specific verification method (NFC card tap or QR code scan).
--
-- FRAUD PREVENTION — the unique_attendance constraint:
-- -------------------------------------------------------
-- The composite UNIQUE constraint on (student_id, session_id) is the database's
-- last line of defence against duplicate attendance records. Here is why it is
-- structured exactly this way:
--
--  1. WHY COMPOSITE (not separate unique columns)?
--     We need uniqueness across the COMBINATION of student + session. A student
--     may legitimately appear in many sessions (same student_id, different
--     session_id) and many students attend the same session (different
--     student_id, same session_id). Only the pair must be unique.
--
--  2. WHY A NAMED CONSTRAINT?
--     Naming it 'unique_attendance' lets the Edge Function catch the specific
--     Postgres error code 23505 and inspect the constraint_name field to return
--     a clear "already marked present" response rather than a generic DB error.
--
--  3. WHY NOT RELY ON APPLICATION LOGIC ALONE?
--     Network retries, race conditions, or a bug in the Edge Function could
--     issue two concurrent INSERTs for the same student+session within
--     milliseconds of each other. Postgres resolves concurrent UNIQUE violations
--     at the storage level using its MVCC locking — application-level checks
--     (SELECT then INSERT) have a TOCTOU race window that this constraint closes.
--
--  4. WHY DOES THIS COVER BOTH NFC AND QR?
--     The constraint is on (student_id, session_id) — it does NOT include the
--     `method` column. This means a student who taps their NFC card cannot then
--     also scan a QR code to produce a second log for the same session, and
--     vice versa. The verification method is irrelevant to uniqueness; presence
--     is binary.
--
-- INSERT permissions:
-- -------------------
-- Direct INSERT from the client is intentionally blocked by RLS (no policy
-- grants INSERT to the 'authenticated' role). Only the Supabase Edge Function,
-- which uses the service_role JWT (bypasses RLS), is permitted to write here.
-- This ensures all attendance records go through the verification logic in the
-- Edge Function and cannot be spoofed by a client calling the REST API directly.

CREATE TABLE IF NOT EXISTS public.attendance_logs (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The student whose attendance is being recorded.
    student_id   UUID        NOT NULL
                             REFERENCES public.profiles (id) ON DELETE CASCADE,

    -- The session the student attended.
    session_id   UUID        NOT NULL
                             REFERENCES public.sessions (id) ON DELETE CASCADE,

    -- How the student was verified. Constrained to the two supported methods.
    method       TEXT        NOT NULL
                             CHECK (method IN ('nfc', 'qr')),

    -- When the log was created. Defaults to the moment of INSERT; the Edge
    -- Function may also pass an explicit timestamp from the device clock.
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- -------------------------------------------------------------------------
    -- CORE FRAUD-PREVENTION CONSTRAINT (see detailed explanation above)
    -- -------------------------------------------------------------------------
    -- A student can appear AT MOST ONCE per session, regardless of method.
    -- Postgres enforces this atomically using a unique B-tree index under the
    -- hood; any duplicate INSERT raises error 23505 (unique_violation).
    CONSTRAINT unique_attendance UNIQUE (student_id, session_id)
);

COMMENT ON TABLE  public.attendance_logs            IS 'Immutable attendance records. Written only by the Edge Function via service_role.';
COMMENT ON COLUMN public.attendance_logs.method     IS '''nfc'' or ''qr''. Which verification channel was used.';
COMMENT ON COLUMN public.attendance_logs.student_id IS 'Combined with session_id in unique_attendance to prevent duplicate records.';


-- =============================================================================
-- SECTION 5: INDEXES
-- =============================================================================
-- Postgres automatically creates a B-tree index for every PRIMARY KEY and
-- UNIQUE constraint, so we do not re-index those columns. The indexes below
-- cover foreign-key columns that appear in WHERE clauses and JOIN conditions
-- but are not already covered by a unique index.

-- courses: look up all courses taught by a lecturer (lecturer dashboard).
CREATE INDEX IF NOT EXISTS idx_courses_lecturer_id
    ON public.courses (lecturer_id);

-- course_enrollments: look up all courses a student is enrolled in.
CREATE INDEX IF NOT EXISTS idx_enrollments_student_id
    ON public.course_enrollments (student_id);

-- course_enrollments: look up all students enrolled in a course (roster view).
CREATE INDEX IF NOT EXISTS idx_enrollments_course_id
    ON public.course_enrollments (course_id);

-- sessions: look up all sessions for a given course (timetable view).
CREATE INDEX IF NOT EXISTS idx_sessions_course_id
    ON public.sessions (course_id);

-- sessions: look up all sessions created by a lecturer.
CREATE INDEX IF NOT EXISTS idx_sessions_created_by
    ON public.sessions (created_by);

-- sessions: range queries by date (e.g. "sessions this week").
CREATE INDEX IF NOT EXISTS idx_sessions_session_date
    ON public.sessions (session_date);

-- attendance_logs: look up all sessions a student attended (student history).
CREATE INDEX IF NOT EXISTS idx_attendance_student_id
    ON public.attendance_logs (student_id);

-- attendance_logs: look up all attendance records for a session (register view).
CREATE INDEX IF NOT EXISTS idx_attendance_session_id
    ON public.attendance_logs (session_id);


-- =============================================================================
-- SECTION 6: ROW LEVEL SECURITY
-- =============================================================================
-- RLS is enabled on every table. All four tables default to DENY ALL when RLS
-- is active; the explicit policies below selectively re-open access.
-- The service_role JWT (used by Edge Functions) bypasses RLS entirely by design.

ALTER TABLE public.courses            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_logs    ENABLE ROW LEVEL SECURITY;


-- =============================================================================
-- 6a. COURSES policies
-- =============================================================================

-- Lecturers can see only courses they own. Students have no direct access to
-- the courses table (they access course info through their enrollments).
CREATE POLICY "Lecturers can view their own courses"
    ON public.courses
    FOR SELECT
    TO authenticated
    USING (
        lecturer_id = auth.uid()
    );

-- Only a user whose profile role = 'lecturer' may create a course, and the
-- row being inserted must set lecturer_id to that user's own id — a lecturer
-- cannot create a course and assign it to someone else.
CREATE POLICY "Lecturers can create courses they own"
    ON public.courses
    FOR INSERT
    TO authenticated
    WITH CHECK (
        lecturer_id = auth.uid()
        AND (
            SELECT role FROM public.profiles WHERE id = auth.uid()
        ) = 'lecturer'
    );

-- Lecturers may update courses they own (e.g. rename the course title).
CREATE POLICY "Lecturers can update their own courses"
    ON public.courses
    FOR UPDATE
    TO authenticated
    USING  (lecturer_id = auth.uid())
    WITH CHECK (lecturer_id = auth.uid());   -- cannot re-assign ownership

-- Lecturers may delete courses they own. Cascade deletes will remove all
-- child sessions and enrollments automatically.
CREATE POLICY "Lecturers can delete their own courses"
    ON public.courses
    FOR DELETE
    TO authenticated
    USING (lecturer_id = auth.uid());


-- =============================================================================
-- 6b. COURSE ENROLLMENTS policies
-- =============================================================================

-- Students can see their own enrollment rows (e.g. to check their eligibility
-- percentage or which courses they are registered for).
CREATE POLICY "Students can view their own enrollments"
    ON public.course_enrollments
    FOR SELECT
    TO authenticated
    USING (
        student_id = auth.uid()
    );

-- Lecturers can view the full enrollment roster for any course they own.
-- This is needed for the dashboard showing which students are in their class.
CREATE POLICY "Lecturers can view enrollments for their courses"
    ON public.course_enrollments
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM   public.courses c
            WHERE  c.id = course_id
            AND    c.lecturer_id = auth.uid()
        )
    );

-- Lecturers can enroll students into courses they own.
-- (In practice this may also be done via a server-side admin process.)
CREATE POLICY "Lecturers can enroll students in their courses"
    ON public.course_enrollments
    FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM   public.courses c
            WHERE  c.id = course_id
            AND    c.lecturer_id = auth.uid()
        )
    );

-- Lecturers can remove students from courses they own.
CREATE POLICY "Lecturers can remove enrollments from their courses"
    ON public.course_enrollments
    FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM   public.courses c
            WHERE  c.id = course_id
            AND    c.lecturer_id = auth.uid()
        )
    );


-- =============================================================================
-- 6c. SESSIONS policies
-- =============================================================================

-- Students can view sessions for courses they are enrolled in. This allows the
-- student app to show upcoming or past lectures for their registered courses.
CREATE POLICY "Students can view sessions for their enrolled courses"
    ON public.sessions
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM   public.course_enrollments ce
            WHERE  ce.course_id = sessions.course_id
            AND    ce.student_id = auth.uid()
        )
    );

-- Lecturers can view sessions they created.
CREATE POLICY "Lecturers can view their own sessions"
    ON public.sessions
    FOR SELECT
    TO authenticated
    USING (
        created_by = auth.uid()
    );

-- Lecturers can create sessions for courses they own.
-- created_by must be the caller's own id; course_id must belong to them.
CREATE POLICY "Lecturers can create sessions for their courses"
    ON public.sessions
    FOR INSERT
    TO authenticated
    WITH CHECK (
        created_by = auth.uid()
        AND EXISTS (
            SELECT 1
            FROM   public.courses c
            WHERE  c.id = course_id
            AND    c.lecturer_id = auth.uid()
        )
    );

-- Lecturers can update sessions they created (e.g. close a session by setting
-- ends_at, or correct the session date).
CREATE POLICY "Lecturers can update their own sessions"
    ON public.sessions
    FOR UPDATE
    TO authenticated
    USING  (created_by = auth.uid())
    WITH CHECK (created_by = auth.uid());

-- Lecturers can delete sessions they created.
CREATE POLICY "Lecturers can delete their own sessions"
    ON public.sessions
    FOR DELETE
    TO authenticated
    USING (created_by = auth.uid());


-- =============================================================================
-- 6d. ATTENDANCE LOGS policies
-- =============================================================================
-- INSERT is intentionally omitted for the 'authenticated' role.
-- No policy = no access for that operation (RLS default-deny).
-- The Edge Function authenticates with the service_role secret, which bypasses
-- RLS entirely, so it can INSERT without needing a policy here.

-- Students can read their own attendance history (e.g. "which sessions did I
-- attend?", "what is my attendance percentage per course?").
CREATE POLICY "Students can view their own attendance logs"
    ON public.attendance_logs
    FOR SELECT
    TO authenticated
    USING (
        student_id = auth.uid()
    );

-- Lecturers can read attendance logs for sessions that belong to their courses.
-- This powers the register/roll-call view in the lecturer dashboard.
CREATE POLICY "Lecturers can view attendance logs for their sessions"
    ON public.attendance_logs
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM   public.sessions  s
            JOIN   public.courses   c ON c.id = s.course_id
            WHERE  s.id = attendance_logs.session_id
            AND    c.lecturer_id = auth.uid()
        )
    );

-- NOTE: No UPDATE or DELETE policies are defined for attendance_logs for any
-- authenticated role. Attendance records are immutable once written. Any
-- correction workflow (e.g. manual override by admin) must go through a
-- separate server-side function using the service_role.


-- =============================================================================
-- END OF MIGRATION 002
-- =============================================================================
