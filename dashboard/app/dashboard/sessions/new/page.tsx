import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { StartSessionForm } from "./StartSessionForm";

interface Props {
  searchParams: Promise<{ course_id?: string }>;
}

export default async function NewSessionPage({ searchParams }: Props) {
  const resolvedParams = await searchParams;
  const course_id = resolvedParams?.course_id;

  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  // 1. Verify caller is authenticated
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // 2. Validate course_id parameter
  if (!course_id) {
    return (
      <div className="max-w-md mx-auto py-12">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm text-center">
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-slate-900 mb-2">No Course Selected</h1>
          <p className="text-slate-500 text-sm mb-6">
            To start an attendance session, please select a course from your dashboard.
          </p>
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-all shadow-sm"
          >
            Go to My Courses
          </Link>
        </div>
      </div>
    );
  }

  // 3. Fetch course by ID
  const { data: course, error: courseError } = await supabase
    .from("courses")
    .select("id, course_code, course_title, lecturer_id")
    .eq("id", course_id)
    .maybeSingle();

  // If course does not exist in catalogue
  if (!course) {
    return (
      <div className="max-w-md mx-auto py-12">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm text-center">
          <div className="w-12 h-12 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-slate-900 mb-2">Course Not Found</h1>
          <p className="text-slate-500 text-sm mb-6">
            The course with ID <code className="px-1.5 py-0.5 bg-slate-100 rounded text-xs font-mono text-slate-700">{course_id}</code> was not found.
          </p>
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-all shadow-sm"
          >
            Return to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  // 4. Verify course belongs to this lecturer
  if (course.lecturer_id !== user.id) {
    // Look up assigned lecturer name for clear feedback
    const { data: lecturerProfile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", course.lecturer_id)
      .maybeSingle();

    const assignedName = lecturerProfile?.full_name || "Another Lecturer";

    return (
      <div className="max-w-md mx-auto py-12">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center mb-4">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-slate-900 mb-2">Course Assigned to Another Lecturer</h1>
          <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 text-sm mb-6 space-y-2">
            <div>
              <span className="text-slate-500">Selected Course: </span>
              <strong className="text-slate-800">{course.course_code} - {course.course_title}</strong>
            </div>
            <div>
              <span className="text-slate-500">Assigned Lecturer: </span>
              <span className="text-slate-800 font-medium">{assignedName}</span>
            </div>
            <div className="pt-2 border-t border-slate-200/60">
              <span className="text-slate-500">Logged in as: </span>
              <span className="text-slate-800 font-medium">{user.email}</span>
            </div>
          </div>
          <p className="text-slate-500 text-xs mb-6">
            Only the assigned lecturer can initiate an attendance session for this course. Please switch accounts or choose a course assigned to you.
          </p>
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="flex-1 text-center py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-all shadow-sm"
            >
              My Courses
            </Link>
            <Link
              href="/login"
              className="py-2.5 px-4 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold transition-all"
            >
              Switch Account
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // 5. Check if there's already an active session for this course
  const { data: activeSession } = await supabase
    .from("sessions")
    .select("id")
    .eq("course_id", course_id)
    .is("ends_at", null)
    .order("starts_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeSession) {
    redirect(`/dashboard/sessions/${activeSession.id}`);
  }

  // 6. Fetch registered devices for the dropdown
  const { data: devices } = await supabase
    .from("device_sessions")
    .select("device_id, last_seen, current_mode")
    .order("last_seen", { ascending: false, nullsFirst: false });

  async function createSession(formData: FormData) {
    "use server";
    
    const deviceId = (formData.get("device_id") as string) || "";
    const latStr = formData.get("latitude") as string;
    const lngStr = formData.get("longitude") as string;
    
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/login");

    const now = new Date().toISOString();
    const sessionDate = now.slice(0, 10);

    const lat = latStr ? parseFloat(latStr) : null;
    const lng = lngStr ? parseFloat(lngStr) : null;

    const { data: session, error: sessionError } = await supabase
      .from("sessions")
      .insert({
        course_id: course!.id,
        session_date: sessionDate,
        starts_at: now,
        created_by: user.id,
        latitude: lat,
        longitude: lng,
      })
      .select("id")
      .single();

    if (sessionError || !session) {
      console.error("Failed to create session:", sessionError);
      redirect("/dashboard");
    }

    if (deviceId.trim().length > 0) {
      await supabase
        .from("device_sessions")
        .upsert(
          {
            device_id: deviceId.trim(),
            session_id: session.id,
            activated_by: user.id,
            activated_at: now,
          },
          { onConflict: "device_id" }
        );
    }

    redirect(`/dashboard/sessions/${session.id}`);
  }

  return (
    <div className="max-w-md mx-auto py-12">
      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900 mb-2">Start Session</h1>
        <p className="text-slate-500 text-sm mb-8">
          Starting a new attendance session for <strong className="text-slate-900">{course.course_code}</strong> ({course.course_title}).
        </p>

        <StartSessionForm createSession={createSession} devices={devices || []} />
      </div>
    </div>
  );
}
