import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("FRONTEND_URL") ?? "http://localhost:3000",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

serve(async (req) => {
  const ip = req.headers.get("x-forwarded-for") || "unknown";
  if (!checkRateLimit(ip, 20, 60000)) { // 20 req/min
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify caller is admin
    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { 
        status: 401, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    // Check if user is admin in profiles
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profile?.role !== "admin") {
      return new Response(JSON.stringify({ error: "Forbidden: Admins only" }), { 
        status: 403, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    const { email, password, full_name, courses } = await req.json();

    // Create user with admin API
    const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name,
      }
    });

    if (createError) throw createError;

    // Supabase trigger automatically creates the profile, but we need to set the role to 'lecturer'
    await supabase
      .from("profiles")
      .update({ role: "lecturer", full_name })
      .eq("id", newUser.user.id);

    // If courses were provided, assign them to the new lecturer
    if (courses && Array.isArray(courses) && courses.length > 0) {
      const courseInserts = courses.map((c: any) => ({
        course_code: c.course_code.trim().toUpperCase(),
        course_title: c.course_title.trim(),
        lecturer_id: newUser.user.id
      })).filter((c: any) => c.course_code && c.course_title);
      
      if (courseInserts.length > 0) {
        const { error: courseError } = await supabase
          .from("courses")
          .insert(courseInserts);
          
        if (courseError) {
          console.error("Failed to assign courses:", courseError);
          // We don't fail the whole request because the user was created successfully
        }
      }
    }

    return new Response(JSON.stringify({ user: newUser.user }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  }
});
