// =============================================================================
// Edge Function: generate-qr
// Path:          backend/functions/generate-qr/index.ts
// Runtime:       Supabase Edge Functions (Deno)
// Depends:       Migration 002 — public.sessions, public.courses
//
// Purpose:
//   Called by the lecturer's dashboard when they want to display a QR code
//   for students to scan in order to mark their attendance. Returns a signed
//   payload that the frontend encodes into a QR image. The QR code is
//   short-lived (180 seconds) and cryptographically signed so it cannot be
//   forged or replayed.
//
// Request:
//   POST /generate-qr
//   Authorization: Bearer <lecturer JWT>
//   Content-Type:  application/json
//   Body:          { "session_id": string }
//
// Response codes:
//   200  { session_id, timestamp, signature }
//   400  Missing or invalid body
//   403  Not authenticated, not a lecturer, or does not own this session's course
//   500  Server error or missing secret configuration
//
// =============================================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// Why the secret key must NEVER be sent to the client
// ---------------------------------------------------------------------------
// QR_SECRET_KEY is an HMAC signing secret. It lives only in the Edge Function
// environment (set via `supabase secrets set QR_SECRET_KEY=...`) and is never
// included in any API response.
//
// If a client ever received the secret, they could:
//   a) Generate valid QR signatures for any session, past or future, without
//      being a lecturer — bypassing the ownership check entirely.
//   b) Fabricate past timestamps to produce retroactive attendance records.
//   c) Pre-compute future signatures before the session even exists.
//
// The secret's value is in its exclusivity: the Edge Function's signature is
// only trustworthy because only the server can produce it.

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------
function getCorsHeaders(req?: Request) {
  const origin = req?.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": Deno.env.get("FRONTEND_URL") ?? origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// ---------------------------------------------------------------------------
// Helper: import QR_SECRET_KEY as a CryptoKey for HMAC-SHA256
// ---------------------------------------------------------------------------
// We cache the key import to avoid re-deriving on every request invocation
// within the same isolate lifetime.
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
    false,     // not extractable — the raw bytes can never be read back out
               // of the CryptoKey object, even inside this function
    ["sign"]   // this key is for signing only; verify-qr uses a separate key
               // imported with ["verify"] (or re-signs and compares)
  );

  return _cachedHmacKey;
}

// ---------------------------------------------------------------------------
// Helper: compute HMAC-SHA256 signature as a lowercase hex string
// ---------------------------------------------------------------------------
async function hmacSign(message: string): Promise<string> {
  const key = await getHmacKey();
  const msgBytes = new TextEncoder().encode(message);
  const sigBytes = await crypto.subtle.sign("HMAC", key, msgBytes);
  // Convert ArrayBuffer to hex string
  return Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });

  // Rate limit: 30 requests per minute per IP
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  if (!checkRateLimit(ip, 30, 60000)) {
    return json({ error: "Too many requests. Please try again later." }, 429);
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: getCorsHeaders(req) });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // -------------------------------------------------------------------------
  // 1. Authenticate the caller and verify lecturer role
  // -------------------------------------------------------------------------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 403);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Caller-scoped client: used to validate the JWT and read the caller's role
  // through RLS (a user can always read their own profile row).
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
      { error: "Forbidden: only lecturers may generate QR codes" },
      403
    );
  }

  // -------------------------------------------------------------------------
  // 2. Parse and validate request body
  // -------------------------------------------------------------------------
  let body: { session_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }

  const sessionId = typeof body.session_id === "string"
    ? body.session_id.trim()
    : null;

  if (!sessionId) {
    return json({ error: "'session_id' is required" }, 400);
  }

  // -------------------------------------------------------------------------
  // 3. Verify the caller owns the course this session belongs to
  // -------------------------------------------------------------------------
  // We use the service_role client here to avoid needing a bespoke RLS policy
  // for cross-table ownership verification. The security is provided by:
  //   a) The JWT check above (caller is authenticated)
  //   b) The explicit lecturer_id = user.id check below (caller owns the course)
  // The service_role is not bypassing any meaningful security — we are doing
  // the ownership check ourselves in application code, more precisely than
  // any policy could.
  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  const { data: session, error: sessionError } = await adminClient
    .from("sessions")
    .select("id, course_id, courses(lecturer_id)")
    .eq("id", sessionId)
    .single();

  if (sessionError || !session) {
    // Return 403 rather than 404 to avoid leaking whether a session_id exists.
    // An attacker fishing for valid session IDs would get no useful signal.
    return json(
      { error: "Forbidden: session not found or you do not own this course" },
      403
    );
  }

  // Type-narrow the nested join result
  const course = session.courses as { lecturer_id: string } | null;
  if (!course || course.lecturer_id !== user.id) {
    return json(
      { error: "Forbidden: you do not own the course this session belongs to" },
      403
    );
  }

  // -------------------------------------------------------------------------
  // 4. Generate the signed QR payload
  // -------------------------------------------------------------------------
  // Timestamp is Unix seconds (integer). We quantize the timestamp to
  // 30-second windows. This ensures that multiple devices viewing the same
  // session simultaneously will generate the exact same QR code, as long as
  // they request it within the same 30-second window.
  const WINDOW_SIZE = 30;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const timestamp = Math.floor(nowSeconds / WINDOW_SIZE) * WINDOW_SIZE;

  // The message is `session_id.timestamp`. The dot separator is important:
  // it prevents a collision between a session_id that ends with a digit and
  // the timestamp (e.g. "abc1" + "23" ≠ "abc" + "123" when a separator
  // is present).
  const message = `${sessionId}.${timestamp}`;

  let signature: string;
  try {
    signature = await hmacSign(message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("HMAC signing error:", msg);
    return json({ error: msg }, 500);
  }

  // The frontend encodes { session_id, timestamp, signature } as a JSON string,
  // base64-encodes it, and renders that as the QR code content.
  // verify-qr receives this same object (decoded by the student's app).
  return json({ session_id: sessionId, timestamp, signature }, 200);
});

