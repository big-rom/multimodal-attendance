// =============================================================================
// Edge Function: record-nfc-tap
// Path:          backend/functions/record-nfc-tap/index.ts
// Runtime:       Supabase Edge Functions (Deno)
// Depends:       Migration 002 — public.sessions, public.course_enrollments,
//                               public.attendance_logs
//                Migration 004 — public.nfc_cards
//                Migration 20260709 — attendance_logs.verification_method
//
// Purpose:
//   Converts a physical NFC card tap into an attendance_logs row.
//   This is the only legitimate write path for NFC-based attendance — the
//   attendance_logs table blocks all direct INSERT from authenticated clients
//   via RLS; only service_role (used here) may write.
//
//   Two hardware/software channels call this function and are distinguished
//   by the `source` field in the request body:
//
//     "esp32_nfc" — A physical ESP32 device with an RFID reader module has
//       read a student's NFC card. The device authenticates using the
//       SUPABASE_SERVICE_ROLE_KEY (same key it uses to read device_sessions).
//       Because service_role keys are not user JWTs, auth.getUser() will fail;
//       we detect this case and trust the request when source = "esp32_nfc".
//
//     "web_nfc"   — The lecturer's dashboard is using the browser Web NFC API
//       as an emergency fallback reader. The caller authenticates with the
//       lecturer's own JWT and must have role = "lecturer".
//
// Request:
//   POST /record-nfc-tap
//   Authorization: Bearer <lecturer JWT>  (web_nfc)
//                  Bearer <service_role_key> (esp32_nfc)
//   Content-Type:  application/json
//   Body: {
//     "uid":        string,   raw NFC UID (any format; normalised internally)
//     "session_id": string,   UUID of the session to mark attendance for
//     "source":     "esp32_nfc" | "web_nfc"
//   }
//
// Response codes:
//   201  Attendance recorded.
//        Body: { message, log: <attendance_logs row> }
//   400  Malformed body, invalid uid format, or invalid source value.
//   401  Session has already ended (ends_at is not null).
//   403  Not authenticated, wrong role (web_nfc), or student not enrolled.
//   404  NFC card UID not found in nfc_cards (card not registered).
//   409  Attendance already recorded for this student+session combination.
//   500  Server error or missing secret configuration.
//
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-device-key",
};

// ---------------------------------------------------------------------------
// UID normalisation
// ---------------------------------------------------------------------------
// Reused from enrol-card: the PN532 module may return UIDs in various formats.
// We normalise to UPPERCASE colon-separated hex before any DB lookup so that
// "a3f02c11", "A3 F0 2C 11", and "A3:F0:2C:11" all resolve to "A3:F0:2C:11".
//
// Why normalise here and not only in enrol-card?
//   - The ESP32 firmware may ship different UID formatting across versions.
//   - Consistent normalisation in both write paths ensures that a card
//     enrolled as "A3:F0:2C:11" will always be found at attendance time
//     regardless of how the hardware formats the same bytes.
function normalizeUid(raw: string): string | null {
  const stripped = raw.replace(/[:\s\-]/g, "").toUpperCase();
  if (!/^[0-9A-F]+$/.test(stripped)) return null;
  if (stripped.length !== 8 && stripped.length !== 14) return null;
  return stripped.match(/.{2}/g)!.join(":");
}

// ---------------------------------------------------------------------------
// Helper: JSON response with CORS headers
// ---------------------------------------------------------------------------
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  // -------------------------------------------------------------------------
  // CORS pre-flight
  // -------------------------------------------------------------------------
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // -------------------------------------------------------------------------
  // 1. Parse and validate request body
  // -------------------------------------------------------------------------
  let body: { uid?: unknown; session_id?: unknown; source?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }

  const rawUid    = typeof body.uid        === "string" ? body.uid.trim()        : null;
  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : null;
  const source    = typeof body.source     === "string" ? body.source.trim()     : null;

  if (!rawUid || !sessionId || !source) {
    return json(
      { error: "All fields are required: uid (string), session_id (string), source (string)" },
      400
    );
  }

  // Validate source before doing anything else — reject unknown callers early.
  // The allowed values map 1-to-1 to the verification_method CHECK constraint
  // added in migration 20260709165807.
  if (source !== "esp32_nfc" && source !== "web_nfc") {
    return json(
      {
        error: "Invalid source value. Must be exactly \"esp32_nfc\" or \"web_nfc\".",
        allowed: ["esp32_nfc", "web_nfc"],
      },
      400
    );
  }

  // Normalise the UID. Reject malformed values before any database round-trip.
  const uid = normalizeUid(rawUid);
  if (!uid) {
    return json(
      {
        error:
          "Invalid uid format. Expected a 4-byte or 7-byte NFC UID as hex " +
          '(e.g. "A3:F0:2C:11" or "a3f02c11").',
      },
      400
    );
  }

  // -------------------------------------------------------------------------
  // 2. Authenticate the caller
  // -------------------------------------------------------------------------
  // Auth model differs by source:
  //
  //   "web_nfc"   — The lecturer's browser sends their own user JWT.
  //                 We validate it with auth.getUser() and enforce role = lecturer.
  //
  //   "esp32_nfc" — The ESP32 authenticates with the SUPABASE_SERVICE_ROLE_KEY
  //                 (same credential it already uses to read device_sessions).
  //                 Service-role tokens are not user JWTs; auth.getUser() will
  //                 return an error. We detect this case and allow the request
  //                 to proceed — the security guarantee for esp32_nfc comes from
  //                 the UID → nfc_cards lookup (step 3), enrollment check (step 5),
  //                 and the unique constraint on attendance_logs (step 6), not
  //                 from caller identity.
  //
  // Why not a separate secret for the ESP32?
  //   The ESP32 already holds the service_role key to poll device_sessions.
  //   Introducing a third credential would require firmware changes and adds no
  //   meaningful security improvement — the service_role key is already the
  //   highest-privilege credential in the system.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 403);
  }

  const supabaseUrl            = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey        = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Admin client — used for ALL privileged reads and the final INSERT.
  // All security checks are performed in application code before this client writes.
  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  if (source === "web_nfc") {
    // -----------------------------------------------------------------------
    // web_nfc path: require a valid lecturer JWT
    // -----------------------------------------------------------------------
    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: { user }, error: authError } = await callerClient.auth.getUser();
    if (authError || !user) {
      return json({ error: "Unauthorized: invalid or expired token" }, 403);
    }

    const { data: callerProfile, error: profileError } = await callerClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profileError || !callerProfile) {
      return json({ error: "Could not retrieve your profile" }, 500);
    }

    if (callerProfile.role !== "lecturer") {
      return json(
        {
          error:
            "Forbidden: web_nfc attendance may only be submitted by a lecturer " +
            "operating the dashboard reader.",
        },
        403
      );
    }
    // Caller verified as lecturer — fall through to the shared checks below.

  } else {
    // -----------------------------------------------------------------------
    // esp32_nfc path: verify device authentication
    // -----------------------------------------------------------------------
    // The hardware node sends its pre-shared device secret via x-device-key header.
    // This provides machine-level authentication without requiring NTP clock sync
    // on the ESP32.
    const configuredDeviceKey = Deno.env.get("DEVICE_API_KEY");
    const providedDeviceKey = req.headers.get("x-device-key");

    if (!configuredDeviceKey || !providedDeviceKey || providedDeviceKey !== configuredDeviceKey) {
      return json(
        { error: "Unauthorized: invalid or missing device credentials (x-device-key)" },
        401
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. Resolve uid → student_id via nfc_cards
  // -------------------------------------------------------------------------
  // The nfc_cards table is the binding between a physical card UID and a
  // student profile. We look up the normalised UID here. Not-found means the
  // card has not been enrolled via the enrol-card function — the tap should
  // be ignored and the device should signal an error to the student.
  const { data: cardRow, error: cardError } = await adminClient
    .from("nfc_cards")
    .select("student_id")
    .eq("uid", uid)
    .maybeSingle();

  if (cardError) {
    console.error("nfc_cards lookup error:", cardError);
    return json({ error: "Database error looking up card" }, 500);
  }

  if (!cardRow) {
    // Return 404, not 400: the request is structurally valid but the card
    // simply has no registration in the system. The calling device can use
    // this to play an "unknown card" beep/LED pattern.
    return json(
      {
        error: "Card not registered.",
        detail: `No nfc_cards row found for UID ${uid}.`,
      },
      404
    );
  }

  const studentId = cardRow.student_id;

  // -------------------------------------------------------------------------
  // 4. Confirm the session is currently active (ends_at IS NULL)
  // -------------------------------------------------------------------------
  // A session is considered active while its ends_at column is NULL.
  // The lecturer closes the session (sets ends_at) from the dashboard.
  // Accepting attendance for a closed session would:
  //   a) Allow a student to submit late after they left early.
  //   b) Skew the eligibility_percentage trigger (migration 003), which counts
  //      attended sessions vs total sessions in the date range.
  //
  // We return 401 (not 403 or 404) to clearly distinguish "session not active"
  // from "not authenticated" and "not enrolled". The ESP32 can use this status
  // to play a "session closed" signal.
  const { data: sessionRow, error: sessionError } = await adminClient
    .from("sessions")
    .select("id, course_id, ends_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError) {
    console.error("sessions lookup error:", sessionError);
    return json({ error: "Database error looking up session" }, 500);
  }

  if (!sessionRow) {
    return json({ error: "Session not found." }, 400);
  }

  if (sessionRow.ends_at !== null) {
    return json(
      {
        error: "Session not active.",
        detail: `Session ${sessionId} ended at ${sessionRow.ends_at}. ` +
                "Attendance can only be recorded during an open session.",
      },
      401
    );
  }

  // -------------------------------------------------------------------------
  // 5. Confirm the student is enrolled in the session's course
  // -------------------------------------------------------------------------
  // A registered card proves the student is in the system. Enrollment confirms
  // they are legitimately registered for THIS specific course. Without this
  // check, a student could tap their card at any active session across the
  // university and mark attendance for courses they don't take.
  const { data: enrollmentRow, error: enrollmentError } = await adminClient
    .from("course_enrollments")
    .select("id")
    .eq("student_id", studentId)
    .eq("course_id", sessionRow.course_id)
    .maybeSingle();

  if (enrollmentError) {
    console.error("enrollment lookup error:", enrollmentError);
    return json({ error: "Database error checking enrollment" }, 500);
  }

  if (!enrollmentRow) {
    return json(
      {
        error:
          "Forbidden: the student linked to this card is not enrolled in " +
          "the course this session belongs to.",
        detail: `student_id ${studentId} has no enrollment for course_id ${sessionRow.course_id}.`,
      },
      403
    );
  }

  // -------------------------------------------------------------------------
  // 6. Insert into attendance_logs
  // -------------------------------------------------------------------------
  // Both `method` and `verification_method` must be set:
  //   • `method`              — legacy coarse column ('nfc' for both NFC sources)
  //   • `verification_method` — fine-grained channel; set to the source value
  //                             passed in the request body ("esp32_nfc" or "web_nfc")
  //
  // recorded_at is intentionally left to DEFAULT now() — we do not allow the
  // device or the browser to supply a timestamp. Accepting a client-supplied
  // timestamp would allow backdating attendance records.
  //
  // The unique_attendance constraint on (student_id, session_id) means that
  // if the student has already been marked present for this session via ANY
  // method (another NFC tap, a QR scan), the INSERT raises error 23505.
  const { data: log, error: insertError } = await adminClient
    .from("attendance_logs")
    .insert({
      student_id:           studentId,
      session_id:           sessionId,
      method:               "nfc",          // coarse; both NFC sources share this value
      verification_method:  source,          // "esp32_nfc" or "web_nfc"
      // recorded_at: omitted — defaults to now() in the DB
    })
    .select()
    .single();

  if (insertError) {
    // -----------------------------------------------------------------------
    // 23505 = unique_violation
    // -----------------------------------------------------------------------
    // The unique_attendance constraint on (student_id, session_id) fired.
    // This student has already been marked present for this session via some
    // method. We return 409 rather than letting the raw Postgres error propagate.
    //
    // Note: the constraint intentionally covers both NFC and QR — if the
    // student scanned a QR code earlier in the same session they cannot also
    // tap their card to create a second record. Presence is binary.
    if (insertError.code === "23505") {
      return json(
        {
          error: "Already marked present.",
          detail:
            "This student has already been recorded as attending this session. " +
            "The unique constraint on (student_id, session_id) prevents duplicates " +
            "regardless of the verification method used.",
        },
        409
      );
    }

    // -----------------------------------------------------------------------
    // 23514 = check_violation (unexpected — only if migration applied wrong)
    // -----------------------------------------------------------------------
    if (insertError.code === "23514") {
      console.error("CHECK constraint violation on attendance_logs INSERT:", insertError);
      return json(
        {
          error: "Internal error: CHECK constraint violation.",
          detail:
            "This likely means the verification_method value does not match " +
            "the chk_verification_method_values constraint. " +
            "Verify that source matches the allowed values.",
        },
        500
      );
    }

    // All other errors (FK violation, network, etc.)
    console.error("attendance_logs INSERT error:", insertError);
    return json({ error: "Database error", detail: insertError.message }, 500);
  }

  // -------------------------------------------------------------------------
  // 7. Success
  // -------------------------------------------------------------------------
  return json(
    {
      message: "Attendance recorded successfully.",
      log,
    },
    201
  );
});
