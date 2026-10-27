"use client";

import { useEffect, useState, useRef } from "react";
import { createClient } from "@/utils/supabase/client";

export interface HardwareEvent {
  id: string;
  device_id: string;
  event_type: "enrol_success" | "enrol_error" | "tap_success" | "tap_error" | "tap_warning" | string;
  status: "success" | "error" | "warning" | "info" | string;
  message: string;
  payload?: any;
  created_at: string;
}

export default function HardwareEventMonitor() {
  const [events, setEvents] = useState<HardwareEvent[]>([]);
  const [activeToast, setActiveToast] = useState<HardwareEvent | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [lastActivity, setLastActivity] = useState<Date | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const supabase = useRef(createClient()).current;

  const sanitizeMessage = (text: string): string => {
    if (!text) return "";
    return text
      .replace(/\bUID\s+([0-9A-Fa-f]{2}[:\s\-]){3,6}[0-9A-Fa-f]{2}\b/gi, "NFC Card")
      .replace(/\(([0-9A-Fa-f]{2}[:\s\-]){3,6}[0-9A-Fa-f]{2}\)/gi, "")
      .replace(/\b([0-9A-Fa-f]{2}[:\s\-]){3,6}[0-9A-Fa-f]{2}\b/gi, "NFC Card")
      .replace(/\s+/g, " ")
      .trim();
  };

  useEffect(() => {
    // 1. Load the most recent 10 events on mount
    const fetchRecent = async () => {
      const { data } = await supabase
        .from("device_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(10);
      if (data) {
        setEvents(data);
        if (data.length > 0) {
          setLastActivity(new Date(data[0].created_at));
        }
      }
    };
    fetchRecent();

    // 2. Subscribe to real-time events from hardware nodes
    const channel = supabase
      .channel("global-device-events")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "device_events",
        },
        (payload) => {
          const newEvent = payload.new as HardwareEvent;
          setEvents((prev) => [newEvent, ...prev.slice(0, 19)]);
          setLastActivity(new Date());
          
          // Show live pop-up toast
          setActiveToast(newEvent);
          if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
          toastTimeoutRef.current = setTimeout(() => {
            setActiveToast(null);
          }, 6000);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, [supabase]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "success":
        return "bg-emerald-100 text-emerald-700 border-emerald-200";
      case "error":
        return "bg-red-100 text-red-700 border-red-200";
      case "warning":
        return "bg-amber-100 text-amber-700 border-amber-200";
      default:
        return "bg-slate-100 text-slate-700 border-slate-200";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "success":
        return (
          <svg className="w-5 h-5 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        );
      case "error":
        return (
          <svg className="w-5 h-5 text-red-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        );
      case "warning":
        return (
          <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M4.93 4.93l14.14 14.14M12 2a10 10 0 100 20A10 10 0 0012 2z" />
          </svg>
        );
      default:
        return (
          <svg className="w-5 h-5 text-slate-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
    }
  };

  return (
    <>
      {/* -------------------------------------------------------------------- */}
      {/* 1. Real-time Toast Notification (Top Center / Right) */}
      {/* -------------------------------------------------------------------- */}
      {activeToast && (
        <div className="fixed top-5 right-5 z-50 max-w-md w-full animate-bounce-in shadow-2xl rounded-2xl bg-white border border-slate-200 p-4 transition-all">
          <div className="flex items-start gap-3">
            <div className="mt-0.5">{getStatusIcon(activeToast.status)}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-wider ${getStatusBadge(activeToast.status)}`}>
                  Hardware Event · {activeToast.device_id}
                </span>
                <button
                  onClick={() => setActiveToast(null)}
                  className="text-slate-400 hover:text-slate-600 p-1"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <p className="text-sm font-medium text-slate-900 mt-1 leading-snug">
                {sanitizeMessage(activeToast.message)}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* 2. Floating Live Activity Pill (Bottom Right) */}
      {/* -------------------------------------------------------------------- */}
      <div className="fixed bottom-6 right-6 z-40">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-slate-900/90 hover:bg-slate-900 text-white text-xs font-semibold shadow-lg backdrop-blur-md border border-slate-700 hover:scale-105 active:scale-95 transition-all"
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <span>Hardware Feed</span>
          {events.length > 0 && (
            <span className="ml-1 px-1.5 py-0.2 rounded-full bg-slate-800 text-[10px] text-slate-300 font-mono">
              {events.length}
            </span>
          )}
        </button>

        {/* ------------------------------------------------------------------ */}
        {/* 3. Slide-up Hardware Event History Log */}
        {/* ------------------------------------------------------------------ */}
        {isOpen && (
          <div className="absolute bottom-12 right-0 w-96 max-h-[460px] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden animate-fadeIn">
            {/* Header */}
            <div className="p-3.5 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                <h3 className="text-xs font-bold tracking-wide uppercase">Live Hardware Activity</h3>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="text-slate-400 hover:text-white text-xs px-1.5 py-0.5 rounded"
              >
                ✕
              </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto divide-y divide-slate-100 p-2 space-y-1">
              {events.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400">
                  No card swipes detected yet.
                </div>
              ) : (
                events.map((ev) => (
                  <div key={ev.id} className="p-2.5 rounded-xl hover:bg-slate-50 transition-colors">
                    <div className="flex items-center justify-between gap-1 text-[11px] mb-1">
                      <span className={`px-1.5 py-0.5 rounded font-bold uppercase tracking-wider text-[9px] border ${getStatusBadge(ev.status)}`}>
                        {ev.event_type.replace("_", " ")}
                      </span>
                      <span className="text-slate-400 text-[10px]">
                        {new Date(ev.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                    </div>
                    <p className="text-xs text-slate-800 font-medium leading-snug">
                      {sanitizeMessage(ev.message)}
                    </p>
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="p-2 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 px-3">
              <span>{lastActivity ? `Last activity: ${lastActivity.toLocaleTimeString()}` : "Listening for taps..."}</span>
              <button
                onClick={() => setEvents([])}
                className="text-indigo-600 hover:text-indigo-800 font-semibold text-[11px]"
              >
                Clear
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
