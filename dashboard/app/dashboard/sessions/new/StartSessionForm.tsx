"use client";

import { useState } from "react";

export function StartSessionForm({
  createSession,
  devices,
}: {
  createSession: (formData: FormData) => void;
  devices: { device_id: string; last_seen: string | null; current_mode: string | null }[];
}) {
  const [isLocating, setIsLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    
    setIsLocating(true);
    setGeoError(null);

    if (!navigator.geolocation) {
      setGeoError("Geolocation is not supported by your browser");
      setIsLocating(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        formData.append("latitude", position.coords.latitude.toString());
        formData.append("longitude", position.coords.longitude.toString());
        createSession(formData);
      },
      (error) => {
        console.error("Error getting location", error);
        setGeoError("Failed to get your location. Please allow location access to start the session.");
        setIsLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="device_id" className="text-sm font-medium text-slate-700">
          Hardware Reader Device
        </label>
        <select
          id="device_id"
          name="device_id"
          className="px-4 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-900 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
          defaultValue=""
        >
          <option value="" disabled>Select a physical node (optional)</option>
          {devices.map((d) => {
            const isOnline = d.last_seen && (new Date().getTime() - new Date(d.last_seen).getTime()) < 30000;
            return (
              <option key={d.device_id} value={d.device_id}>
                {isOnline ? "🟢 " : ""}{d.device_id}
              </option>
            );
          })}
        </select>
        <p className="text-xs text-slate-500">
          The physical ESP32 node placed in the classroom. It must be online to process NFC taps.
        </p>
      </div>

      {geoError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
          {geoError}
        </div>
      )}

      <div className="flex justify-end gap-3 mt-4">
        <a
          href="/dashboard"
          className="px-4 py-2.5 rounded-lg bg-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors text-sm font-semibold"
        >
          Cancel
        </a>
        <button
          type="submit"
          disabled={isLocating}
          className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isLocating ? (
            <>
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Locating...
            </>
          ) : (
            "Start Session"
          )}
        </button>
      </div>
    </form>
  );
}
