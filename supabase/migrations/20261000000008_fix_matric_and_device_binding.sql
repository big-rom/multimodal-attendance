-- =============================================================================
-- Migration: Relax Matric Format, Support Full Name In Sign-Up, And Fix Device Binding
-- =============================================================================

-- 1. Relax matric number constraint:
-- Allow any three letters (e.g. MEE, CSC, CVE, EEE), a 4-digit year, and 3-digit number.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS chk_matric_format;

ALTER TABLE public.profiles ADD CONSTRAINT chk_matric_format 
CHECK (
    role != 'student' OR 
    (role = 'student' AND matric_number ~* '^[A-Za-z]{3}/\d{4}/\d{3}$')
);

-- 2. Update handle_new_user() trigger function:
-- Prioritize full_name from metadata, or construct from surname/firstname/other_names,
-- before falling back to email prefix.
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
    v_surname := trim(COALESCE(NEW.raw_user_meta_data ->> 'surname', ''));
    v_firstname := trim(COALESCE(NEW.raw_user_meta_data ->> 'firstname', ''));
    v_other_names := trim(COALESCE(NEW.raw_user_meta_data ->> 'other_names', ''));
    v_matric := upper(trim(COALESCE(NEW.raw_user_meta_data ->> 'matric_number', '')));
    
    -- Construct full name: check explicit full_name first, then parts, fallback to email prefix
    v_full_name := trim(COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''));
    IF v_full_name = '' THEN
        v_full_name := concat_ws(' ', NULLIF(v_surname, ''), NULLIF(v_firstname, ''), NULLIF(v_other_names, ''));
    END IF;
    IF v_full_name = '' THEN
        v_full_name := split_part(NEW.email, '@', 1);
    END IF;

    INSERT INTO public.profiles (id, full_name, role, matric_number)
    VALUES (
        NEW.id,
        v_full_name,
        'student', -- ALWAYS hardcoded for auth.users trigger
        NULLIF(v_matric, '')
    );

    RETURN NEW;
END;
$$;

-- Retroactively fix any existing profiles whose full_name was defaulted to email prefix
UPDATE public.profiles p
SET full_name = COALESCE(
    NULLIF(trim(u.raw_user_meta_data ->> 'full_name'), ''),
    concat_ws(' ', NULLIF(trim(u.raw_user_meta_data ->> 'surname'), ''), NULLIF(trim(u.raw_user_meta_data ->> 'firstname'), ''), NULLIF(trim(u.raw_user_meta_data ->> 'other_names'), ''))
)
FROM auth.users u
WHERE p.id = u.id
  AND p.full_name = split_part(u.email, '@', 1)
  AND (
    (u.raw_user_meta_data ->> 'full_name') IS NOT NULL 
    OR (u.raw_user_meta_data ->> 'firstname') IS NOT NULL
  );

-- 3. Device Binding:
-- Allow students to bind their device_id when it is NULL, and provide a secure RPC.
CREATE POLICY "Students can bind device_id"
    ON public.profiles
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = id AND role = 'student' AND (device_id IS NULL OR device_id = ''))
    WITH CHECK (auth.uid() = id AND role = 'student');

CREATE OR REPLACE FUNCTION public.bind_student_device(p_device_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_device text;
  v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role, device_id INTO v_role, v_current_device
  FROM public.profiles
  WHERE id = auth.uid();

  IF v_role != 'student' THEN
    RETURN true;
  END IF;

  -- If no device is bound yet, bind it now
  IF v_current_device IS NULL OR v_current_device = '' THEN
    UPDATE public.profiles
    SET device_id = p_device_id
    WHERE id = auth.uid();
    RETURN true;
  -- If already bound to this exact device, allow
  ELSIF v_current_device = p_device_id THEN
    RETURN true;
  -- Otherwise, account is bound to another device!
  ELSE
    RETURN false;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bind_student_device(text) TO authenticated;
