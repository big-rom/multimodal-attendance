-- Fix infinite recursion in Admin RLS policies by using a SECURITY DEFINER function

-- 1. Create helper function to get role safely without triggering RLS recursion
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

-- 2. Drop the old recursive policies
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins can manage profiles" ON public.profiles;

-- 3. Recreate the policies using the helper function
CREATE POLICY "Admins can view all profiles"
    ON public.profiles
    FOR SELECT
    TO authenticated
    USING (
        public.get_my_role() = 'admin'
    );

CREATE POLICY "Admins can manage profiles"
    ON public.profiles
    FOR ALL
    TO authenticated
    USING (
        public.get_my_role() = 'admin'
    );
