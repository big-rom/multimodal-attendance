import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import AdminClientPage from "./AdminClientPage";

export default async function AdminDashboardPage() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const { data: allProfiles, error: fetchError } = await supabase
    .rpc("get_profiles_with_email");

  if (fetchError) {
    console.error("Error fetching profiles with email:", fetchError);
  }

  const { data: allCourses, error: coursesError } = await supabase
    .from("courses")
    .select("*")
    .order("created_at", { ascending: false });

  if (coursesError) {
    console.error("Error fetching courses:", coursesError);
  }

  const { data: reportData, error: reportError } = await supabase
    .rpc("get_system_attendance_report");
    
  if (reportError) {
    console.error("Error fetching reports:", reportError);
  }

  const lecturers = allProfiles?.filter((p: any) => p.role === "lecturer") || [];
  const students = allProfiles?.filter((p: any) => p.role === "student") || [];

  const {
    data: { session },
  } = await supabase.auth.getSession();

  return (
    <AdminClientPage 
      initialLecturers={lecturers || []} 
      initialStudents={students || []}
      initialCourses={allCourses || []}
      initialReport={reportData || []}
      accessToken={session?.access_token || ""} 
      supabaseUrl={process.env.NEXT_PUBLIC_SUPABASE_URL || ""}
    />
  );
}
