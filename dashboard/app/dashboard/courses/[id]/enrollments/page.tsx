import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import EnrollmentManager from "./EnrollmentManager";

export default async function EnrollmentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = await params;
  const courseId = resolvedParams.id;
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Verify the course exists and belongs to the lecturer
  const { data: course, error: courseError } = await supabase
    .from("courses")
    .select("id, course_code, course_title, lecturer_id")
    .eq("id", courseId)
    .single();

  if (courseError || !course) {
    console.error("DEBUG: course fetch failed.", courseError, "Course:", course);
    notFound();
  }

  if (course.lecturer_id !== user.id) {
    return (
      <div className="max-w-5xl mx-auto h-full flex flex-col items-center justify-center text-rose-500">
        <p>You do not have permission to view this course.</p>
      </div>
    );
  }

  // Fetch enrollments and join with profiles
  const { data: enrollments, error: enrollmentsError } = await supabase
    .from("course_enrollments")
    .select(`
      id,
      status,
      rejection_reason,
      requested_at,
      decided_at,
      eligibility_percentage,
      profiles!student_id (
        id,
        full_name,
        matric_number
      )
    `)
    .eq("course_id", courseId)
    .order("requested_at", { ascending: false });

  if (enrollmentsError) {
    console.error("Error fetching enrollments:", enrollmentsError);
    return (
      <div className="max-w-5xl mx-auto h-full flex items-center justify-center text-rose-500">
        Error loading enrollments.
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto flex flex-col h-full gap-8">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link
              href="/dashboard"
              className="text-indigo-600 hover:text-indigo-700 transition-colors text-sm font-medium flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Dashboard
            </Link>
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Manage Enrollments
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            {course.course_code} - {course.course_title}
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 bg-white border border-slate-200 shadow-sm rounded-2xl overflow-hidden flex flex-col">
        <EnrollmentManager initialEnrollments={(enrollments as any) || []} />
      </div>
    </div>
  );
}
