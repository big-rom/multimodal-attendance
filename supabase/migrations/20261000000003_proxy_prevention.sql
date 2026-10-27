-- Add device_id to profiles
ALTER TABLE public.profiles
ADD COLUMN device_id text;

-- Add location coordinates to sessions
ALTER TABLE public.sessions
ADD COLUMN latitude double precision,
ADD COLUMN longitude double precision;

-- Prevent students from unbinding their devices via client
CREATE OR REPLACE FUNCTION public.prevent_device_unbinding()
RETURNS trigger AS $$
BEGIN
  IF OLD.device_id IS NOT NULL AND NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    -- If they are resetting to NULL, only allow if they are admin/lecturer
    IF public.get_my_role() = 'student' THEN
      RAISE EXCEPTION 'Students cannot unbind or change their device_id.';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER check_device_unbinding
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.prevent_device_unbinding();
