-- Fix infinite recursion in profiles RLS policy

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

DROP POLICY IF EXISTS "Lecturers can view all student profiles" ON public.profiles;

CREATE POLICY "Lecturers can view all student profiles"
    ON public.profiles
    FOR SELECT
    TO authenticated
    USING (
        public.get_my_role() = 'lecturer'
        AND role = 'student'
    );
