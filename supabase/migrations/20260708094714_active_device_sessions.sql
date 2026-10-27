CREATE TABLE IF NOT EXISTS public.device_sessions (
  device_id    TEXT        PRIMARY KEY,
  -- The ESP32's unique identifier (its MAC address or a hardcoded 
  -- string in firmware e.g. "ESP32_ROOM_LT1")
  session_id   UUID        REFERENCES public.sessions(id) ON DELETE SET NULL,
  -- The currently active session for this device. NULL means no 
  -- active session — the ESP32 should reject all card taps.
  activated_by UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT valid_device_id CHECK (char_length(device_id) > 0)
);

COMMENT ON TABLE public.device_sessions IS 
  'Maps a physical ESP32 device to its currently active session. 
   Updated by the lecturer dashboard when a session starts or ends. 
   Polled by the ESP32 firmware before processing each card tap.';

-- One row per physical device. Lecturers can update (start/end session).
-- ESP32 reads via service_role (no JWT available on hardware).
ALTER TABLE public.device_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Lecturers can manage device sessions"
  ON public.device_sessions
  FOR ALL TO authenticated
  USING (
    (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'lecturer'
  )
  WITH CHECK (
    (SELECT role FROM public.profiles WHERE id = auth.uid()) = 'lecturer'
  );

-- Index for fast session lookup by the ESP32
CREATE INDEX IF NOT EXISTS idx_device_sessions_session_id
  ON public.device_sessions (session_id);
