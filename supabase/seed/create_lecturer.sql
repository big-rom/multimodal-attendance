-- supabase/seed/create_lecturer.sql
-- 
-- IMPORTANT: Lecturers cannot sign up via the normal signup form because the 
-- database trigger now forces all new signups to have role='student'.
--
-- To create a lecturer:
-- 1. Create a user via Supabase Studio Auth UI (or have them sign up via the app).
-- 2. By default, they will be given the 'student' role.
-- 3. Run this SQL snippet in the Supabase SQL Editor to elevate them to lecturer.
--
-- Replace 'their-uuid-here' with the actual user ID from auth.users.

UPDATE public.profiles
SET 
  role = 'lecturer',
  matric_number = NULL -- Lecturers must not have matric numbers
WHERE id = 'their-uuid-here';

-- Note: Because we removed the UPDATE policy for students, the user could not
-- do this themselves even if they tried sending a malicious API request.
