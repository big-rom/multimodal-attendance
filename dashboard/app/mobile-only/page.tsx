export default function MobileOnlyPage() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center">
        <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-slate-900 mb-2">Mobile App Required</h1>
        <p className="text-slate-600 mb-8">
          The AttendIQ web dashboard is for lecturers only. Please download the mobile app to view your attendance and enrol in courses.
        </p>
        <a
          href="/login"
          className="inline-flex items-center justify-center w-full px-6 py-3 text-sm font-semibold text-white transition-colors bg-indigo-600 rounded-xl hover:bg-indigo-700"
        >
          Sign out / Back to Login
        </a>
      </div>
    </div>
  );
}
