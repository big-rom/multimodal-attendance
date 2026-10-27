-- =============================================================================
-- Migration: Admin Manage Courses
-- Purpose: Allows admins to view, insert, update, and delete courses.
-- =============================================================================

CREATE POLICY "Admins can manage courses"
    ON public.courses
    FOR ALL
    TO authenticated
    USING (
        public.get_my_role() = 'admin'
    );
