import { createClient } from "@/utils/supabase/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

interface StudentAggregated {
  id: string;
  full_name: string;
  matric_number: string | null;
  courses: Array<{ id: string; code: string; title: string }>;
}

export default async function StudentsListPage() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Fetch all enrollments for courses owned by the authenticated lecturer.
  // The RLS policy "Lecturers can view enrollments for their courses" ensures
  // they only see their own data.
  const { data: enrollments, error } = await supabase
    .from("course_enrollments")
    .select(`
      course_id,
      courses!inner(course_code, course_title),
      student:profiles!student_id(id, full_name, matric_number)
    `)
    .eq("status", "approved");

  if (error) {
    console.error("Error fetching students:", error);
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <p className="text-red-400 font-medium">Failed to load students.</p>
      </div>
    );
  }

  // Deduplicate by student ID, accumulating the courses they take.
  const studentMap = new Map<string, StudentAggregated>();

  for (const row of enrollments || []) {
    // Supabase TS types for joined tables can be tricky; safely cast them.
    const student = row.student as unknown as { id: string; full_name: string; matric_number: string | null };
    const course = row.courses as unknown as { course_code: string; course_title: string };

    if (!student) continue;

    if (!studentMap.has(student.id)) {
      studentMap.set(student.id, {
        id: student.id,
        full_name: student.full_name,
        matric_number: student.matric_number,
        courses: [],
      });
    }

    studentMap.get(student.id)!.courses.push({
      id: row.course_id,
      code: course.course_code,
      title: course.course_title,
    });
  }

  const students = Array.from(studentMap.values()).sort((a, b) =>
    a.full_name.localeCompare(b.full_name)
  );

  return (
    <div className="max-w-5xl mx-auto flex flex-col h-full">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Students</h1>
          <p className="text-sm text-slate-600 mt-1">
            All students enrolled in your courses.
          </p>
        </div>
        <div className="text-right">
          <span className="text-3xl font-bold text-slate-900 tabular-nums">
            {students.length}
          </span>
          <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mt-0.5">
            Total Students
          </p>
        </div>
      </div>

      <div className="flex-1 bg-white border border-slate-200 shadow-sm rounded-2xl overflow-hidden flex flex-col min-h-0">
        <div className="flex-1 overflow-auto">
          {students.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 p-8">
              <svg className="w-12 h-12 mb-3 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <p>No students found in your courses.</p>
            </div>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="sticky top-0 bg-white/95 backdrop-blur-sm shadow-[0_1px_2px_rgba(0,0,0,0.05)] z-10">
                <tr>
                  <th className="px-6 py-4 font-semibold text-slate-500 text-xs uppercase tracking-wider">
                    Student Name
                  </th>
                  <th className="px-6 py-4 font-semibold text-slate-500 text-xs uppercase tracking-wider">
                    Matric Number
                  </th>
                  <th className="px-6 py-4 font-semibold text-slate-500 text-xs uppercase tracking-wider">
                    Enrolled Courses
                  </th>
                  <th className="px-6 py-4"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {students.map((student) => (
                  <tr key={student.id} className="group hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-medium text-slate-900">{student.full_name}</div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-mono text-xs text-slate-600 bg-slate-100 px-2 py-1 rounded">
                        {student.matric_number || "—"}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-2">
                        {student.courses.map((c) => (
                          <span
                            key={c.id}
                            title={c.title}
                            className="text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full"
                          >
                            {c.code}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <Link
                        href={`/dashboard/students/${student.id}`}
                        className="inline-flex items-center justify-center px-4 py-2 text-xs font-semibold text-slate-600 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors group-hover:border-indigo-300 group-hover:text-indigo-600"
                      >
                        View Details
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
