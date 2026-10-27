import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export default async function StudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: studentId } = await params;
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // 1. Fetch Student Profile
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("full_name, matric_number")
    .eq("id", studentId)
    .single();

  if (profileError || !profile) {
    return notFound();
  }

  // 2. Fetch Enrollments (only includes courses the lecturer owns due to RLS)
  const { data: enrollments } = await supabase
    .from("course_enrollments")
    .select("course_id, eligibility_percentage, courses!inner(course_code, course_title)")
    .eq("student_id", studentId)
    .eq("status", "approved");

  if (!enrollments || enrollments.length === 0) {
    return (
      <div className="max-w-5xl mx-auto flex flex-col h-full">
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{profile.full_name}</h1>
        <p className="text-slate-600 mt-4">Student is not enrolled in any of your courses.</p>
      </div>
    );
  }

  const courseIds = enrollments.map((e) => e.course_id);

  // 3. Fetch all sessions for these courses
  const { data: sessions } = await supabase
    .from("sessions")
    .select("id, course_id, session_date, starts_at, ends_at")
    .in("course_id", courseIds)
    .order("starts_at", { ascending: false });

  // 4. Fetch attendance logs for this student in these sessions
  const sessionIds = sessions?.map((s) => s.id) || [];
  let attendanceLogs: any[] = [];
  
  if (sessionIds.length > 0) {
    const { data: logs } = await supabase
      .from("attendance_logs")
      .select("id, session_id, method, recorded_at, verification_method")
      .eq("student_id", studentId)
      .in("session_id", sessionIds);
    attendanceLogs = logs || [];
  }

  // Map logs by session_id for O(1) lookup
  const attendanceMap = new Map(attendanceLogs.map((log) => [log.session_id, log]));

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-8 pb-12">
      {/* Header */}
      <div>
        <Link
          href="/dashboard/students"
          className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 transition-colors mb-4"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back to Students
        </Link>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">{profile.full_name}</h1>
        <div className="flex items-center gap-3 mt-2">
          <span className="font-mono text-sm text-indigo-700 bg-indigo-50 px-2.5 py-1 rounded-md border border-indigo-200">
            {profile.matric_number || "No Matric Number"}
          </span>
          <span className="text-sm text-slate-600">
            Enrolled in {enrollments.length} of your courses
          </span>
        </div>
      </div>

      {/* Courses Loop */}
      {enrollments.map((enrollment) => {
        const course = enrollment.courses as unknown as { course_code: string; course_title: string };
        const courseSessions = (sessions || []).filter((s) => s.course_id === enrollment.course_id);
        const eligibility = Number(enrollment.eligibility_percentage);
        
        // Determine status colors based on eligibility (>= 70% is good)
        const isEligible = eligibility >= 70;

        return (
          <div key={enrollment.course_id} className="bg-white border border-slate-200 shadow-sm rounded-2xl overflow-hidden">
            {/* Course Header */}
            <div className="p-6 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  {course.course_code}
                  <span className="text-slate-500 font-normal text-base">— {course.course_title}</span>
                </h2>
                <p className="text-sm text-slate-500 mt-1">
                  {courseSessions.length} total sessions
                </p>
              </div>

              {/* Eligibility Badge */}
              <div className="flex items-center gap-4 bg-slate-50 px-5 py-3 rounded-xl border border-slate-200">
                <div>
                  <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
                    Eligibility
                  </div>
                  <div className={`text-2xl font-bold tabular-nums ${isEligible ? "text-emerald-600" : "text-amber-500"}`}>
                    {eligibility}%
                  </div>
                </div>
                <div className="h-10 w-px bg-slate-200" />
                <div className={`text-sm font-medium ${isEligible ? "text-emerald-600" : "text-amber-600"}`}>
                  {isEligible ? "Eligible" : "At Risk"}
                </div>
              </div>
            </div>

            {/* Sessions List */}
            <div className="overflow-x-auto">
              {courseSessions.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-sm">
                  No sessions have been created for this course yet.
                </div>
              ) : (
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 border-b border-slate-100">
                    <tr>
                      <th className="px-6 py-3 font-semibold text-slate-500 text-xs uppercase tracking-wider">Date</th>
                      <th className="px-6 py-3 font-semibold text-slate-500 text-xs uppercase tracking-wider">Status</th>
                      <th className="px-6 py-3 font-semibold text-slate-500 text-xs uppercase tracking-wider">Time Recorded</th>
                      <th className="px-6 py-3 font-semibold text-slate-500 text-xs uppercase tracking-wider">Method</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {courseSessions.map((session) => {
                      const log = attendanceMap.get(session.id);
                      const isPresent = !!log;
                      
                      // Format date
                      const dateObj = new Date(session.starts_at);
                      const dateStr = dateObj.toLocaleDateString("en-GB", {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                        year: "numeric"
                      });

                      return (
                        <tr key={session.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-6 py-4 text-slate-900 font-medium">
                            {dateStr}
                          </td>
                          <td className="px-6 py-4">
                            {isPresent ? (
                              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-full border border-emerald-200">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                Present
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-700 bg-rose-50 px-2 py-1 rounded-full border border-rose-200">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                Missed
                              </span>
                            )}
                          </td>
                          <td className="px-6 py-4 text-slate-500 tabular-nums">
                            {isPresent ? new Date(log.recorded_at).toLocaleTimeString("en-GB", {
                              hour: "2-digit",
                              minute: "2-digit"
                            }) : "—"}
                          </td>
                          <td className="px-6 py-4">
                            {isPresent ? (
                              <span className="text-xs font-mono text-slate-600 bg-slate-100 px-2 py-1 rounded border border-slate-200">
                                {(log.verification_method || log.method).toUpperCase()}
                              </span>
                            ) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
