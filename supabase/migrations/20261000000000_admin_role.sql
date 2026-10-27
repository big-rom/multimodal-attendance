-- =============================================================================
-- Migration: Admin Role
-- Purpose:   Adds the 'admin' role to user_role enum and sets up RLS policies.
-- =============================================================================

-- 1. Add 'admin' to the role check constraint
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('student', 'lecturer', 'admin'));

-- 2. Helper function to get role safely without triggering RLS recursion
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

-- 3. Allow admins to view all profiles
CREATE POLICY "Admins can view all profiles"
    ON public.profiles
    FOR SELECT
    TO authenticated
    USING (
        public.get_my_role() = 'admin'
    );

-- 4. Allow admins to insert and update profiles
CREATE POLICY "Admins can manage profiles"
    ON public.profiles
    FOR ALL
    TO authenticated
    USING (
        public.get_my_role() = 'admin'
    );
