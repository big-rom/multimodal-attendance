import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import Link from "next/link";

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: courses, error } = await supabase
    .from("courses")
    .select(`
      *,
      course_enrollments ( status ),
      sessions ( id, ends_at )
    `)
    .eq("lecturer_id", user!.id)
    .order("course_code", { ascending: true });

  if (error) {
    console.error("Error fetching courses:", error);
  }

  const coursesWithPending = (courses ?? []).map((c) => {
    const pendingCount = Array.isArray(c.course_enrollments) 
      ? c.course_enrollments.filter((e: any) => e.status === 'pending').length 
      : 0;
    
    // Check if there is an active session
    const activeSession = Array.isArray(c.sessions)
      ? c.sessions.find((s: any) => s.ends_at === null)
      : null;

    return { ...c, pendingCount, activeSession };
  });

  return (
    <div>
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">My Courses</h1>
        <p className="text-sm text-slate-600 mt-1">
          Select a course to start an attendance session.
        </p>
      </div>

      {/* Empty state */}
      {(!coursesWithPending || coursesWithPending.length === 0) ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white py-24 text-center shadow-sm">
          <div className="w-14 h-14 rounded-xl bg-slate-100 flex items-center justify-center mb-4">
            <svg className="w-7 h-7 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <p className="text-slate-900 font-medium">No courses assigned yet.</p>
          <p className="text-slate-500 text-sm mt-1">Contact your administrator to get started.</p>
        </div>
      ) : (
        /* Course grid */
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {coursesWithPending.map((course) => (
            <div
              key={course.id}
              className="group relative flex flex-col rounded-2xl border border-slate-200 bg-white shadow-sm p-6 hover:border-indigo-300 hover:shadow-md transition-all duration-200"
            >
              {/* Hover shimmer */}
              <div className="absolute inset-0 rounded-2xl bg-transparent group-hover:bg-indigo-50/50 transition-all duration-300 pointer-events-none" />

              {/* Course code badge */}
              <span className="inline-flex items-center self-start px-2.5 py-1 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-mono font-semibold mb-4 tracking-wide">
                {course.course_code}
              </span>

              {/* Course title */}
              <h2 className="text-slate-900 font-semibold text-base leading-snug mb-1 flex-1">
                {course.course_title ?? course.title ?? "Untitled Course"}
              </h2>

              {/* Divider */}
              <div className="border-t border-slate-100 my-4" />

              {/* Actions */}
              <div className="flex flex-col gap-2 mt-auto">
                <div className="flex items-center gap-2">
                  {course.activeSession ? (
                    <Link
                      href={`/dashboard/sessions/${course.activeSession.id}`}
                      className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-all duration-150 shadow-lg shadow-emerald-500/10 group-hover:shadow-emerald-500/20"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Resume
                    </Link>
                  ) : (
                    <Link
                      id={`start-session-${course.id}`}
                      href={`/dashboard/sessions/new?course_id=${course.id}`}
                      className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-all duration-150 shadow-lg shadow-indigo-500/10 group-hover:shadow-indigo-500/20"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Start
                    </Link>
                  )}
                  <Link
                    href={`/dashboard/sessions?course_id=${course.id}`}
                    className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-white hover:bg-slate-50 text-slate-700 hover:text-slate-900 text-sm font-semibold transition-all duration-150 border border-slate-200 group-hover:border-indigo-300 group-hover:text-indigo-600"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    History
                  </Link>
                </div>
                <Link
                  href={`/dashboard/courses/${course.id}/enrollments`}
                  className="w-full relative flex items-center justify-center gap-2 py-2 rounded-lg bg-white hover:bg-slate-50 text-slate-700 hover:text-slate-900 text-sm font-semibold transition-all duration-150 border border-slate-200 group-hover:border-emerald-300 group-hover:text-emerald-600"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                  Manage Enrollments
                  {course.pendingCount > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white shadow-sm ring-2 ring-white">
                      {course.pendingCount}
                    </span>
                  )}
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
