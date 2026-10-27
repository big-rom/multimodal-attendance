import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": Deno.env.get("FRONTEND_URL") ?? "http://localhost:3000",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-esp32-api-key",
};

const rateLimitCache = new Map<string, number[]>();
function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const requests = rateLimitCache.get(key) || [];
  const validRequests = requests.filter((time) => now - time < windowMs);
  if (validRequests.length >= limit) return false;
  validRequests.push(now);
  rateLimitCache.set(key, validRequests);
  return true;
}

Deno.serve(async (req: Request) => {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  if (!checkRateLimit(ip, 30, 60000)) { // 30 req/min
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname.endsWith("/status")) {
    return handleStatusGet(req);
  }

  if (req.method === "POST") {
    return handlePost(req);
  }

  return json({ error: "Not found" }, 404);
});

async function handlePost(req: Request): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 403);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  
  const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: authError } = await callerClient.auth.getUser();

  if (authError || !user) {
    return json({ error: "Unauthorized: invalid or expired token" }, 403);
  }

  const { data: profile, error: profileError } = await callerClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profileError || !profile || profile.role !== "lecturer") {
    return json({ error: "Forbidden: only lecturers may control enrolment mode" }, 403);
  }

  let body: { action?: unknown; student_id?: unknown; lecturer_id?: unknown; device_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }

  const action = body.action;
  if (action !== "start" && action !== "stop") {
    return json({ error: "action must be either 'start' or 'stop'" }, 400);
  }

  if (action === "start") {
    // Guard: a hardware node cannot be in both ENROL_MODE and ATTEND_MODE
    // simultaneously. If the device currently has an active session, reject
    // the activation request so the lecturer sees a clear error on the
    // dashboard rather than silently corrupting the session state.
    //
    // device_id defaults to the firmware constant; the dashboard may pass it
    // explicitly in the POST body in future to support multi-device setups.
    const targetDeviceId =
      typeof body.device_id === "string" && body.device_id.trim()
        ? body.device_id.trim()
        : "esp32-node-1";

    // Use the service role key for this read -- the caller's RLS policy
    // on device_sessions allows lecturers to read, but the anon+JWT path
    // used by callerClient may not have a row to see if RLS is restrictive.
    // Using the admin client here is safe: the check is read-only and the
    // write that follows it is already guarded by the lecturer role check above.
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: deviceRow } = await adminClient
      .from("device_sessions")
      .select("session_id")
      .eq("device_id", targetDeviceId)
      .maybeSingle();

    if (deviceRow?.session_id) {
      return json(
        {
          error:
            "Cannot activate enrolment mode: a session is currently active on this device. " +
            "End the session first, then activate enrolment mode.",
          active_session_id: deviceRow.session_id,
        },
        409,
      );
    }

    // Accept optional student_id and lecturer_id supplied by the dashboard so
    // the ESP32 can enrol the exact student the lecturer selected without
    // needing to forward a lecturer JWT itself.
    const studentId = typeof body.student_id === "string" ? body.student_id.trim() || null : null;
    const lecturerId = typeof body.lecturer_id === "string" ? body.lecturer_id.trim() || null : null;

    const { data, error } = await callerClient
      .from("enrolment_mode_flag")
      .update({
        active: true,
        activated_by: user.id,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        student_id: studentId,
        lecturer_id: lecturerId,
      })
      .eq("id", 1)
      .select()
      .single();

    if (error) {
      console.error("Error starting enrolment mode:", error);
      return json({ error: "Failed to start enrolment mode" }, 500);
    }
    return json(data, 200);
  }

  // action === "stop": clear student_id and lecturer_id alongside the flag.
  const { data, error } = await callerClient
    .from("enrolment_mode_flag")
    .update({
      active: false,
      activated_by: null,
      expires_at: null,
      student_id: null,
      lecturer_id: null,
    })
    .eq("id", 1)
    .select()
    .single();

  if (error) {
    console.error("Error stopping enrolment mode:", error);
    return json({ error: "Failed to stop enrolment mode" }, 500);
  }

  return json(data, 200);
}

async function handleStatusGet(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const url = new URL(req.url);
  const deviceId = url.searchParams.get("device_id") || "esp32-node-1";

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  // Query enrolment flag and device session in parallel for efficiency.
  const [flagResult, deviceResult] = await Promise.all([
    adminClient
      .from("enrolment_mode_flag")
      .select("*")
      .eq("id", 1)
      .single(),
    adminClient
      .from("device_sessions")
      .select("session_id")
      .eq("device_id", deviceId)
      .maybeSingle(),
  ]);

  const { data: flag, error } = flagResult;
  // session_id is null if no row exists or the column value is null.
  const activeSessionId: string | null = deviceResult.data?.session_id ?? null;

  // ---------------------------------------------------------------------------
  // Heartbeat upsert: record that this device is alive and what mode it is in.
  // This piggybacks on the existing 8-second poll so no separate heartbeat
  // endpoint is needed. The mode is derived from the flag we just read.
  //
  // We do NOT await this -- it is best-effort. A failed upsert should never
  // block the ESP32 from receiving its mode/session response.
  //
  // RLS note: adminClient uses the service_role key and bypasses RLS, which
  // is intentional here -- the ESP32 has no JWT, and the heartbeat write is
  // initiated by the trusted server-side edge function, not by the client.
  // ---------------------------------------------------------------------------
  const currentModeValue =
    flag?.active && flag?.expires_at && new Date(flag.expires_at) > new Date()
      ? "enrol"
      : "attend";

  adminClient
    .from("device_sessions")
    .upsert(
      { device_id: deviceId, last_seen: new Date().toISOString(), current_mode: currentModeValue },
      { onConflict: "device_id", ignoreDuplicates: false },
    )
    .then(({ error: upsertErr }) => {
      if (upsertErr) {
        console.warn("[heartbeat] upsert failed for device", deviceId, upsertErr.message);
      }
    });

  if (error || !flag) {
    return json({ active: false, expires_at: null, student_id: null, lecturer_id: null, session_id: activeSessionId }, 200);
  }

  if (flag.active && flag.expires_at) {
    const expiresAt = new Date(flag.expires_at);
    if (expiresAt > new Date()) {
      // Active and not yet expired: include the enrolment target fields so the
      // ESP32 knows which student/lecturer to embed in its enrol-card POST,
      // and the session_id so it knows where to record attendance taps.
      return json({
        active: true,
        expires_at: flag.expires_at,
        student_id: flag.student_id ?? null,
        lecturer_id: flag.lecturer_id ?? null,
        session_id: activeSessionId,
      }, 200);
    } else {
      // Auto-expire: clear all fields including student/lecturer target.
      await adminClient
        .from("enrolment_mode_flag")
        .update({ active: false, expires_at: null, activated_by: null, student_id: null, lecturer_id: null })
        .eq("id", 1);
      return json({ active: false, expires_at: null, student_id: null, lecturer_id: null, session_id: activeSessionId }, 200);
    }
  }

  return json({ active: false, expires_at: null, student_id: null, lecturer_id: null, session_id: activeSessionId }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
