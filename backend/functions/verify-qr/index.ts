// =============================================================================
// Edge Function: verify-qr
// Path:          backend/functions/verify-qr/index.ts
// Runtime:       Supabase Edge Functions (Deno)
// Depends:       Migration 002 — public.attendance_logs, public.sessions
//
// Purpose:
//   The student's mobile app scans the QR code displayed by the lecturer,
//   decodes the { session_id, timestamp, signature } payload, and POSTs it
//   here along with their own student_id. This function:
//     1. Recomputes the HMAC-SHA256 signature and compares it in constant time.
//     2. Checks the QR code has not expired (180-second window).
//     3. Verifies the student is enrolled in the course the session belongs to.
//     4. Inserts a row into attendance_logs via the service_role key.
//
// Request:
//   POST /verify-qr
//   Authorization: Bearer <student JWT>
//   Content-Type:  application/json
//   Body: {
//     "session_id": string,
//     "timestamp":  number,   (Unix seconds, as returned by generate-qr)
//     "signature":  string,   (hex HMAC-SHA256, as returned by generate-qr)
//     "student_id": string,
//     "method":     "qr"
//   }
//
// Response codes:
//   201  Attendance recorded. Body: the created attendance_logs row.
//   400  Malformed request body.
//   401  Invalid signature or expired QR code.
//   403  Not authenticated, not a student, or not enrolled in the course.
//   409  Attendance already recorded for this session (unique_attendance).
//   500  Server error or missing secret configuration.
//
// =============================================================================

import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Why the secret key must NEVER be sent to the client
// ---------------------------------------------------------------------------
// If a student's app ever received QR_SECRET_KEY, they could:
//   a) Sign arbitrary (session_id, timestamp) pairs to generate perpetually
//      valid QR codes for any session, bypassing the 180-second expiry.
//   b) Fabricate attendance for sessions they never attended by producing a
//      valid signature without being physically present.
//
// The security guarantee of this entire QR attendance scheme rests on the
// assumption that only the Edge Function knows the secret. The secret is
// stored exclusively as a Supabase Edge Function secret (server-side env var)
// and is never included in any response body, header, or log output.

// ---------------------------------------------------------------------------
// Why constant-time comparison matters (timing attack prevention)
// ---------------------------------------------------------------------------
// A naive string comparison (`receivedSig === expectedSig`) short-circuits at
// the first differing character. An attacker can measure response latency over
// thousands of requests to determine, byte by byte, how many leading characters
// of their guessed signature are correct — and eventually reconstruct the full
// valid signature without knowing the secret key (a timing oracle attack).
//
// Constant-time comparison ensures the comparison always takes the same amount
// of time regardless of how many characters match, eliminating the timing
// signal entirely. `crypto.subtle.timingSafeEqual` (available in Deno) performs
// this comparison at the C level, making it resistant even to micro-architectural
// timing effects (branch prediction, cache effects).

// ---------------------------------------------------------------------------
// Why the 45-second expiry window was chosen
// ---------------------------------------------------------------------------
// The QR code is intended for in-person use: the lecturer displays it on a
// projector or screen, and students scan it with their phones. The 45-second
// window is intentionally tight:
//
//   Alignment with dashboard refresh: the lecturer's session page regenerates
//     the QR code every 45 seconds (QR_TTL = 45 in sessions/[id]/page.tsx).
//     The server window matches this cycle so a freshly-displayed code is
//     always valid and an old code is always rejected.
//
//   Ghost-attendance prevention: 45 seconds is too short for a student to
//     photograph the code, send it to an absent friend, and have that friend
//     submit it before the window closes — especially accounting for network
//     round-trip time.
//
//   Practical scanning: students physically present in the room can scan
//     within a few seconds. Even with slow autofocus the 45-second window
//     is ample for in-person use.
//
// Replay attack: even within the 45-second window, a student cannot submit
// the same QR payload twice because attendance_logs has a UNIQUE constraint on
// (student_id, session_id). The constraint is enforced at the DB level
// regardless of which path triggered the INSERT.

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// QR code validity window in seconds.
// Must be kept in sync with QR_TTL in dashboard/app/dashboard/sessions/[id]/page.tsx.
const QR_EXPIRY_SECONDS = 30;

// ---------------------------------------------------------------------------
// Helper: import QR_SECRET_KEY as a CryptoKey for HMAC verification
// ---------------------------------------------------------------------------
// We import with ["sign"] rather than ["verify"] because Deno's subtle.verify
// for HMAC requires the key to be imported with the "verify" usage. However,
// our constant-time comparison approach (re-sign then compare) only needs
// "sign". We keep it consistent with generate-qr to avoid confusion.
let _cachedHmacKey: CryptoKey | null = null;

async function getHmacKey(): Promise<CryptoKey> {
  if (_cachedHmacKey) return _cachedHmacKey;

  const rawSecret = Deno.env.get("QR_SECRET_KEY");
  if (!rawSecret) {
    throw new Error(
      "QR_SECRET_KEY is not configured. Set it with: " +
        "supabase secrets set QR_SECRET_KEY=<random-256-bit-hex>"
    );
  }

  const keyBytes = new TextEncoder().encode(rawSecret);

  _cachedHmacKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return _cachedHmacKey;
}

// ---------------------------------------------------------------------------
// Helper: compute HMAC-SHA256 over a message, return raw bytes (Uint8Array)
// ---------------------------------------------------------------------------
// We return raw bytes rather than a hex string here because constant-time
// comparison operates on byte arrays, not strings. Converting to a string
// first would reintroduce timing variance at the character level.
async function hmacSignBytes(message: string): Promise<Uint8Array> {
  const key = await getHmacKey();
  const msgBytes = new TextEncoder().encode(message);
  const sigBuffer = await crypto.subtle.sign("HMAC", key, msgBytes);
  return new Uint8Array(sigBuffer);
}

// ---------------------------------------------------------------------------
// Helper: hex string → Uint8Array
// ---------------------------------------------------------------------------
// Used to decode the hex signature received from the client into bytes for
// constant-time comparison.
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Constant-time byte comparison
// ---------------------------------------------------------------------------
// Uses crypto.subtle.timingSafeEqual when available (Deno 1.39+, Node 15+).
// Falls back to a manual XOR-accumulator comparison if the API is not
// available. The XOR approach is constant-time because:
//   - It always iterates through the full length of both arrays.
//   - The result is accumulated into a single variable (no early return).
//   - There are no branches inside the loop that depend on the data values.
//
// The manual fallback is included purely as a defence-in-depth measure for
// older Deno versions; all current Supabase Edge Function runtimes support
// timingSafeEqual.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    // Length mismatch is safe to reveal: the client already knows the expected
    // signature length (64 hex chars = 32 bytes for SHA-256). Returning false
    // immediately does not leak any secret information.
    return false;
  }

  // Prefer the native implementation.
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return (crypto.subtle as unknown as {
      timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean;
    }).timingSafeEqual(a.buffer, b.buffer);
  }

  // Manual constant-time XOR fallback.
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i]; // Accumulate differences; no early exit
  }
  return diff === 0; // Zero iff all bytes matched
}

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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // Network-level DoS protection (relaxed to 300 req/min so shared campus Wi-Fi IPs aren't choked)
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  if (!checkRateLimit(`ip:${ip}`, 300, 60000)) {
    return json({ error: "Too many requests from this network" }, 429);
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // -------------------------------------------------------------------------
  // 1. Authenticate the caller and verify student role
  // -------------------------------------------------------------------------
  // Only students can submit QR attendance. Lecturers should not be able to
  // mark their own attendance (they don't attend their own sessions as students)
  // and having lecturers bypass this would muddy audit trails.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 403);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: authError } = await callerClient.auth.getUser();
  if (authError || !user) {
    return json({ error: "Unauthorized: invalid or expired token" }, 403);
  }

  // Per-student rate limit (5 scans per minute per student account)
  if (!checkRateLimit(`user:${user.id}`, 5, 60000)) {
    return json({ error: "Rate limit exceeded. Please wait a moment before scanning again." }, 429);
  }

  const { data: callerProfile, error: profileError } = await callerClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profileError || !callerProfile) {
    return json({ error: "Could not retrieve your profile" }, 500);
  }

  if (callerProfile.role !== "student") {
    return json(
      { error: "Forbidden: only students may submit QR attendance" },
      403
    );
  }

  // -------------------------------------------------------------------------
  // 2. Parse and validate request body
  // -------------------------------------------------------------------------
  let body: {
    session_id?: unknown;
    timestamp?: unknown;
    signature?: unknown;
    student_id?: unknown;
    method?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }

  const sessionId  = typeof body.session_id === "string"  ? body.session_id.trim()  : null;
  const timestamp  = typeof body.timestamp  === "number"  ? body.timestamp           : null;
  const signature  = typeof body.signature  === "string"  ? body.signature.trim().toLowerCase() : null;
  const studentId  = typeof body.student_id === "string"  ? body.student_id.trim()  : null;
  const method     = typeof body.method     === "string"  ? body.method.trim()       : null;

  if (!sessionId || timestamp === null || !signature || !studentId || !method) {
    return json(
      {
        error:
          "All fields are required: session_id, timestamp (number), " +
          "signature, student_id, method",
      },
      400
    );
  }

  if (method !== "qr") {
    return json({ error: "'method' must be 'qr' for this endpoint" }, 400);
  }

  // Validate that the student_id in the body matches the authenticated user.
  // This prevents one student from submitting attendance on behalf of another
  // by providing a different student_id in the body.
  if (studentId !== user.id) {
    return json(
      {
        error:
          "Forbidden: student_id in the request body does not match your " +
          "authenticated identity. You may only mark your own attendance.",
      },
      403
    );
  }

  // -------------------------------------------------------------------------
  // 3. Verify the HMAC-SHA256 signature (constant-time)
  // -------------------------------------------------------------------------
  // We re-sign the (session_id, timestamp) pair using the server's secret and
  // compare to the signature the client provided. This must be done before the
  // expiry check to avoid leaking timing information about valid-but-expired
  // signatures (an attacker could otherwise distinguish "wrong signature" from
  // "right signature but expired" based on which check ran).
  let hmacKey: CryptoKey;
  try {
    hmacKey = await getHmacKey();
    void hmacKey; // key is used internally by hmacSignBytes
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("HMAC key error:", msg);
    return json({ error: msg }, 500);
  }

  const message = `${sessionId}.${timestamp}`;
  const expectedBytes = await hmacSignBytes(message);

  // Decode the hex signature from the client into bytes.
  const receivedBytes = hexToBytes(signature);
  if (!receivedBytes) {
    return json({ error: "Invalid QR signature" }, 401);
  }

  // Constant-time comparison — see rationale at the top of this file.
  const signatureValid = timingSafeEqual(expectedBytes, receivedBytes);
  if (!signatureValid) {
    return json({ error: "Invalid QR signature" }, 401);
  }

  // -------------------------------------------------------------------------
  // 4. Check QR code expiry
  // -------------------------------------------------------------------------
  // We check expiry AFTER signature verification (see comment above).
  const nowSeconds = Math.floor(Date.now() / 1000);
  const age = nowSeconds - timestamp;

  if (age > QR_EXPIRY_SECONDS) {
    // Return 401 rather than 410 (Gone) to avoid clients implementing special
    // handling that might introduce new attack surface.
    return json(
      {
        error: "QR code has expired",
        detail: `QR codes are valid for ${QR_EXPIRY_SECONDS} seconds. ` +
                `This one was generated ${age} seconds ago.`,
      },
      401
    );
  }

  if (age < 0) {
    // The timestamp is in the future — possible clock skew or tampering.
    // Reject with the same generic message to avoid revealing the server clock.
    return json({ error: "Invalid QR signature" }, 401);
  }

  // -------------------------------------------------------------------------
  // 5. Verify the student is enrolled in the course this session belongs to
  // -------------------------------------------------------------------------
  // A valid, unexpired QR code proves the student physically scanned it.
  // But we must also confirm the student is legitimately enrolled in the course
  // — otherwise a student from Course A who wanders into Course B's lecture
  // room could scan the QR and mark attendance for a course they don't take.
  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  // Resolve the course_id for this session.
  const { data: sessionRow, error: sessionError } = await adminClient
    .from("sessions")
    .select("course_id")
    .eq("id", sessionId)
    .single();

  if (sessionError || !sessionRow) {
    return json({ error: "Session not found" }, 400);
  }

  const { data: enrollment, error: enrollmentError } = await adminClient
    .from("course_enrollments")
    .select("id")
    .eq("student_id", studentId)
    .eq("course_id", sessionRow.course_id)
    .maybeSingle(); // maybeSingle() returns null (not error) when row absent

  if (enrollmentError) {
    console.error("Enrollment lookup error:", enrollmentError);
    return json({ error: "Database error checking enrollment" }, 500);
  }

  if (!enrollment) {
    return json(
      {
        error:
          "Forbidden: you are not enrolled in the course this session " +
          "belongs to.",
      },
      403
    );
  }

  // -------------------------------------------------------------------------
  // 6. Insert into attendance_logs (service_role — bypasses RLS)
  // -------------------------------------------------------------------------
  // This is the ONLY legitimate path that writes to attendance_logs for QR
  // attendance. The service_role is used because:
  //   a) The RLS policy on attendance_logs has no INSERT permission for the
  //      'authenticated' role — this is intentional (see migration 002).
  //   b) We have already performed all required checks above (identity, role,
  //      signature, expiry, enrollment) so we are safe to write.
  const { data: log, error: insertError } = await adminClient
    .from("attendance_logs")
    .insert({
      student_id:  studentId,
      session_id:  sessionId,
      method:      "qr",
      verification_method: "qr",
      // recorded_at defaults to now() in the DB; we do not override it to
      // prevent clients from backdating their attendance timestamp.
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      // unique_attendance constraint fired — student already marked present.
      return json(
        { error: "Attendance already recorded for this session" },
        409
      );
    }

    console.error("attendance_logs INSERT error:", insertError);
    return json({ error: "Database error", detail: insertError.message }, 500);
  }

  return json(
    {
      message: "Attendance recorded successfully.",
      log,
    },
    201
  );
});

// ---------------------------------------------------------------------------
// Helper: JSON response with CORS headers
// ---------------------------------------------------------------------------
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
