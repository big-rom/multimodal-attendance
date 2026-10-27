import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import AttendanceTrendChart from "./AttendanceTrendChart";

export default async function PastSessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const resolvedSearchParams = await searchParams;
  const urlCourseId = typeof resolvedSearchParams.course_id === "string" ? resolvedSearchParams.course_id : null;

  // Fetch all courses for the lecturer
  const { data: courses } = await supabase
    .from("courses")
    .select("id, course_code, course_title")
    .eq("lecturer_id", user.id)
    .order("course_code");

  if (!courses || courses.length === 0) {
    return (
      <div className="max-w-5xl mx-auto h-full flex items-center justify-center text-slate-500">
        You have no courses to view history for.
      </div>
    );
  }

  const selectedCourseId = urlCourseId || courses[0].id;
  const selectedCourse = courses.find((c) => c.id === selectedCourseId) || courses[0];

  // Fetch total enrolled for the selected course
  const { count: totalEnrolled } = await supabase
    .from("course_enrollments")
    .select("*", { count: "exact", head: true })
    .eq("course_id", selectedCourseId)
    .eq("status", "approved");

  // Fetch PAST sessions (ends_at IS NOT NULL) for the selected course
  const { data: pastSessions } = await supabase
    .from("sessions")
    .select(`
      id, session_date, starts_at, ends_at,
      attendance_logs(id)
    `)
    .eq("course_id", selectedCourseId)
    .not("ends_at", "is", null)
    .order("starts_at", { ascending: false });

  return (
    <div className="max-w-5xl mx-auto flex flex-col h-full gap-8">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Session History</h1>
          <p className="text-sm text-slate-600 mt-1">
            Review attendance for closed sessions.
          </p>
        </div>

        {/* Course Selector */}
        <div className="flex items-center gap-3">
          <label htmlFor="course-select" className="text-sm text-slate-600 font-medium">
            Course:
          </label>
          <div className="relative">
            <select
              id="course-select"
              defaultValue={selectedCourseId}
              // We use a small inline script or rely on Next.js Link instead. 
              // Since this is a server component without client interactivity, 
              // we can use a basic form submission or just use links for selection.
              // A better way is to render a custom dropdown, but for simplicity we'll just style a native select 
              // and use an inline onchange (which is valid in standard HTML, but in React we usually use useRouter).
              // We will just use links in a horizontal scrolling list or a simple grid instead of a native select for better UX in Server Components.
              className="hidden"
            />
            {/* We'll use a styled course selector below instead */}
          </div>
        </div>
      </div>

      {/* Course Tabs (Simulating a selector) */}
      <div className="flex gap-2 overflow-x-auto pb-2 -mx-2 px-2 snap-x scrollbar-hide">
        {courses.map((course) => (
          <Link
            key={course.id}
            href={`/dashboard/sessions?course_id=${course.id}`}
            className={`snap-start shrink-0 px-4 py-2 rounded-lg text-sm font-semibold transition-colors border ${
              course.id === selectedCourseId
                ? "bg-indigo-50 border-indigo-200 text-indigo-700"
                : "bg-white border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50"
            }`}
          >
            {course.course_code}
          </Link>
        ))}
      </div>

      {pastSessions && pastSessions.length > 0 && (
        <AttendanceTrendChart
          sessions={pastSessions.map((s: any) => ({
            id: s.id,
            starts_at: s.starts_at,
            attendance_count: s.attendance_logs?.length || 0,
          }))}
          totalEnrolled={totalEnrolled || 0}
        />
      )}

      {/* Content Area */}
      <div className="flex-1 bg-white border border-slate-200 shadow-sm rounded-2xl overflow-hidden flex flex-col min-h-0">
        <div className="p-6 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">{selectedCourse.course_title}</h2>
            <p className="text-sm text-slate-600">{totalEnrolled || 0} students enrolled</p>
          </div>
          <div className="text-right">
            <span className="text-2xl font-bold text-slate-900">{pastSessions?.length || 0}</span>
            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">Past Sessions</p>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {!pastSessions || pastSessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 py-12">
              <svg className="w-12 h-12 mb-3 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p>No past sessions found for this course.</p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {pastSessions.map((session) => {
                const attended = (session.attendance_logs as unknown as any[])?.length || 0;
                const total = totalEnrolled || 0;
                const percentage = total > 0 ? Math.round((attended / total) * 100) : 0;
                
                // Format dates
                const dateObj = new Date(session.starts_at);
                const dateStr = dateObj.toLocaleDateString("en-GB", {
                  weekday: "short",
                  day: "numeric",
                  month: "short"
                });
                
                const startStr = dateObj.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
                const endStr = new Date(session.ends_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

                return (
                  <Link
                    key={session.id}
                    href={`/dashboard/sessions/${session.id}`}
                    className="group relative flex flex-col rounded-xl border border-slate-200 bg-white shadow-sm p-5 hover:bg-slate-50 hover:shadow transition-all"
                  >
                    <div className="flex items-center justify-between mb-4">
                      <div className="text-slate-900 font-semibold flex items-center gap-2">
                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        {dateStr}
                      </div>
                      <div className="text-xs text-slate-600 font-mono bg-slate-100 px-2 py-1 rounded">
                        {startStr} - {endStr}
                      </div>
                    </div>

                    <div className="flex items-end justify-between mt-auto pt-4 border-t border-slate-100">
                      <div>
                        <div className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-1">Attendance</div>
                        <div className="text-xl font-bold text-slate-900 tabular-nums">
                          {attended} <span className="text-sm font-normal text-slate-500">/ {total}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className={`text-lg font-bold tabular-nums ${percentage >= 75 ? "text-emerald-600" : percentage >= 50 ? "text-amber-500" : "text-rose-500"}`}>
                          {percentage}%
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
