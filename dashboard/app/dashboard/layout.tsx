import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import SignOutButton from "./SignOutButton";
import Link from "next/link";
import HardwareEventMonitor from "@/components/HardwareEventMonitor";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, force_password_reset")
    .eq("id", user.id)
    .single();

  if (profile?.role === "student") {
    redirect("/mobile-only");
  }
  
  if (profile?.role === "admin") {
    redirect("/admin");
  }

  const fullName = profile?.full_name ?? user.email;

  // ---------------------------------------------------------------------------
  // Device heartbeat status
  // Read last_seen from device_sessions to show how many nodes are online.
  // ---------------------------------------------------------------------------
  const { data: devices } = await supabase
    .from("device_sessions")
    .select("device_id, last_seen, current_mode, session_id");

  const ONLINE_THRESHOLD_MS = 20_000; // 20 s
  const now = Date.now();
  
  const onlineDevices = (devices || []).filter((d) => {
    if (!d.last_seen) return false;
    return now - new Date(d.last_seen).getTime() < ONLINE_THRESHOLD_MS;
  });
  
  const totalDevices = devices?.length || 0;
  const isOnline = onlineDevices.length > 0;

  const navLinks = [
    {
      href: "/dashboard",
      label: "Home",
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
        </svg>
      ),
    },
    {
      href: "/dashboard/sessions",
      label: "Sessions",
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      href: "/dashboard/enrol",
      label: "Enrol Card",
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
        </svg>
      ),
    },
    {
      href: "/dashboard/students",
      label: "Students",
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M12 14l9-5-9-5-9 5 9 5zM12 14l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.5a11.952 11.952 0 00-6.824-2.999 12.083 12.083 0 01.665-6.479L12 14z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M12 14l9-5-9-5-9 5 9 5zm0 0l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.5a11.952 11.952 0 00-6.824-2.999 12.083 12.083 0 01.665-6.479L12 14zm-4 6v-7.5l4-2.222" />
        </svg>
      ),
    },
    {
      href: "/dashboard/settings",
      label: "Settings",
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ),
    },
    {
      href: "/dashboard/device-setup",
      label: "Device Setup",
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
            d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
        </svg>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      {/* Top navbar */}
      <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/80 backdrop-blur-md">
        <div className="flex items-center justify-between px-6 h-14">
          <span className="text-slate-900 font-bold text-lg tracking-tight">
            Attend<span className="text-indigo-600">IQ</span>
          </span>
          <div className="flex items-center gap-4">
            {/* Device status pill — visible on mobile where the sidebar is hidden */}
            <DeviceStatusChip isOnline={isOnline} onlineCount={onlineDevices.length} totalCount={totalDevices} compact />
            <span className="text-sm text-slate-600 hidden sm:block">{fullName}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="flex flex-1 pb-16 md:pb-0">
        {/* Left sidebar */}
        <aside className="w-56 shrink-0 border-r border-slate-200 bg-white hidden md:flex flex-col py-6">
          <nav className="flex flex-col gap-1 px-3">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-600 hover:text-indigo-700 hover:bg-indigo-50 transition-all duration-150 group"
              >
                <span className="text-slate-400 group-hover:text-indigo-600 transition-colors">
                  {link.icon}
                </span>
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Device status card — sits below the nav links in the sidebar */}
          <div className="mt-auto px-3 pb-2">
            <DeviceStatusChip isOnline={isOnline} onlineCount={onlineDevices.length} totalCount={totalDevices} />
          </div>
        </aside>

        {/* Main content */}
        <div className="flex-1 flex flex-col h-full overflow-hidden">
          {profile?.force_password_reset && (
            <div className="bg-amber-50 border-b border-amber-200 px-6 py-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <p className="text-sm text-amber-800 font-medium">
                  Your account is using a temporary password. Please reset it.
                </p>
              </div>
              <Link href="/dashboard/settings" className="shrink-0 ml-4 px-3 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-800 text-xs font-semibold rounded-md transition-colors">
                Reset Password
              </Link>
            </div>
          )}
          <main className="flex-1 p-6 overflow-auto">{children}</main>
        </div>
      </div>

      {/* Bottom navigation for mobile */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex items-center justify-around h-16 px-2 z-50 shadow-[0_-4px_10px_rgba(0,0,0,0.02)]">
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="flex flex-col items-center justify-center w-full h-full text-slate-500 hover:text-indigo-600 active:text-indigo-700 transition-colors"
          >
            <span className="mb-1">{link.icon}</span>
            <span className="text-[10px] font-medium">{link.label}</span>
          </Link>
        ))}
      </nav>

      {/* Global Real-time Hardware Telemetry & Toasts */}
      <HardwareEventMonitor />
    </div>
  );
}

// =============================================================================
// DeviceStatusChip
// Server component — rendered with the layout on every navigation.
//
// Props:
//   isOnline  -- true if last_seen was within the ONLINE_THRESHOLD_MS window
//   mode      -- 'attend' | 'enrol' | null (last reported mode)
//   compact   -- if true, renders a small pill suitable for the top navbar;
//                if false (default), renders a fuller card for the sidebar.
// =============================================================================
function DeviceStatusChip({
  isOnline,
  onlineCount,
  totalCount,
  compact = false,
}: {
  isOnline: boolean;
  onlineCount: number;
  totalCount: number;
  compact?: boolean;
}) {
  if (compact) {
    // Small pill for top navbar — dot + "Online" / "Offline" text
    return (
      <span
        id="device-status-chip"
        title={`Hardware nodes: ${onlineCount} online`}
        className="flex items-center gap-1.5 px-2 py-1 rounded-full border text-xs font-medium"
        style={
          isOnline
            ? { borderColor: "#bbf7d0", backgroundColor: "#f0fdf4", color: "#15803d" }
            : { borderColor: "#e2e8f0", backgroundColor: "#f8fafc", color: "#94a3b8" }
        }
      >
        {isOnline ? (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        ) : (
          <span className="h-2 w-2 rounded-full bg-slate-300 shrink-0" />
        )}
        {onlineCount} Nodes
      </span>
    );
  }

  // Full card for sidebar
  return (
    <div
      id="device-status-card"
      className={`rounded-xl border p-3 flex flex-col gap-1.5 ${
        isOnline
          ? "border-emerald-200 bg-emerald-50"
          : "border-slate-200 bg-slate-50"
      }`}
    >
      <div className="flex items-center gap-2">
        {isOnline ? (
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
        ) : (
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300 shrink-0" />
        )}
        <span
          className={`text-xs font-semibold ${
            isOnline ? "text-emerald-700" : "text-slate-400"
          }`}
        >
          {totalCount} Nodes Registered
        </span>
      </div>
      <span className={`text-[11px] pl-4 ${isOnline ? "text-emerald-600" : "text-slate-400"}`}>
        {onlineCount} currently online
      </span>
    </div>
  );
}
