-- =============================================================================
-- Migration: Admin Profiles with Email
-- Purpose: Allows admins to retrieve profiles with their associated emails.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_profiles_with_email()
RETURNS TABLE (
    id UUID,
    full_name TEXT,
    role TEXT,
    matric_number TEXT,
    created_at TIMESTAMPTZ,
    device_id TEXT,
    email TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT 
        p.id,
        p.full_name,
        p.role,
        p.matric_number,
        p.created_at,
        p.device_id,
        u.email::text
    FROM public.profiles p
    JOIN auth.users u ON p.id = u.id
    WHERE public.get_my_role() = 'admin'
    ORDER BY p.created_at DESC;
$$;
