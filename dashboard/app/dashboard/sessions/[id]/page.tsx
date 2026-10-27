"use client";

import { use, useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import QRCode from "qrcode";

const QR_TTL = 30;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;

interface AttendeeRow {
  id: string;
  student_id: string;
  full_name: string;
  matric_number: string | null;
  recorded_at: string;
  method: "nfc" | "qr";
  verification_method: string;
}

interface SessionInfo {
  course_code: string;
  course_title: string;
  total_enrolled: number;
}

export default function ActiveSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: sessionId } = use(params);
  const router = useRouter();

  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(QR_TTL);
  const [attendees, setAttendees] = useState<AttendeeRow[]>([]);
  const [isEnding, setIsEnding] = useState(false);
  const [isClosed, setIsClosed] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const [enrolledStudents, setEnrolledStudents] = useState<any[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);


  const accessTokenRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiresAtRef = useRef<number>(0);
  const isGeneratingRef = useRef(false);

  const supabase = useRef(createClient()).current;

  // --- Web NFC Emergency Reader state ---
  const [nfcMode, setNfcMode] = useState(false);
  const [nfcFeedback, setNfcFeedback] = useState<{ kind: "success" | "error" | "info"; msg: string } | null>(null);
  const [isNfcSupported, setIsNfcSupported] = useState(true);
  const ndefRef = useRef<any>(null); // NDEFReader instance
  const nfcAbortController = useRef<AbortController | null>(null);

  // ---------------------------------------------------------------------------
  // Generate QR from Edge Function
  // ---------------------------------------------------------------------------
  const generateQR = useCallback(async () => {
    if (isGeneratingRef.current) return;
    isGeneratingRef.current = true;

    try {
      // Always get fresh session token to avoid stale JWT rejections
      const { data: { session: authSession } } = await supabase.auth.getSession();
      const token = authSession?.access_token || accessTokenRef.current;
      if (!token) {
        console.warn("No access token available for generate-qr, retrying in 5s");
        expiresAtRef.current = Date.now() + 5000;
        return;
      }
      accessTokenRef.current = token;

      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/generate-qr`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ session_id: sessionId }),
        }
      );

      if (!res.ok) {
        console.error("generate-qr returned", res.status);
        expiresAtRef.current = Date.now() + 5000; // retry in 5s on failure
        return;
      }

      const payload = await res.json(); // { session_id, timestamp, signature }
      const qrContent = btoa(JSON.stringify(payload));

      const dataUrl = await QRCode.toDataURL(qrContent, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#0f172a", light: "#ffffff" },
      });

      setQrDataUrl(dataUrl);
      
      // Sync expiration to global 30s windows (+200ms buffer to cross interval boundary)
      const nowSecs = Math.floor(Date.now() / 1000);
      const remainder = QR_TTL - (nowSecs % QR_TTL);
      expiresAtRef.current = Date.now() + (remainder * 1000) + 200;
      setSecondsLeft(remainder);
    } catch (err) {
      console.error("QR generation failed:", err);
      expiresAtRef.current = Date.now() + 5000; // retry in 5s rather than freezing
    } finally {
      isGeneratingRef.current = false;
    }
  }, [sessionId, supabase]);

  // ---------------------------------------------------------------------------
  // Init: auth + session details + initial attendees + first QR
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Get access token
      const {
        data: { session: authSession },
      } = await supabase.auth.getSession();
      if (!authSession || cancelled) return;
      accessTokenRef.current = authSession.access_token;

      // Fetch session + course via join
      const { data: sessionRow, error: sessionErr } = await supabase
        .from("sessions")
        .select("id, ends_at, courses(id, course_code, course_title)")
        .eq("id", sessionId)
        .single();

      if (sessionErr || !sessionRow || cancelled) {
        setPageError("Session not found or you do not have access.");
        return;
      }

      const course = sessionRow.courses as unknown as {
        id: string;
        course_code: string;
        course_title: string;
      } | null;

      const { data: enrollments, count: totalEnrolled } = await supabase
        .from("course_enrollments")
        .select("student_id, profiles!student_id(id, full_name, matric_number)", { count: "exact" })
        .eq("course_id", course?.id)
        .eq("status", "approved");

      if (enrollments && !cancelled) {
        setEnrolledStudents(enrollments);
      }

      setSessionInfo({
        course_code: course?.course_code ?? "—",
        course_title: course?.course_title ?? "Unknown Course",
        total_enrolled: totalEnrolled ?? 0,
      });

      const closed = sessionRow.ends_at !== null;
      setIsClosed(closed);

      // Load existing attendees (in case of page refresh mid-session)
      const { data: logs } = await supabase
        .from("attendance_logs")
        .select(
          "id, student_id, method, verification_method, recorded_at, profiles(full_name, matric_number)"
        )
        .eq("session_id", sessionId)
        .order("recorded_at", { ascending: false });

      if (logs && !cancelled) {
        setAttendees(
          logs.map((log) => {
            const p = log.profiles as unknown as {
              full_name: string;
              matric_number: string | null;
            } | null;
            return {
              id: log.id,
              student_id: log.student_id,
              full_name: p?.full_name ?? "Unknown",
              matric_number: p?.matric_number ?? null,
              recorded_at: log.recorded_at,
              method: log.method as "nfc" | "qr",
              verification_method: log.verification_method,
            };
          })
        );
      }

      if (closed || cancelled) return;

      if (!cancelled) await generateQR();
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, supabase, generateQR]);

  // Check Web NFC support on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsNfcSupported("NDEFReader" in window);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Countdown timer — refresh QR when it hits 0
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (isClosed) return;
    timerRef.current = setInterval(() => {
      if (expiresAtRef.current === 0) return;

      const remaining = Math.max(0, Math.round((expiresAtRef.current - Date.now()) / 1000));
      setSecondsLeft(remaining);

      if (remaining <= 0) {
        expiresAtRef.current = Date.now() + 5000; // prevent multiple rapid triggers while in-flight
        generateQR();
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [generateQR, isClosed]);

  // ---------------------------------------------------------------------------
  // Heartbeat ping (Option B)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (isClosed) return;
    
    // Initial ping
    supabase.rpc("ping_session", { p_session_id: sessionId })
      .then(({ error }) => { if (error) console.error("RPC Ping Error:", error.message, error.details); });
    
    const pingInterval = setInterval(() => {
      supabase.rpc("ping_session", { p_session_id: sessionId })
        .then(({ error }) => { if (error) console.error("RPC Ping Error:", error.message, error.details); });
    }, 10000); // ping every 10 seconds

    return () => clearInterval(pingInterval);
  }, [sessionId, isClosed, supabase]);

  // ---------------------------------------------------------------------------
  // Realtime: subscribe to attendance_logs INSERTs for this session
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (isClosed) return;
    const channel = supabase
      .channel(`session-attendance-${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "attendance_logs",
          filter: `session_id=eq.${sessionId}`,
        },
        async (payload) => {
          const row = payload.new as {
            id: string;
            student_id: string;
            method: string;
            verification_method: string;
            recorded_at: string;
          };

          // Fetch the student's profile
          const { data: profile } = await supabase
            .from("profiles")
            .select("full_name, matric_number")
            .eq("id", row.student_id)
            .single();

          const newAttendee: AttendeeRow = {
            id: row.id,
            student_id: row.student_id,
            full_name: profile?.full_name ?? "Unknown",
            matric_number: profile?.matric_number ?? null,
            recorded_at: row.recorded_at,
            method: row.method as "nfc" | "qr",
            verification_method: row.verification_method,
          };

          setAttendees((prev) => {
            // Deduplicate by id in case polling already added this row
            if (prev.some((a) => a.id === newAttendee.id)) return prev;
            return [newAttendee, ...prev];
          });
          setLastUpdated(new Date());
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [sessionId, supabase, isClosed]);

  // ---------------------------------------------------------------------------
  // Polling fallback: re-fetch attendance every 15 s in case Realtime misses
  // an event (e.g. WebSocket reconnect, cold-start latency).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (isClosed) return;

    const fetchAttendees = async () => {
      const { data: logs } = await supabase
        .from("attendance_logs")
        .select(
          "id, student_id, method, verification_method, recorded_at, profiles(full_name, matric_number)"
        )
        .eq("session_id", sessionId)
        .order("recorded_at", { ascending: false });

      if (logs) {
        const rows: AttendeeRow[] = logs.map((log) => {
          const p = log.profiles as unknown as {
            full_name: string;
            matric_number: string | null;
          } | null;
          return {
            id: log.id,
            student_id: log.student_id,
            full_name: p?.full_name ?? "Unknown",
            matric_number: p?.matric_number ?? null,
            recorded_at: log.recorded_at,
            method: log.method as "nfc" | "qr",
            verification_method: log.verification_method,
          };
        });
        setAttendees(rows);
        setLastUpdated(new Date());
      }
    };

    const pollInterval = setInterval(fetchAttendees, 15000);
    return () => clearInterval(pollInterval);
  }, [sessionId, supabase, isClosed]);

  // ---------------------------------------------------------------------------
  // Web NFC Emergency Reader Logic
  // ---------------------------------------------------------------------------
  const toggleNfcMode = async () => {
    if (nfcMode) {
      // Turn off
      if (nfcAbortController.current) {
        nfcAbortController.current.abort();
        nfcAbortController.current = null;
      }
      setNfcMode(false);
      setNfcFeedback(null);
      return;
    }

    // Turn on
    setNfcFeedback(null);
    try {
      // Initialize NDEFReader
      // @ts-ignore - NDEFReader is not in standard TS lib yet
      const ndef = new NDEFReader();
      const abortController = new AbortController();
      nfcAbortController.current = abortController;
      ndefRef.current = ndef;

      await ndef.scan({ signal: abortController.signal });
      setNfcMode(true);
      setNfcFeedback({ kind: "info", msg: "Ready. Tap student card to phone." });

      ndef.addEventListener("reading", async ({ serialNumber }: any) => {
        if (!serialNumber) {
          setNfcFeedback({ kind: "error", msg: "Could not read NFC card." });
          return;
        }

        // Web NFC serialNumber is often like "04:60:8b:22:92:49:80".
        // record-nfc-tap accepts any hex format, as it normalizes to uppercase.
        const token = accessTokenRef.current;
        if (!token) return;

        setNfcFeedback({ kind: "info", msg: "Processing tap..." });

        try {
          const res = await fetch(`${SUPABASE_URL}/functions/v1/record-nfc-tap`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              uid: serialNumber,
              session_id: sessionId,
              source: "web_nfc",
            }),
          });

          const data = await res.json();

          if (res.status === 201) {
            setNfcFeedback({ kind: "success", msg: "Attendance recorded!" });
            // The Realtime subscription will automatically add them to the table.
          } else if (res.status === 409) {
            setNfcFeedback({ kind: "error", msg: "Student already marked present." });
          } else if (res.status === 404) {
            setNfcFeedback({ kind: "error", msg: "Card not registered to any student." });
          } else if (res.status === 401) {
            setNfcFeedback({ kind: "error", msg: "Session is no longer active." });
          } else {
            setNfcFeedback({ kind: "error", msg: data.error || "Failed to record tap." });
          }
        } catch (err) {
          setNfcFeedback({ kind: "error", msg: "Network error during tap processing." });
        }
      });

      ndef.addEventListener("readingerror", () => {
        setNfcFeedback({ kind: "error", msg: "Error reading card. Try again." });
      });

    } catch (err: any) {
      console.error(err);
      if (err.name === "NotAllowedError") {
        setNfcFeedback({ kind: "error", msg: "NFC permission denied." });
      } else {
        setNfcFeedback({ kind: "error", msg: "Failed to start NFC reader." });
      }
      setNfcMode(false);
    }
  };

  // ---------------------------------------------------------------------------
  // End session
  // ---------------------------------------------------------------------------
  const handleEndSession = async () => {
    setIsEnding(true);
    if (timerRef.current) clearInterval(timerRef.current);

    // Clear the active session on the ESP32 (whichever device is linked to this session).
    // Only session_id is nulled; activated_by / activated_at are left intact for audit.
    await supabase
      .from("device_sessions")
      .update({ session_id: null })
      .eq("session_id", sessionId);

    // Close the session in the database
    await supabase
      .from("sessions")
      .update({ ends_at: new Date().toISOString() })
      .eq("id", sessionId);

    // Clear enrolment mode flag just in case it was accidentally left active
    await supabase
      .from("enrolment_mode_flag")
      .update({ active: false, expires_at: null, activated_by: null, student_id: null, lecturer_id: null })
      .eq("id", 1);

    router.push("/dashboard");
  };



  // ---------------------------------------------------------------------------
  // Error state
  // ---------------------------------------------------------------------------
  if (pageError) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-center">
        <p className="text-red-400 font-medium">{pageError}</p>
        <button
          onClick={() => router.push("/dashboard")}
          className="text-sm text-indigo-400 hover:text-indigo-300 underline"
        >
          Back to dashboard
        </button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const ActionBlocks = () => (
    <>
      {/* Emergency NFC Reader Mode */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-slate-900 font-semibold text-sm">Emergency Reader</h3>
            <p className="text-slate-500 text-xs mt-0.5">Fallback for missing ESP32 node.</p>
            <p className="text-slate-500/70 text-[10px] mt-1">Note: Only supported on Chrome for Android.</p>
          </div>
          {!isNfcSupported ? (
            <span className="text-xs font-semibold text-slate-500 px-2 py-1 rounded-md bg-slate-800/50">
              UNSUPPORTED
            </span>
          ) : (
            <button
              onClick={toggleNfcMode}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                nfcMode ? "bg-emerald-500" : "bg-slate-300"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  nfcMode ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          )}
        </div>
        
        {!isNfcSupported ? (
          <div className="mt-3 text-xs text-amber-400/90 bg-amber-500/10 p-3 rounded-xl border border-amber-500/20 leading-relaxed">
            <strong>Web NFC is not supported in this browser.</strong>
            <br />
            Please use Chrome on an Android device to use your phone as an NFC reader.
          </div>
        ) : nfcMode && (
          <div
            className={`mt-3 text-sm p-3 rounded-xl border flex items-start gap-2.5 ${
              nfcFeedback?.kind === "success"
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                : nfcFeedback?.kind === "error"
                ? "bg-red-500/10 border-red-500/20 text-red-400"
                : "bg-sky-500/10 border-sky-500/20 text-sky-400"
            }`}
          >
            {nfcFeedback?.kind === "success" && (
              <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {nfcFeedback?.kind === "error" && (
              <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            {nfcFeedback?.kind === "info" && (
              <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <span className="leading-tight">{nfcFeedback?.msg || "Waiting for card tap..."}</span>
          </div>
        )}
      </div>
    </>
  );

  const handleExportCSV = () => {
    if (attendees.length === 0) {
      alert("No attendance records to export.");
      return;
    }

    const headers = ["Student Name", "Matric Number", "Recorded At", "Method", "Verification Method"];
    const rows = attendees.map((a) => [
      `"${a.full_name}"`,
      `"${a.matric_number || ""}"`,
      `"${new Date(a.recorded_at).toLocaleString()}"`,
      `"${a.method}"`,
      `"${a.verification_method}"`,
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${sessionInfo?.course_code || "session"}_attendance.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="flex flex-col lg:flex-row gap-5 h-auto lg:h-[calc(100vh-7rem)] pb-20 lg:pb-0">
      {/* ================================================================
          LEFT COLUMN — Course info + QR code + timer + end button
      ================================================================ */}
      <div className="w-full lg:w-[40%] flex flex-col gap-4 shrink-0">
        {/* Course info card */}
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 shadow-sm">
          <span className="text-xs font-mono font-semibold text-indigo-600 tracking-widest uppercase">
            {sessionInfo?.course_code ?? "—"}
          </span>
          <h1 className="text-slate-900 font-bold text-xl mt-1 leading-tight">
            {sessionInfo?.course_title ?? "Loading session…"}
          </h1>
          <p className="text-slate-500 text-xs mt-1">
            {isClosed ? "Session closed" : "Session in progress"}
          </p>
        </div>

        {isClosed ? (
          <div className="flex-1 flex flex-col items-center justify-center rounded-2xl border border-rose-200 bg-rose-50 p-6 gap-5">
            <svg className="w-12 h-12 text-rose-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <h2 className="text-rose-600 text-lg font-bold">Session Closed</h2>
            <p className="text-slate-600 text-sm text-center">
              This session is no longer active. No further attendance can be recorded.
            </p>
          </div>
        ) : (
          <>
            {/* QR code card */}
            <div className="flex-1 flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white p-6 gap-5 shadow-sm">
              <p className="text-slate-600 text-sm text-center">
                Students scan to mark attendance
              </p>

              {/* QR image */}
              <div className="bg-white p-3 rounded-2xl shadow-xl shadow-black/40">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="Attendance QR Code"
                    width={264}
                    height={264}
                    className="block rounded-lg"
                  />
                ) : (
                  <div className="w-64 h-64 flex items-center justify-center">
                    <div className="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full" />
                  </div>
                )}
              </div>

              {/* Countdown badge */}
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-50 border border-slate-200 text-xs font-medium text-slate-600">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Auto-rotates in <span className="font-mono font-bold text-slate-900">{secondsLeft}s</span>
              </div>
            </div>

          {/* End session */}
          <button
            id="end-session-btn"
            onClick={handleEndSession}
            disabled={isEnding}
            className="w-full py-3 rounded-xl border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 hover:text-red-700 font-semibold text-sm transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isEnding ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Ending session…
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                </svg>
                End session
              </>
            )}
          </button>

          <div className="hidden lg:flex flex-col gap-4">
            <ActionBlocks />
          </div>
        </>
        )}
      </div>

      {/* ================================================================
          RIGHT COLUMN — Live attendance table
      ================================================================ */}
      <div className="flex-1 flex flex-col rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden min-h-[500px] lg:min-h-0 min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-2.5">
            {/* Pulsing green dot */}
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
            <h2 className="text-slate-900 font-semibold text-sm">
              Live attendance
            </h2>
            {lastUpdated && (
              <span className="text-[10px] text-slate-400 tabular-nums">
                · updated {lastUpdated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <span className="text-2xl font-bold text-slate-900 tabular-nums">
                {attendees.length}
              </span>
              <span className="text-slate-500 text-xs ml-1.5">
                present / {sessionInfo?.total_enrolled ?? 0} enrolled
              </span>
            </div>
            <button
              onClick={handleExportCSV}
              className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-xs font-medium flex items-center gap-1.5 transition-colors shadow-sm"
              title="Export to CSV"
            >
              <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          </div>
        </div>

        {/* Table / empty state */}
        <div className="flex-1 overflow-auto">
          {attendees.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-500">
              <div className="flex items-end gap-1.5 h-6">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-1.5 rounded-full bg-slate-300 animate-bounce"
                    style={{
                      height: `${12 + i * 6}px`,
                      animationDelay: `${i * 0.12}s`,
                    }}
                  />
                ))}
              </div>
              <p className="text-sm">Waiting for students…</p>
            </div>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur-sm shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
                <tr className="text-left">
                  <th className="px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Matric No.
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Time
                  </th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wider">
                    Method
                  </th>
                </tr>
              </thead>
              <tbody>
                {attendees.map((a, idx) => (
                  <tr
                    key={a.id}
                    className="border-t border-slate-100 hover:bg-slate-50 transition-colors"
                    style={{
                      animation: idx === 0 ? "fadeSlideIn 0.3s ease-out" : undefined,
                    }}
                  >
                    <td className="px-6 py-3.5 text-slate-900 font-medium whitespace-nowrap">
                      {a.full_name}
                    </td>
                    <td className="px-4 py-3.5 text-slate-500 font-mono text-xs whitespace-nowrap">
                      {a.matric_number ?? "—"}
                    </td>
                    <td className="px-4 py-3.5 text-slate-500 tabular-nums whitespace-nowrap">
                      {new Date(a.recorded_at).toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-3.5 whitespace-nowrap">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                          a.method === "nfc"
                            ? "bg-sky-500/10 text-sky-400 border-sky-500/20"
                            : "bg-violet-500/10 text-violet-400 border-violet-500/20"
                        }`}
                      >
                        {a.method === "nfc" ? (
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M20.5 6A1.5 1.5 0 0019 4.5h-2v3H19a1.5 1.5 0 001.5-1.5zM17 10h2a3 3 0 000-6h-2v6zm-2 1H9V4H5v16h4v-7h6v7h4V4h-4v7z" />
                          </svg>
                        ) : (
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                          </svg>
                        )}
                        {a.verification_method ? a.verification_method.toUpperCase() : a.method.toUpperCase()}
                      </span>
                    </td>
                  </tr>
                ))}
                {isClosed &&
                  enrolledStudents
                    .filter((e) => !attendees.some((a) => a.student_id === e.student_id))
                    .map((absentStudent, idx) => {
                      const p = absentStudent.profiles as { full_name: string; matric_number: string | null };
                      return (
                        <tr
                          key={`absent-${absentStudent.student_id}`}
                          className="border-t border-slate-100 bg-rose-50/30 transition-colors"
                        >
                          <td className="px-6 py-3.5 text-slate-900 font-medium whitespace-nowrap opacity-80">
                            {p?.full_name || "Unknown"}
                          </td>
                          <td className="px-4 py-3.5 text-slate-500 font-mono text-xs whitespace-nowrap opacity-80">
                            {p?.matric_number ?? "—"}
                          </td>
                          <td className="px-4 py-3.5 text-rose-500 tabular-nums whitespace-nowrap font-medium text-xs">
                            ABSENT
                          </td>
                          <td className="px-4 py-3.5 whitespace-nowrap">
                            —
                          </td>
                        </tr>
                      );
                    })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ================================================================
          ACTIONS (Mobile only, rendered after the table)
      ================================================================ */}
      {!isClosed && (
        <div className="flex lg:hidden flex-col gap-4 w-full mt-4">
          <ActionBlocks />
        </div>
      )}

      {/* Keyframe animation for new rows */}
      <style jsx global>{`
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
