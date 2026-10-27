"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";

const SUPABASE_URL = "https://egsjtkvojodpvatinkyv.supabase.co";
const ENROL_MODE_TTL = 30; // seconds the enrolment window stays open (30 seconds)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface StudentProfile {
  id: string;
  full_name: string;
  matric_number: string | null;
}

type ResultState =
  | { kind: "success"; studentName: string; uid: string }
  | { kind: "uid_conflict"; message?: string; existingStudent?: string; existingMatric?: string; uid?: string }
  | { kind: "student_conflict" }
  | { kind: "session_conflict" }   // device has an active attendance session
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function EnrolCardPage() {
  const supabase = useRef(createClient()).current;

  // --- Search state ---
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<StudentProfile[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Selected student ---
  const [selectedStudent, setSelectedStudent] =
    useState<StudentProfile | null>(null);

  // --- Enrolment mode state ---
  const [enrolActive, setEnrolActive] = useState(false);
  const [activating, setActivating] = useState(false);
  const [countdown, setCountdown] = useState(ENROL_MODE_TTL);
  const [animKey, setAnimKey] = useState(0);
  const countdownRef = useRef(ENROL_MODE_TTL);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const channelRef = useRef<any>(null);

  // --- Manual UID input ---
  const [cardUid, setCardUid] = useState("");
  const [registering, setRegistering] = useState(false);

  // --- Multi-Device Support ---
  const [devices, setDevices] = useState<{device_id: string, last_seen: string | null}[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");

  // --- Result ---
  const [result, setResult] = useState<ResultState | null>(null);

  // ---------------------------------------------------------------------------
  // Cleanup timers and fetch devices on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Fetch registered devices
    const fetchDevices = async () => {
      const { data } = await supabase
        .from("device_sessions")
        .select("device_id, last_seen")
        .order("last_seen", { ascending: false, nullsFirst: false });
      if (data) {
        setDevices(data);
        if (data.length > 0) setSelectedDevice(data[0].device_id);
      }
    };
    fetchDevices();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [supabase]);

  // ---------------------------------------------------------------------------
  // Debounced student search
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setIsSearching(true);
      const q = query.trim();

      // 1. Get current lecturer's user ID
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }

      // 2. Get all course IDs owned by this lecturer
      const { data: courses } = await supabase
        .from("courses")
        .select("id")
        .eq("lecturer_id", user.id);

      const courseIds = courses?.map(c => c.id) || [];
      
      if (courseIds.length === 0) {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }

      // 3. Get all students enrolled in these courses
      const { data: enrollments } = await supabase
        .from("course_enrollments")
        .select("student_id")
        .in("course_id", courseIds);
      
      const studentIds = Array.from(new Set(enrollments?.map(e => e.student_id) || []));

      if (studentIds.length === 0) {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }

      // 4. Search within those specific students
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, matric_number")
        .eq("role", "student")
        .in("id", studentIds)
        .or(`full_name.ilike.%${q}%,matric_number.ilike.%${q}%`)
        .order("full_name", { ascending: true })
        .limit(10);

      setSearchResults((data as StudentProfile[]) ?? []);
      setIsSearching(false);
    }, 300);
  }, [query, supabase]);

  // ---------------------------------------------------------------------------
  // Start enrolment countdown + polling
  // ---------------------------------------------------------------------------
  const startCountdown = useCallback((targetStudentId: string, targetStudentName: string) => {
    countdownRef.current = ENROL_MODE_TTL;
    setCountdown(ENROL_MODE_TTL);
    setAnimKey((k) => k + 1);

    // Clean up any existing timer or channel
    if (timerRef.current) clearInterval(timerRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    // Countdown tick
    timerRef.current = setInterval(() => {
      countdownRef.current -= 1;
      setCountdown(countdownRef.current);
      if (countdownRef.current <= 0) {
        clearInterval(timerRef.current!);
        clearInterval(pollRef.current!);
        if (channelRef.current) {
          supabase.removeChannel(channelRef.current);
          channelRef.current = null;
        }
        setEnrolActive(false);
      }
    }, 1000);

    // Realtime subscription to device_events for instant hardware tap feedback (<100ms)
    const channel = supabase
      .channel(`enrol-page-events-${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "device_events",
        },
        (payload) => {
          const newEvent = payload.new as any;
          if (!newEvent) return;

          // Verify the event belongs to this enrolment (by student ID or matching device)
          const matchesStudent = 
            newEvent.payload?.target_student_id === targetStudentId ||
            newEvent.payload?.student_id === targetStudentId;

          const matchesDevice = 
            !selectedDevice || 
            !newEvent.device_id || 
            newEvent.device_id === selectedDevice || 
            newEvent.device_id === "esp32-node-1";

          if (!matchesStudent && !matchesDevice) {
            return;
          }

          if (newEvent.event_type === "enrol_success") {
            if (timerRef.current) clearInterval(timerRef.current);
            if (pollRef.current) clearInterval(pollRef.current);
            if (channelRef.current) {
              supabase.removeChannel(channelRef.current);
              channelRef.current = null;
            }
            setEnrolActive(false);
            setResult({
              kind: "success",
              studentName: newEvent.payload?.student_name || targetStudentName,
              uid: newEvent.payload?.uid || "NFC-CARD",
            });
          } else if (newEvent.event_type === "enrol_error") {
            if (timerRef.current) clearInterval(timerRef.current);
            if (pollRef.current) clearInterval(pollRef.current);
            if (channelRef.current) {
              supabase.removeChannel(channelRef.current);
              channelRef.current = null;
            }
            setEnrolActive(false);

            if (newEvent.payload?.conflict_type === "uid_registered") {
              setResult({
                kind: "uid_conflict",
                message: newEvent.message,
                existingStudent: newEvent.payload?.existing_student,
                existingMatric: newEvent.payload?.existing_matric,
                uid: newEvent.payload?.uid,
              });
            } else {
              setResult({
                kind: "error",
                message: newEvent.message || "Card enrolment failed.",
              });
            }
          }
        }
      )
      .subscribe();

    channelRef.current = channel;

    // Polling fallback: check status every 2 seconds in case WebSocket drops
    pollRef.current = setInterval(async () => {
      try {
        // 1. Check if a card was just enrolled by the ESP32
        const { data: cardData } = await supabase
          .from("nfc_cards")
          .select("uid")
          .eq("student_id", targetStudentId)
          .maybeSingle();

        if (cardData) {
          clearInterval(timerRef.current!);
          clearInterval(pollRef.current!);
          if (channelRef.current) {
            supabase.removeChannel(channelRef.current);
            channelRef.current = null;
          }
          setEnrolActive(false);
          setResult({
            kind: "success",
            studentName: targetStudentName,
            uid: cardData.uid,
          });

          // Tell the edge function to stop enrolment mode early
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            fetch(`${SUPABASE_URL}/functions/v1/enrolment-mode`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session.access_token}`,
              },
              body: JSON.stringify({ action: "stop" }),
            }).catch(() => {});
          }
          return;
        }

        // 2. Otherwise check if mode timed out or was cancelled
        const res = await fetch(`${SUPABASE_URL}/functions/v1/enrolment-mode/status`, {
          headers: {
            apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
            Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!}`,
          },
        });
        if (res.ok) {
          const data = await res.json();
          if (!data.active) {
            clearInterval(timerRef.current!);
            clearInterval(pollRef.current!);
            if (channelRef.current) {
              supabase.removeChannel(channelRef.current);
              channelRef.current = null;
            }
            setEnrolActive(false);
          }
        }
      } catch {
        // swallow poll errors
      }
    }, 2000);
  }, [supabase, selectedDevice]);

  // ---------------------------------------------------------------------------
  // Activate enrolment mode
  // ---------------------------------------------------------------------------
  const handleActivate = async () => {
    setActivating(true);

    const {
      data: { session: authSession },
    } = await supabase.auth.getSession();

    if (!authSession) {
      setActivating(false);
      return;
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/enrolment-mode`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authSession.access_token}`,
        },
        // device_id tells the server which device to check for an active session.
        body: JSON.stringify({
          action: "start",
          device_id: selectedDevice || "esp32-node-1",
          student_id: selectedStudent?.id,
          lecturer_id: authSession.user.id,
        }),
      });

      if (res.status === 409) {
        // The device already has an active attendance session running.
        // Block the activation and show a clear message to the lecturer.
        setResult({ kind: "session_conflict" });
        setActivating(false);
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setResult({
          kind: "error",
          message: body.error ?? `Server error (${res.status})`,
        });
        setActivating(false);
        return;
      }

      setEnrolActive(true);
      if (selectedStudent) {
        startCountdown(selectedStudent.id, selectedStudent.full_name);
      }
    } catch (err) {
      setResult({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setActivating(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Register card manually
  // ---------------------------------------------------------------------------
  const handleRegisterCard = async () => {
    if (!selectedStudent || !cardUid.trim()) return;
    setRegistering(true);
    setResult(null);

    const {
      data: { session: authSession },
    } = await supabase.auth.getSession();

    if (!authSession) {
      setRegistering(false);
      return;
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/enrol-card`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authSession.access_token}`,
        },
        body: JSON.stringify({
          uid: cardUid.trim(),
          student_id: selectedStudent.id,
        }),
      });

      // Stop enrolment mode timers on any definitive outcome
      if (timerRef.current) clearInterval(timerRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      setEnrolActive(false);

      if (res.status === 201) {
        setResult({
          kind: "success",
          studentName: selectedStudent.full_name,
          uid: cardUid.trim().toUpperCase(),
        });
        return;
      }

      const body = await res.json().catch(() => ({}));

      if (res.status === 409) {
        const detail: string = body.detail ?? body.error ?? "";
        if (detail.includes("(uid)") || body.error?.includes("already registered to another") || body.conflict_type === "uid_registered") {
          setResult({
            kind: "uid_conflict",
            message: body.error,
            existingStudent: body.existing_student?.full_name,
            existingMatric: body.existing_student?.matric_number,
            uid: cardUid.trim().toUpperCase(),
          });
        } else {
          setResult({ kind: "student_conflict" });
        }
        return;
      }

      setResult({
        kind: "error",
        message: body.error ?? `Unexpected error (${res.status})`,
      });
    } catch (err) {
      setResult({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setRegistering(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Reset everything
  // ---------------------------------------------------------------------------
  const handleReset = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    setQuery("");
    setSearchResults([]);
    setSelectedStudent(null);
    setEnrolActive(false);
    setCountdown(ENROL_MODE_TTL);
    setAnimKey((k) => k + 1);
    setCardUid("");
    setResult(null);
  };

  // ---------------------------------------------------------------------------
  // Derived UI helpers
  // ---------------------------------------------------------------------------
  const progressPct = Math.max(0, Math.min(100, (countdown / ENROL_MODE_TTL) * 100));
  const isLow = countdown <= 10;

  // ---------------------------------------------------------------------------
  // Render — Result screen
  // ---------------------------------------------------------------------------
  if (result) {
    return (
      <div className="max-w-lg mx-auto py-10">
        <PageHeading />
        <div className="mt-8">
          {result.kind === "success" && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 flex flex-col gap-4 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
                  <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </span>
                <h2 className="text-emerald-700 font-semibold text-lg">Card registered</h2>
              </div>
              <div className="text-sm text-slate-700 space-y-1">
                <p><span className="text-slate-500">Student:</span> {result.studentName}</p>
                <p className="text-xs text-emerald-700 font-medium">NFC Card successfully assigned</p>
              </div>
            </div>
          )}

          {result.kind === "uid_conflict" && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-6 flex flex-col gap-4 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-200">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 ring-4 ring-red-50">
                  <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </span>
                <div>
                  <h2 className="text-red-900 font-semibold text-base">Card Already Assigned</h2>
                  <p className="text-xs text-red-600">Hardware node rejected this NFC card</p>
                </div>
              </div>

              <div className="rounded-xl bg-white border border-red-100 p-4 space-y-2 text-sm shadow-xs">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500 font-medium">Current Cardholder</span>
                  <span className="font-semibold text-slate-900">
                    {result.existingStudent || "Another Student"}
                  </span>
                </div>
                {result.existingMatric && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500 font-medium">Matric Number</span>
                    <span className="font-mono text-xs text-slate-700">
                      {result.existingMatric}
                    </span>
                  </div>
                )}
              </div>

              <p className="text-xs text-slate-600 leading-relaxed">
                This card cannot be assigned to{" "}
                <span className="font-medium text-slate-900">{selectedStudent?.full_name || "this student"}</span>{" "}
                because it is already bound to another student. Please take a different blank card and scan again.
              </p>

              {selectedStudent && (
                <button
                  type="button"
                  onClick={() => {
                    setResult(null);
                    handleActivate();
                  }}
                  className="w-full py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 shadow-sm"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Scan Another Card for {selectedStudent.full_name.split(" ")[0]}
                </button>
              )}
            </div>
          )}

          {result.kind === "student_conflict" && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 flex flex-col gap-3 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100">
                  <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M4.93 4.93l14.14 14.14M12 2a10 10 0 100 20A10 10 0 0012 2z" />
                  </svg>
                </span>
                <h2 className="text-amber-700 font-semibold text-lg">Student already has a card</h2>
              </div>
              <p className="text-sm text-slate-700">
                This student already has a card. Delete the existing one first, then re-register.
              </p>
            </div>
          )}

          {result.kind === "session_conflict" && (
            <div className="rounded-2xl border border-orange-200 bg-orange-50 p-6 flex flex-col gap-3 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-100">
                  <svg className="w-5 h-5 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </span>
                <h2 className="text-orange-700 font-semibold text-lg">Session currently active</h2>
              </div>
              <p className="text-sm text-slate-700">
                The ESP32 node already has an active attendance session running. A single device
                cannot be in enrolment mode and attendance mode at the same time.
              </p>
              <p className="text-sm text-slate-500">
                End the active session from the Sessions page, then try again.
              </p>
            </div>
          )}

          {result.kind === "error" && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-6 flex flex-col gap-3 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
                  <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </span>
                <h2 className="text-red-700 font-semibold text-lg">Error</h2>
              </div>
              <p className="text-sm text-slate-700 font-mono">{result.message}</p>
            </div>
          )}

          <button
            id="enrol-another-btn"
            onClick={handleReset}
            className="mt-6 w-full py-2.5 rounded-xl border border-slate-200 bg-white text-slate-900 text-sm font-semibold hover:bg-slate-50 shadow-sm transition-all duration-150"
          >
            Enrol another student
          </button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — Main flow
  // ---------------------------------------------------------------------------
  return (
    <div className="max-w-lg mx-auto py-10">
      <PageHeading />

      {/* ====================================================================
          SECTION 1 — Find student
      ==================================================================== */}
      <section className="mt-8">
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-3">
          1 · Find student
        </h2>

        {/* Search input */}
        <div className="relative">
          <div className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center">
            <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
            </svg>
          </div>
          <input
            id="student-search-input"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (selectedStudent) setSelectedStudent(null);
            }}
            placeholder="Search by name or matric number"
            className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 bg-white text-slate-900 placeholder-slate-400 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 shadow-sm transition-all"
          />
          {isSearching && (
            <div className="absolute inset-y-0 right-3.5 flex items-center">
              <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>

        {/* Search results */}
        {searchResults.length > 0 && !selectedStudent && (
          <ul className="mt-2 rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden divide-y divide-slate-100 relative z-10">
            {searchResults.map((student) => (
              <li key={student.id}>
                <button
                  id={`student-result-${student.id}`}
                  onClick={() => {
                    setSelectedStudent(student);
                    setSearchResults([]);
                    setQuery(`${student.full_name}${student.matric_number ? ` · ${student.matric_number}` : ""}`);
                  }}
                  className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors flex items-center justify-between group"
                >
                  <span className="text-slate-900 text-sm font-medium group-hover:text-indigo-600 transition-colors">
                    {student.full_name}
                  </span>
                  <span className="text-slate-500 text-xs font-mono">
                    {student.matric_number ?? "—"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {query.trim() && !isSearching && searchResults.length === 0 && !selectedStudent && (
          <p className="mt-3 text-sm text-slate-500 text-center">No students match &quot;{query}&quot;</p>
        )}

        {/* Selected student badge */}
        {selectedStudent && (
          <div className="mt-3 flex items-center gap-2 px-4 py-2.5 rounded-xl border border-indigo-200 bg-indigo-50">
            <svg className="w-4 h-4 text-indigo-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span className="text-indigo-900 text-sm font-medium flex-1">{selectedStudent.full_name}</span>
            <span className="text-slate-500 text-xs font-mono">{selectedStudent.matric_number ?? "—"}</span>
            <button
              id="clear-student-btn"
              onClick={() => { setSelectedStudent(null); setQuery(""); setEnrolActive(false); if (timerRef.current) clearInterval(timerRef.current); if (pollRef.current) clearInterval(pollRef.current); }}
              className="text-indigo-400 hover:text-indigo-700 transition-colors ml-1"
              aria-label="Clear selection"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
      </section>

      {/* ====================================================================
          SECTION 2 — Activate enrolment mode (only after student selected)
      ==================================================================== */}
      {selectedStudent && (
        <section className="mt-8">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-3">
            2 · Activate enrolment mode
          </h2>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 flex flex-col gap-4 shadow-sm">
            {/* Student summary */}
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-500">Registering card for</span>
              <span className="text-slate-900 font-semibold">{selectedStudent.full_name}</span>
            </div>
            <div className="border-t border-slate-100" />

            {!enrolActive ? (
              /* Activate button */
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="device_id" className="text-xs font-medium text-slate-700">
                    Hardware Node (Optional)
                  </label>
                  <select
                    id="device_id"
                    value={selectedDevice}
                    onChange={(e) => setSelectedDevice(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-slate-50 text-slate-900 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
                  >
                    <option value="" disabled>Select a physical node</option>
                    {devices.map((d) => {
                      const isOnline = d.last_seen && (new Date().getTime() - new Date(d.last_seen).getTime()) < 30000;
                      return (
                        <option key={d.device_id} value={d.device_id}>
                          {isOnline ? "🟢 " : ""}{d.device_id}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <button
                  id="activate-enrolment-btn"
                  onClick={handleActivate}
                  disabled={activating}
                  className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold transition-all duration-150 flex items-center justify-center gap-2"
                >
                {activating ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Activating…
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M5.636 18.364A9 9 0 1018.364 5.636 9 9 0 005.636 18.364z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    Activate enrolment mode
                  </>
                )}
                </button>
              </div>
            ) : (
              /* Active state */
              <div className="flex flex-col gap-4">
                {/* Pulsing status badge */}
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl border border-emerald-200 bg-emerald-50">
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  </span>
                  <span className="text-emerald-700 text-sm font-semibold">Waiting for card tap…</span>
                </div>

                {/* Countdown bar */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">Window closes in</span>
                    <span className={`font-mono font-bold tabular-nums transition-colors ${isLow ? "text-red-600" : "text-indigo-600"}`}>
                      {Math.max(0, countdown)}s
                    </span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      key={animKey}
                      className={`h-full rounded-full transition-colors duration-300 ${isLow ? "bg-red-500" : "bg-indigo-600"}`}
                      style={{
                        width: `${progressPct}%`,
                        transition: "width 1s linear, background-color 0.3s ease",
                      }}
                    />
                  </div>
                </div>

                {/* Cancel button */}
                <button
                  type="button"
                  onClick={async () => {
                    if (timerRef.current) clearInterval(timerRef.current);
                    if (pollRef.current) clearInterval(pollRef.current);
                    if (channelRef.current) {
                      supabase.removeChannel(channelRef.current);
                      channelRef.current = null;
                    }
                    setEnrolActive(false);
                    const { data: { session } } = await supabase.auth.getSession();
                    if (session) {
                      fetch(`${SUPABASE_URL}/functions/v1/enrolment-mode`, {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          Authorization: `Bearer ${session.access_token}`,
                        },
                        body: JSON.stringify({ action: "stop" }),
                      }).catch(() => {});
                    }
                  }}
                  className="text-xs text-slate-500 hover:text-slate-800 transition-colors text-center py-1"
                >
                  Cancel enrolment mode
                </button>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: page heading (avoids repetition in result screen)
// ---------------------------------------------------------------------------
function PageHeading() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Enrol NFC Card</h1>
      <p className="text-sm text-slate-600 mt-1">
        Register a student&apos;s NFC card to their account
      </p>
    </div>
  );
}
