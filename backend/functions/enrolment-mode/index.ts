import { createClient } from "@supabase/supabase-js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-esp32-api-key",
};

Deno.serve(async (req: Request) => {
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

  let body: { action?: unknown };
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
    const { data, error } = await callerClient
      .from("enrolment_mode_flag")
      .update({
        active: true,
        activated_by: user.id,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
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

  // action === "stop"
  const { data, error } = await callerClient
    .from("enrolment_mode_flag")
    .update({
      active: false,
      activated_by: null,
      expires_at: null,
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

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  const { data: flag, error } = await adminClient
    .from("enrolment_mode_flag")
    .select("*")
    .eq("id", 1)
    .single();

  if (error || !flag) {
    return json({ active: false, expires_at: null }, 200);
  }

  if (flag.active && flag.expires_at) {
    const expiresAt = new Date(flag.expires_at);
    if (expiresAt > new Date()) {
      return json({ active: true, expires_at: flag.expires_at }, 200);
    } else {
      // Auto-expire
      await adminClient
        .from("enrolment_mode_flag")
        .update({ active: false, expires_at: null, activated_by: null })
        .eq("id", 1);
      return json({ active: false, expires_at: null }, 200);
    }
  }

  return json({ active: false, expires_at: null }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
