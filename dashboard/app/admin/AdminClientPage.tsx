"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import SignOutButton from "../dashboard/SignOutButton";

type Lecturer = {
  id: string;
  full_name: string | null;
  role: string;
  created_at: string;
  email?: string;
};

type Student = {
  id: string;
  full_name: string | null;
  matric_number: string | null;
  role: string;
  created_at: string;
  device_id?: string | null;
  email?: string;
};

type Course = {
  id: string;
  course_code: string;
  course_title: string;
  lecturer_id: string;
  created_at: string;
};

type ReportRow = {
  course_id: string;
  course_code: string;
  course_title: string;
  lecturer_name: string | null;
  total_sessions: number;
  total_attendances: number;
};

export default function AdminClientPage({
  initialLecturers,
  initialStudents,
  initialCourses,
  initialReport,
  accessToken,
  supabaseUrl,
}: {
  initialLecturers: Lecturer[];
  initialStudents: Student[];
  initialCourses: Course[];
  initialReport: ReportRow[];
  accessToken: string;
  supabaseUrl: string;
}) {
  const [activeTab, setActiveTab] = useState<"lecturers" | "students" | "courses" | "reports">("lecturers");
  const [lecturers, setLecturers] = useState(initialLecturers);
  const [students, setStudents] = useState(initialStudents);
  const [courses, setAllCourses] = useState(initialCourses);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editStudent, setEditStudent] = useState<Student | null>(null);
  
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [provisionCourses, setProvisionCourses] = useState<{course_code: string, course_title: string}[]>([]);
  const [matricNumber, setMatricNumber] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [manageLecturer, setManageLecturer] = useState<Lecturer | null>(null);
  const [lecturerCourses, setLecturerCourses] = useState<any[]>([]);
  const [newCourseCode, setNewCourseCode] = useState("");
  const [newCourseTitle, setNewCourseTitle] = useState("");
  const [isManagingCourses, setIsManagingCourses] = useState(false);
  const [reassignCourse, setReassignCourse] = useState<Course | null>(null);
  const [reassignToLecturerId, setReassignToLecturerId] = useState("");

  const router = useRouter();
  const supabase = createClient();

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);

    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/admin-create-user`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ email, password, full_name: fullName, courses: provisionCourses }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create lecturer");
      }

      setLecturers((prev) => [
        {
          id: data.user.id,
          full_name: fullName,
          role: "lecturer",
          created_at: data.user.created_at,
        },
        ...prev,
      ]);

      setIsModalOpen(false);
      setEmail("");
      setPassword("");
      setFullName("");
      setProvisionCourses([]);
      router.refresh();
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetDevice = async (studentId: string) => {
    setIsLoading(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ device_id: null })
        .eq("id", studentId);

      if (error) throw new Error(error.message);

      setStudents((prev) =>
        prev.map((s) => (s.id === studentId ? { ...s, device_id: null } : s))
      );
      alert("Device binding successfully reset for this student.");
    } catch (err: any) {
      alert(err.message || "Failed to reset device.");
    } finally {
      setIsLoading(false);
    }
  };



  const handleDeactivateStudent = async (studentId: string) => {
    if (!confirm("Are you sure you want to deactivate (ban) this student? They will not be able to log in.")) return;
    setIsLoading(true);
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/admin-manage-user`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ action: "deactivate", targetUserId: studentId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to deactivate student");
      }

      setStudents(students.filter(s => s.id !== studentId));
      alert("Student deactivated successfully.");
    } catch (err: any) {
      alert(err.message || "Failed to deactivate student");
    } finally {
      setIsLoading(false);
    }
  };

  const handleEditStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editStudent) return;
    setIsLoading(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({
          full_name: fullName,
          matric_number: matricNumber.trim().toUpperCase()
        })
        .eq("id", editStudent.id);

      if (error) throw new Error(error.message);

      setStudents((prev) =>
        prev.map((s) =>
          s.id === editStudent.id
            ? { ...s, full_name: fullName, matric_number: matricNumber.trim().toUpperCase() }
            : s
        )
      );
      setEditStudent(null);
    } catch (err: any) {
      alert(err.message || "Failed to update student.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleManageCourses = async (lecturer: Lecturer) => {
    setManageLecturer(lecturer);
    setIsManagingCourses(true);
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("courses")
        .select("*")
        .eq("lecturer_id", lecturer.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setLecturerCourses(data || []);
    } catch (err: any) {
      alert("Failed to load courses: " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manageLecturer) return;
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("courses")
        .insert({
          course_code: newCourseCode.trim().toUpperCase(),
          course_title: newCourseTitle.trim(),
          lecturer_id: manageLecturer.id,
        })
        .select()
        .single();
      if (error) throw error;
      setLecturerCourses([data, ...lecturerCourses]);
      setNewCourseCode("");
      setNewCourseTitle("");
    } catch (err: any) {
      alert("Failed to add course: " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveCourse = async (courseId: string) => {
    if (!confirm("Are you sure you want to permanently delete this course? All associated sessions and attendance records will also be deleted.")) return;
    setIsLoading(true);
    try {
      const { error } = await supabase
        .from("courses")
        .delete()
        .eq("id", courseId);
      if (error) throw error;
      setLecturerCourses(lecturerCourses.filter((c) => c.id !== courseId));
      setAllCourses(courses.filter((c) => c.id !== courseId));
    } catch (err: any) {
      alert("Failed to remove course: " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const submitReassign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reassignCourse || !reassignToLecturerId) return;
    setIsLoading(true);
    try {
      const { error } = await supabase
        .from("courses")
        .update({ lecturer_id: reassignToLecturerId })
        .eq("id", reassignCourse.id);
      
      if (error) throw error;
      
      // Update global courses state
      setAllCourses(courses.map(c => 
        c.id === reassignCourse.id ? { ...c, lecturer_id: reassignToLecturerId } : c
      ));
      
      // Update manage modal state if it's open
      if (isManagingCourses) {
        setLecturerCourses(lecturerCourses.filter(c => c.id !== reassignCourse.id));
      }
      
      setReassignCourse(null);
      setReassignToLecturerId("");
    } catch (err: any) {
      alert("Failed to reassign course: " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const navItems = [
    { id: "lecturers", label: "Lecturers", icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
    )},
    { id: "students", label: "Students", icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
    )},
    { id: "courses", label: "Courses", icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
    )},
    { id: "reports", label: "Reports", icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
    )},
  ] as const;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans relative">
      {/* Top navbar */}
      <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/80 backdrop-blur-md">
        <div className="flex items-center justify-between px-6 h-16">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shadow-md shadow-indigo-500/20">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
              </svg>
            </div>
            <span className="font-bold text-lg text-slate-900 tracking-tight">AttendIQ Admin</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium text-slate-600 hidden sm:block">Administrator</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="flex flex-1 pb-16 md:pb-0 h-[calc(100vh-4rem)]">
        {/* Left sidebar */}
        <aside className="w-56 shrink-0 border-r border-slate-200 bg-white hidden md:flex flex-col py-6">
          <nav className="flex flex-col gap-1 px-3">
            {navItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                    isActive 
                      ? "bg-indigo-50 text-indigo-700" 
                      : "text-slate-600 hover:text-indigo-700 hover:bg-slate-50"
                  }`}
                >
                  <span className={isActive ? "text-indigo-600" : "text-slate-400"}>
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Main content */}
        <div className="flex-1 flex flex-col h-full overflow-hidden bg-slate-50">
          <div className="flex items-center justify-between px-6 py-5 border-b border-slate-200 bg-white shrink-0">
            <h1 className="text-xl font-bold text-slate-900 capitalize">{activeTab}</h1>
            {activeTab === "lecturers" && (
              <button
                onClick={() => {
                  setFullName("");
                  setEmail("");
                  setPassword("");
                  setIsModalOpen(true);
                }}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm transition-colors shadow-sm"
              >
                + Add Lecturer
              </button>
            )}
          </div>

          <main className="flex-1 overflow-auto p-6">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        {activeTab === "lecturers" && (
          lecturers.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-500">
              <p>No lecturers provisioned yet.</p>
            </div>
          ) : (
            <table className="w-full text-left text-sm text-slate-700">
              <thead className="text-xs uppercase bg-slate-50 border-b border-slate-200 text-slate-500 sticky top-0">
                <tr>
                  <th className="px-6 py-4 font-semibold">Name</th>
                  <th className="px-6 py-4 font-semibold">Email</th>
                  <th className="px-6 py-4 font-semibold">Created At</th>
                  <th className="px-6 py-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lecturers.map((lecturer) => (
                  <tr key={lecturer.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 font-medium text-slate-900">
                      {lecturer.full_name || "Unknown"}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">
                      {lecturer.email || lecturer.id}
                    </td>
                    <td className="px-6 py-4 text-slate-600">
                      {new Date(lecturer.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-right space-x-2">
                      <button
                        onClick={() => handleManageCourses(lecturer)}
                        disabled={isLoading}
                        className="px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-indigo-600 font-medium transition-colors disabled:opacity-50"
                      >
                        Manage Courses
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {activeTab === "students" && (
          students.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-500">
              <p>No students signed up yet.</p>
            </div>
          ) : (
            <table className="w-full text-left text-sm text-slate-700">
              <thead className="text-xs uppercase bg-slate-50 border-b border-slate-200 text-slate-500 sticky top-0">
                <tr>
                  <th className="px-6 py-4 font-semibold">Name</th>
                  <th className="px-6 py-4 font-semibold">Matric Number</th>
                  <th className="px-6 py-4 font-semibold">Email</th>
                  <th className="px-6 py-4 font-semibold">Joined At</th>
                  <th className="px-6 py-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {students.map((student) => (
                  <tr key={student.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 font-medium text-slate-900">
                      {student.full_name || "Unknown"}
                    </td>
                    <td className="px-6 py-4 font-mono text-xs text-indigo-700">
                      {student.matric_number || "N/A"}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">
                      {student.email || "N/A"}
                    </td>
                    <td className="px-6 py-4 text-slate-600">
                      {new Date(student.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-right space-x-2">
                      <button
                        onClick={() => {
                          setFullName(student.full_name || "");
                          setMatricNumber(student.matric_number || "");
                          setEditStudent(student);
                        }}
                        disabled={isLoading}
                        className="px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-indigo-600 font-medium transition-colors disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleResetDevice(student.id)}
                        disabled={isLoading}
                        className="px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 font-medium transition-colors disabled:opacity-50"
                        title="Unbind mobile device"
                      >
                        Reset Device
                      </button>

                      <button
                        onClick={() => handleDeactivateStudent(student.id)}
                        disabled={isLoading}
                        className="px-3 py-1.5 rounded bg-rose-50 text-rose-700 hover:bg-rose-100 font-medium transition-colors disabled:opacity-50"
                        title="Deactivate Student"
                      >
                        Deactivate
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {activeTab === "courses" && (
          courses.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-500">
              <p>No courses created yet.</p>
            </div>
          ) : (
            <table className="w-full text-left text-sm text-slate-700">
              <thead className="text-xs uppercase bg-slate-50 border-b border-slate-200 text-slate-500 sticky top-0">
                <tr>
                  <th className="px-6 py-4 font-semibold">Course Code</th>
                  <th className="px-6 py-4 font-semibold">Course Title</th>
                  <th className="px-6 py-4 font-semibold">Current Lecturer</th>
                  <th className="px-6 py-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {courses.map((course) => {
                  const lecturer = lecturers.find(l => l.id === course.lecturer_id);
                  return (
                    <tr key={course.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 font-mono text-xs text-indigo-700 font-bold">
                        {course.course_code}
                      </td>
                      <td className="px-6 py-4 font-medium text-slate-900">
                        {course.course_title}
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">
                        {lecturer ? `${lecturer.full_name} (${lecturer.email || lecturer.id})` : "Unknown"}
                      </td>
                      <td className="px-6 py-4 text-right space-x-2">
                        <button
                          onClick={() => {
                            setReassignCourse(course);
                            setReassignToLecturerId(course.lecturer_id);
                          }}
                          disabled={isLoading}
                          className="px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-indigo-600 font-medium transition-colors disabled:opacity-50"
                        >
                          Reassign
                        </button>
                        <button
                          onClick={() => handleRemoveCourse(course.id)}
                          disabled={isLoading}
                          className="px-3 py-1.5 rounded bg-rose-50 text-rose-700 hover:bg-rose-100 font-medium transition-colors disabled:opacity-50"
                          title="Permanently delete course"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}

        {activeTab === "reports" && (
          initialReport.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-500">
              <p>No reports available yet.</p>
            </div>
          ) : (
            <table className="w-full text-left text-sm text-slate-700">
              <thead className="text-xs uppercase bg-slate-50 border-b border-slate-200 text-slate-500 sticky top-0">
                <tr>
                  <th className="px-6 py-4 font-semibold">Course Code</th>
                  <th className="px-6 py-4 font-semibold">Course Title</th>
                  <th className="px-6 py-4 font-semibold">Lecturer</th>
                  <th className="px-6 py-4 font-semibold text-center">Total Sessions</th>
                  <th className="px-6 py-4 font-semibold text-center">Total Attendees</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {initialReport.map((row) => (
                  <tr key={row.course_id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 font-mono text-xs text-indigo-700 font-bold">
                      {row.course_code}
                    </td>
                    <td className="px-6 py-4 font-medium text-slate-900">
                      {row.course_title}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">
                      {row.lecturer_name || "Unassigned"}
                    </td>
                    <td className="px-6 py-4 text-center font-semibold text-slate-900">
                      {row.total_sessions}
                    </td>
                    <td className="px-6 py-4 text-center font-semibold text-slate-900">
                      {row.total_attendances}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>

          </main>
        </div>
      </div>

      {/* Existing Modals remain below */}

      {/* Edit Student Modal */}
      {editStudent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-2xl p-6">
            <h3 className="text-xl font-bold text-slate-900 mb-6">Edit Student</h3>
            <form onSubmit={handleEditStudent} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Full Name</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Matric Number</label>
                <input
                  type="text"
                  required
                  value={matricNumber}
                  onChange={(e) => setMatricNumber(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setEditStudent(null)}
                  disabled={isLoading}
                  className="px-4 py-2 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors disabled:opacity-50"
                >
                  {isLoading ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-2xl p-6">
            <h3 className="text-xl font-bold text-slate-900 mb-2">Add Lecturer</h3>
            <p className="text-sm text-slate-500 mb-6">
              Create a new account. The lecturer can use these credentials to log in.
            </p>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Full Name</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="e.g. Dr. Jane Doe"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="jane.doe@university.edu"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Temporary Password</label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  placeholder="••••••••"
                  minLength={6}
                />
              </div>

              <div className="pt-4 border-t border-slate-100">
                <div className="flex items-center justify-between mb-3">
                  <label className="block text-sm font-medium text-slate-700">Assign Courses (Optional)</label>
                  <button
                    type="button"
                    onClick={() => setProvisionCourses([...provisionCourses, { course_code: "", course_title: "" }])}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 bg-indigo-50 px-2 py-1 rounded"
                  >
                    + Add Course
                  </button>
                </div>
                
                {provisionCourses.length > 0 && (
                  <div className="space-y-3 max-h-[160px] overflow-y-auto pr-1 pb-1">
                    {provisionCourses.map((c, i) => (
                      <div key={i} className="flex gap-2 items-start bg-slate-50 p-2 rounded-lg border border-slate-200">
                        <div className="flex-1 space-y-2">
                          <input
                            type="text"
                            required
                            value={c.course_code}
                            onChange={(e) => {
                              const newC = [...provisionCourses];
                              newC[i].course_code = e.target.value.toUpperCase();
                              setProvisionCourses(newC);
                            }}
                            className="w-full bg-white border border-slate-300 rounded-md p-2 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                            placeholder="Code (e.g. CSC401)"
                          />
                          <input
                            type="text"
                            required
                            value={c.course_title}
                            onChange={(e) => {
                              const newC = [...provisionCourses];
                              newC[i].course_title = e.target.value;
                              setProvisionCourses(newC);
                            }}
                            className="w-full bg-white border border-slate-300 rounded-md p-2 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                            placeholder="Title"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setProvisionCourses(provisionCourses.filter((_, idx) => idx !== i))}
                          className="text-slate-400 hover:text-rose-600 p-1"
                          title="Remove course"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {errorMsg && (
                <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-600 text-sm mt-4">
                  {errorMsg}
                </div>
              )}

              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={isLoading}
                  className="px-4 py-2 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors disabled:opacity-50"
                >
                  {isLoading ? "Creating..." : "Create Account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isManagingCourses && manageLecturer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-xl bg-white border border-slate-200 rounded-2xl shadow-2xl p-6 flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-xl font-bold text-slate-900">Manage Courses</h3>
                <p className="text-sm text-slate-500">
                  {manageLecturer.full_name} ({manageLecturer.email})
                </p>
              </div>
              <button
                onClick={() => setIsManagingCourses(false)}
                className="p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 rounded-full transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleAddCourse} className="flex gap-2 items-start mb-6">
              <input
                type="text"
                required
                value={newCourseCode}
                onChange={(e) => setNewCourseCode(e.target.value)}
                className="w-1/3 bg-slate-50 border border-slate-300 rounded-lg p-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                placeholder="Code (CSC101)"
              />
              <input
                type="text"
                required
                value={newCourseTitle}
                onChange={(e) => setNewCourseTitle(e.target.value)}
                className="flex-1 bg-slate-50 border border-slate-300 rounded-lg p-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                placeholder="Course Title"
              />
              <button
                type="submit"
                disabled={isLoading || !newCourseCode || !newCourseTitle}
                className="px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm transition-colors disabled:opacity-50 whitespace-nowrap"
              >
                Add
              </button>
            </form>

            <div className="flex-1 overflow-auto rounded-lg border border-slate-200">
              {lecturerCourses.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-sm">
                  No courses assigned to this lecturer.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {lecturerCourses.map((course) => (
                    <li key={course.id} className="p-4 flex items-center justify-between hover:bg-slate-50 transition-colors">
                      <div>
                        <div className="font-semibold text-slate-900">{course.course_code}</div>
                        <div className="text-sm text-slate-500">{course.course_title}</div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setReassignCourse(course);
                            setReassignToLecturerId(manageLecturer.id);
                          }}
                          disabled={isLoading}
                          className="text-slate-400 hover:text-indigo-600 p-2 rounded-lg hover:bg-indigo-50 transition-colors disabled:opacity-50"
                          title="Reassign Course"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleRemoveCourse(course.id)}
                          disabled={isLoading}
                          className="text-slate-400 hover:text-rose-600 p-2 rounded-lg hover:bg-rose-50 transition-colors disabled:opacity-50"
                          title="Delete Course"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bottom navigation for mobile */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex items-center justify-around h-16 px-2 z-50 shadow-[0_-4px_10px_rgba(0,0,0,0.02)]">
        {navItems.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`flex flex-col items-center justify-center w-full h-full transition-colors ${
                isActive ? "text-indigo-600" : "text-slate-500 hover:text-indigo-600"
              }`}
            >
              <span className="mb-1">{item.icon}</span>
              <span className="text-[10px] font-medium">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Reassign Modal */}
      {reassignCourse && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-2xl p-6">
            <h3 className="text-xl font-bold text-slate-900 mb-2">Reassign Course</h3>
            <p className="text-sm text-slate-500 mb-6">
              Move <strong>{reassignCourse.course_code}</strong> to a different lecturer. All existing sessions and attendance logs will be preserved.
            </p>
            <form onSubmit={submitReassign} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Select New Lecturer</label>
                <select
                  required
                  value={reassignToLecturerId}
                  onChange={(e) => setReassignToLecturerId(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg p-2.5 text-slate-900 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="" disabled>Select a lecturer</option>
                  {lecturers.map(l => (
                    <option key={l.id} value={l.id}>
                      {l.full_name} ({l.email || l.id})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => {
                    setReassignCourse(null);
                    setReassignToLecturerId("");
                  }}
                  disabled={isLoading}
                  className="px-4 py-2 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors disabled:opacity-50"
                >
                  {isLoading ? "Saving..." : "Reassign Course"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
