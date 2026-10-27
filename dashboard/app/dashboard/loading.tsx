export default function DashboardLoading() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
      <p className="text-slate-500 font-medium animate-pulse">Loading dashboard...</p>
    </div>
  );
}
