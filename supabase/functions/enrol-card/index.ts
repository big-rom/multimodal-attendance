// =============================================================================
// Edge Function: enrol-card
// Path:          backend/functions/enrol-card/index.ts
// Runtime:       Supabase Edge Functions (Deno)
// Depends:       Migration 004 — public.nfc_cards
//                Migration 006 — enrolment_mode_flag.student_id / .lecturer_id
//
// Purpose:
//   Binds a physical NFC card (identified by its hardware UID as read by the
//   PN532 module) to a student's profile.
//
// Authorization — two accepted paths:
//
//   Path A (dashboard): lecturer JWT via Authorization Bearer header.
//     auth.getUser() resolves to a real user with role = 'lecturer'.
//     registered_by is taken from the verified user.id.
//
//   Path B (ESP32 anon-key): the bearer token is the Supabase anon key, so
//     auth.getUser() returns no real user.  In this case the function looks up
//     the current enrolment_mode_flag row and validates that:
//       • active === true (the enrolment window is open)
//       • the request's student_id and lecturer_id exactly match the stored values
//     If either check fails, 401 is returned.
//     registered_by is set to the lecturer_id stored in the flag row.
//
//   Trust model note (Path B):
//     The enrolment window is only ever opened by an authenticated lecturer
//     session on the dashboard.  The stored student_id / lecturer_id act as a
//     short-lived, single-use capability: the ESP32 can only enrol the exact
//     student the lecturer selected, and only while the time-limited flag is
//     active.  The anon key is not a secret (it is public), but without a
//     matching active flag row the request is rejected, so possession of the
//     anon key alone confers no privilege.
//
// Request:
//   POST /enrol-card
//   Authorization: Bearer <lecturer JWT>  -or-  Bearer <anon key>
//   Content-Type:  application/json
//   Body:          { "uid": string, "student_id": string, "lecturer_id"?: string }
//                  (lecturer_id is required for Path B; ignored on Path A)
//
// Response codes:
//   201  Card successfully registered. Body: the created nfc_cards row.
//   400  Bad request (malformed body, invalid uid format, or student_id does
//        not reference a student profile).
//   401  ESP32 path: enrolment flag is inactive or student_id / lecturer_id
//        do not match the stored values.
//   403  Caller is not authenticated as a lecturer (Path A rejection).
//   409  Duplicate — either the card UID is already registered to someone else,
//        or the student already has a different card. Body explains which.
//   500  Unexpected server error.
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// UID normalisation
// ---------------------------------------------------------------------------
// The PN532 module may return a UID in various formats depending on the
// firmware/library: raw hex ("a3f02c11"), spaced hex ("A3 F0 2C 11"), or
// already colon-separated ("A3:F0:2C:11"). We normalise to the canonical
// UPPERCASE colon-separated form before any database operation so that the
// same physical card always maps to the same string in the database regardless
// of which firmware version or library produced the reading.
//
// Valid inputs: any mix of hex chars optionally separated by colons, spaces,
// or dashes, in any case, with a total byte count of 4 or 7 (ISO 14443A).
export function normalizeUid(raw: string): string | null {
  // Strip all separators and whitespace, then uppercase.
  const stripped = raw.replace(/[:\s\-]/g, "").toUpperCase();

  // A UID must be 4 bytes (8 hex chars) or 7 bytes (14 hex chars).
  // Reject anything that isn't valid hex or the wrong length.
  if (!/^[0-9A-F]+$/.test(stripped)) return null;
  if (stripped.length !== 8 && stripped.length !== 14) return null;

  // Reinsert colons every 2 characters: "A3F02C11" → "A3:F0:2C:11"
  return stripped.match(/.{2}/g)!.join(":");
}

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------
// Supabase Edge Functions require explicit CORS headers when called from a
// browser client. The OPTIONS pre-flight must also be handled.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": Deno.env.get("FRONTEND_URL") ?? "http://localhost:3000",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-device-key",
};

// ---------------------------------------------------------------------------
// Rate limiting — in-memory sliding window
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  // Rate limit: 20 requests per minute per IP
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  if (!checkRateLimit(ip, 20, 60000)) {
    return new Response(JSON.stringify({ error: "Too many requests. Please try again later." }), {
      status: 429,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Handle CORS pre-flight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // -------------------------------------------------------------------------
  // 1. Parse and validate request body
  // -------------------------------------------------------------------------
  let body: { uid?: unknown; student_id?: unknown; lecturer_id?: unknown; device_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }

  const rawUid = typeof body.uid === "string" ? body.uid.trim() : null;
  const studentId = typeof body.student_id === "string" ? body.student_id.trim() : null;
  const targetDeviceId = typeof body.device_id === "string" && body.device_id.trim()
    ? body.device_id.trim()
    : "esp32-node-1";

  if (!rawUid || !studentId) {
    return json({ error: "Both 'uid' and 'student_id' are required" }, 400);
  }

  // Normalise the UID. Reject malformed values before hitting the database.
  const uid = normalizeUid(rawUid);
  if (!uid) {
    return json(
      {
        error:
          "Invalid uid format. Expected 4-byte or 7-byte NFC UID as hex " +
          '(e.g. "A3:F0:2C:11" or "a3f02c11").',
      },
      400
    );
  }

  // -------------------------------------------------------------------------
  // 2. Build Supabase clients
  // -------------------------------------------------------------------------
  // We use the caller's JWT (forwarded from the Authorization header) to
  // create a client that respects RLS and lets us read the caller's profile.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 403);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Caller-scoped client: operates within the caller's RLS context.
  // Used only for identity checks (reading the caller's profile) on Path A.
  const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  // Service-role client: bypasses RLS for the actual INSERT and for reading
  // the student profile. We use service_role here rather than the caller's JWT
  // because:
  //   a) It lets us read the student's profile row without needing a specific
  //      RLS policy for "lecturers can read student profiles for validation".
  //   b) It lets us INSERT into nfc_cards unconditionally after we have already
  //      performed our own role checks above, avoiding a round-trip RLS
  //      evaluation for a check we've already done.
  //   c) Most importantly, it lets us inspect the PostgreSQL error detail to
  //      distinguish WHICH unique constraint was violated — something we cannot
  //      do cleanly if the INSERT is rejected before reaching our code.
  //   d) It is also used on Path B to read enrolment_mode_flag without relying
  //      on RLS policies that require an authenticated session.
  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  // -------------------------------------------------------------------------
  // 3. Authorization — determine which path applies
  // -------------------------------------------------------------------------
  // Try Path A first: resolve the bearer token as a user JWT.
  const { data: { user }, error: authError } = await callerClient.auth.getUser();

  // verified lecturer UUID; set by whichever auth path succeeds.
  let verifiedLecturerId: string;

  if (!authError && user) {
    // -----------------------------------------------------------------------
    // PATH A: caller has a valid user JWT — verify they are a lecturer
    // -----------------------------------------------------------------------
    // Read the caller's profile from the database to check their role.
    // We use the callerClient here so RLS applies — a caller can always read
    // their own profile (Policy 1 from migration 001).
    const { data: callerProfile, error: profileError } = await callerClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profileError || !callerProfile) {
      return json({ error: "Could not retrieve your profile" }, 500);
    }

    if (callerProfile.role !== "lecturer") {
      // Students and unauthenticated callers are rejected here.
      // We return 403, not 401, because the caller IS authenticated — they
      // just lack the required role.
      return json(
        { error: "Forbidden: only lecturers may register NFC cards" },
        403
      );
    }

    verifiedLecturerId = user.id;
  } else {
    // -----------------------------------------------------------------------
    // PATH B: no valid user JWT (bearer token is the anon key, as sent by the
    // ESP32).  Validate device credentials and the active enrolment_mode_flag row.
    // -----------------------------------------------------------------------
    const configuredDeviceKey = Deno.env.get("DEVICE_API_KEY");
    const providedDeviceKey = req.headers.get("x-device-key");

    if (!configuredDeviceKey || !providedDeviceKey || providedDeviceKey !== configuredDeviceKey) {
      return json(
        { error: "Unauthorized: invalid or missing device credentials (x-device-key)" },
        401
      );
    }

    const { data: flag, error: flagError } = await adminClient
      .from("enrolment_mode_flag")
      .select("active, expires_at, student_id, lecturer_id")
      .eq("id", 1)
      .single();

    if (flagError || !flag || !flag.active) {
      return json({ error: "Unauthorized: enrolment mode is not active" }, 401);
    }

    // Check expiry
    if (flag.expires_at && new Date(flag.expires_at) <= new Date()) {
      return json({ error: "Unauthorized: enrolment mode has expired" }, 401);
    }

    // Extract lecturer_id from the request body (required for Path B).
    const bodyLecturerId = typeof body.lecturer_id === "string" ? body.lecturer_id.trim() : null;

    // Validate that the request's student_id and lecturer_id exactly match
    // the values stored in the flag at the time the lecturer opened the window.
    if (!bodyLecturerId || !flag.lecturer_id || !flag.student_id) {
      return json({ error: "Unauthorized: enrolment target fields are missing or not set" }, 401);
    }
    if (studentId !== flag.student_id || bodyLecturerId !== flag.lecturer_id) {
      return json(
        { error: "Unauthorized: student_id or lecturer_id does not match the active enrolment session" },
        401
      );
    }

    // All checks passed. Use the stored lecturer_id as the registered_by value
    // (the lecturer who opened the window is the authoritative registrar).
    verifiedLecturerId = flag.lecturer_id;
  }

  // -------------------------------------------------------------------------
  // 4. Verify the target student_id references an actual student profile
  // -------------------------------------------------------------------------
  // This check prevents a lecturer from accidentally linking a card to:
  //   - A non-existent UUID (would fail with FK violation anyway, but this
  //     gives a cleaner error message)
  //   - Another lecturer's profile (the CHECK constraint in the DB would allow
  //     it since nfc_cards has no role restriction on student_id at the column
  //     level — the role enforcement lives here in the function)
  const { data: studentProfile, error: studentError } = await adminClient
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", studentId)
    .single();

  if (studentError || !studentProfile) {
    return json(
      { error: "student_id does not match any existing profile" },
      400
    );
  }

  if (studentProfile.role !== "student") {
    return json(
      { error: "student_id must reference a profile with role = 'student'" },
      400
    );
  }

  // -------------------------------------------------------------------------
  // 4.5. Verify student has pending or approved enrollment with this lecturer
  // -------------------------------------------------------------------------
  const { data: enrollmentCheck, error: checkError } = await adminClient
    .from("course_enrollments")
    .select("id, courses!inner(lecturer_id)")
    .eq("student_id", studentId)
    .eq("courses.lecturer_id", verifiedLecturerId)
    .in("status", ["pending", "approved"])
    .limit(1)
    .maybeSingle();

  if (checkError) {
    console.error("enrollment check error:", checkError);
    return json({ error: "Database error checking enrollment" }, 500);
  }

  if (!enrollmentCheck) {
    const errMsg = `Cannot enrol card: ${studentProfile.full_name} is not enrolled in any of your courses.`;
    await adminClient.from("device_events").insert({
      device_id: targetDeviceId,
      event_type: "enrol_error",
      status: "error",
      message: errMsg,
      payload: { uid, student_id: studentId, error: "not_enrolled" },
    });
    return json(
      {
        error: "not_enrolled",
        message: errMsg,
      },
      403
    );
  }

  // -------------------------------------------------------------------------
  // 5. Attempt the INSERT into nfc_cards
  // -------------------------------------------------------------------------
  // Delete any existing card for this student first to avoid student_id unique 
  // constraint errors (essentially an upsert on student_id).
  const { error: deleteError } = await adminClient
    .from("nfc_cards")
    .delete()
    .eq("student_id", studentId);
    
  if (deleteError) {
    console.error("error deleting old card:", deleteError);
    return json({ error: "Database error preparing registration" }, 500);
  }

  const { data: newCard, error: insertError } = await adminClient
    .from("nfc_cards")
    .insert({
      uid,                               // normalised canonical form
      student_id: studentId,
      registered_by: verifiedLecturerId, // verified lecturer's id (from JWT or flag)
    })
    .select()
    .single();

  if (insertError) {
    // Postgres error 23505 = unique_violation.
    if (insertError.code === "23505") {
      const detail = insertError.details ?? insertError.message ?? "";

      if (detail.includes("(uid)")) {
        // Query who currently owns this card to provide rich feedback on the dashboard
        const { data: existingCard } = await adminClient
          .from("nfc_cards")
          .select("student_id, profiles(id, full_name, matric_number)")
          .eq("uid", uid)
          .maybeSingle();

        const existingStudent = existingCard?.profiles as any;
        const studentDesc = existingStudent
          ? `${existingStudent.full_name} (${existingStudent.matric_number ?? "No matric"})`
          : "another student";

        const errorMessage = `This card is already registered to ${studentDesc}.`;

        await adminClient.from("device_events").insert({
          device_id: targetDeviceId,
          event_type: "enrol_error",
          status: "error",
          message: errorMessage,
          payload: {
            uid,
            conflict_type: "uid_registered",
            target_student_id: studentId,
            existing_student_id: existingStudent?.id,
            existing_student_name: existingStudent?.full_name,
            existing_matric_number: existingStudent?.matric_number,
          },
        });

        return json(
          {
            error: errorMessage,
            detail: `Card already exists in nfc_cards.`,
            existing_student: existingStudent,
          },
          409
        );
      }

      // student_id collision should no longer happen due to the DELETE above,
      // but kept for safety.
      if (detail.includes("(student_id)")) {
        return json(
          {
            error: "This student already has a card registered.",
          },
          409
        );
      }

      return json({ error: "Duplicate entry", detail }, 409);
    }

    // Any other database error (FK violation, network, etc.)
    console.error("nfc_cards INSERT error:", insertError);
    return json({ error: "Database error", detail: insertError.message }, 500);
  }

  // -------------------------------------------------------------------------
  // 6. Success
  // -------------------------------------------------------------------------
  const successMessage = `Card successfully registered to ${studentProfile.full_name}.`;
  await adminClient.from("device_events").insert({
    device_id: targetDeviceId,
    event_type: "enrol_success",
    status: "success",
    message: successMessage,
    payload: {
      uid,
      student_id: studentId,
      student_name: studentProfile.full_name,
      matric_number: studentProfile.matric_number,
    },
  });

  return json(
    {
      message: successMessage,
      card: newCard,
    },
    201
  );
});

// ---------------------------------------------------------------------------
// Helper: produce a JSON Response with CORS headers
// ---------------------------------------------------------------------------
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
