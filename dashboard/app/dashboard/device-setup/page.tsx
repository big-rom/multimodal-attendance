"use client";

import { useEffect, useState, useRef } from "react";

export default function DeviceSetupPage() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [port, setPort] = useState<any>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  
  const [deviceState, setDeviceState] = useState<{
    ip?: string;
    mode?: string;
    version?: string;
  }>({});

  const readerRef = useRef<any>(null);
  const writerRef = useRef<any>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setSupported("serial" in navigator);
    }
  }, []);

  // Auto scroll logs inside the terminal container only (never jumps the page)
  useEffect(() => {
    if (autoScroll && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const addLog = (msg: string) => {
    setLogs((prev) => [...prev, msg].slice(-50)); // keep last 50
  };

  const connect = async () => {
    try {
      const nav = navigator as any;
      const selectedPort = await nav.serial.requestPort({
        filters: [
          { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
          { usbVendorId: 0x1a86 }, // QinHeng CH340
          { usbVendorId: 0x0403 }, // FTDI
        ]
      });
      await selectedPort.open({ baudRate: 115200 });
      setPort(selectedPort);
      
      const textDecoder = new window.TextDecoderStream();
      selectedPort.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();
      readerRef.current = reader;

      const textEncoder = new window.TextEncoderStream();
      textEncoder.readable.pipeTo(selectedPort.writable);
      const writer = textEncoder.writable.getWriter();
      writerRef.current = writer;

      addLog("[System] Connected to ESP32 serial port.");
      
      // Request initial state
      writer.write('{"cmd":"get_state"}\n');

      readLoop(reader);
    } catch (e: any) {
      console.error(e);
      addLog(`[System] Error connecting: ${e.message}`);
    }
  };

  const readLoop = async (reader: any) => {
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";
          
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            // Log raw line
            addLog(trimmed);
            
            // Try parse structured events
            if (trimmed.startsWith("{")) {
              try {
                const doc = JSON.parse(trimmed);
                if (doc.event === "wifi_connected") {
                  setDeviceState((s) => ({ ...s, ip: doc.ip }));
                } else if (doc.event === "state_report") {
                  setDeviceState((s) => ({
                    ...s,
                    ip: doc.ip,
                    mode: doc.mode,
                    version: doc.version,
                  }));
                } else if (doc.event === "mode_changed") {
                  setDeviceState((s) => ({ ...s, mode: doc.mode }));
                } else if (doc.event === "boot") {
                  setDeviceState((s) => ({ ...s, version: doc.version, ip: undefined, mode: undefined }));
                }
              } catch (err) {
                // Ignore parse errors, it's just raw serial
              }
            }
          }
        }
      }
    } catch (error) {
      console.error("Read loop error", error);
      addLog(`[System] Connection lost: ${error}`);
      setPort(null);
    } finally {
      reader.releaseLock();
    }
  };

  const saveWifi = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!writerRef.current) return;
    const cmd = JSON.stringify({ cmd: "set_wifi", ssid, pass: password }) + "\n";
    addLog(`[TX] Setting Wi-Fi (SSID: ${ssid})`);
    try {
      await writerRef.current.write(cmd);
      setSsid("");
      setPassword("");
    } catch (e: any) {
      addLog(`[System] Error writing: ${e.message}`);
    }
  };

  const forgetWifi = async () => {
    if (!writerRef.current) return;
    try {
      await writerRef.current.write('{"cmd":"clear_wifi"}\n');
      addLog("[System] Sent clear_wifi command.");
      alert("Credentials cleared. The device will reboot.");
    } catch (e: any) {
      console.error(e);
      alert("Failed to clear credentials.");
    }
  };

  if (supported === null) return null;

  if (supported === false) {
    return (
      <div className="max-w-2xl mx-auto mt-10 p-8 rounded-2xl bg-white border border-red-200 shadow-sm text-center">
        <svg className="w-16 h-16 text-red-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <h1 className="text-2xl font-bold text-slate-800 mb-2">Browser Not Supported</h1>
        <p className="text-slate-600">
          The Web Serial API required to configure the hardware node is not supported in this browser. 
          Please use <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong>.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto pb-12">
      {/* Configuration Column */}
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Device Setup</h1>
          <p className="text-slate-500 mt-1">Configure hardware nodes directly via USB.</p>
        </div>

        {/* Status Card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 bg-slate-50/50 p-4">
            <h2 className="font-semibold text-slate-800">Connection Status</h2>
          </div>
          <div className="p-6">
            {!port ? (
              <div className="text-center">
                <svg className="w-12 h-12 text-slate-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <p className="text-slate-500 mb-4 text-sm">Plug in the ESP32 via USB and click Connect.</p>
                <button
                  onClick={connect}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-lg font-medium transition-colors inline-flex items-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  Connect to Node
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 rounded-xl p-4 border border-slate-100">
                  <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Status</span>
                  <div className="mt-1 flex items-center gap-2 text-emerald-600 font-semibold">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    Connected
                  </div>
                </div>
                <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 flex flex-col justify-between">
                  <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Firmware</span>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-slate-900 font-semibold">
                      {deviceState.version ? (deviceState.version.startsWith("v") ? deviceState.version : `v${deviceState.version}`) : "Unknown"}
                    </span>
                    {deviceState.version && !["1.0", "1.0.0"].includes(deviceState.version) && (
                      <span className="text-[10px] bg-amber-100 text-amber-700 font-bold px-2 py-0.5 rounded ml-2">Update Available</span>
                    )}
                  </div>
                </div>
                <div className="bg-slate-50 rounded-xl p-4 border border-slate-100">
                  <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">IP Address</span>
                  <div className="mt-1 text-slate-900 font-semibold font-mono text-sm">
                    {deviceState.ip || "Waiting..."}
                  </div>
                </div>
                <div className="bg-slate-50 rounded-xl p-4 border border-slate-100">
                  <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Mode</span>
                  <div className="mt-1 text-slate-900 font-semibold capitalize">
                    {deviceState.mode || "Waiting..."}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Wi-Fi Config */}
        <div className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-opacity duration-300 ${!port ? "opacity-50 pointer-events-none border-slate-200" : "border-indigo-100"}`}>
          <div className="border-b border-slate-100 bg-slate-50/50 p-4">
            <h2 className="font-semibold text-slate-800">Wi-Fi Configuration</h2>
          </div>
          <form onSubmit={saveWifi} className="p-6 flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">SSID (Network Name)</label>
              <input
                type="text"
                required
                value={ssid}
                onChange={e => setSsid(e.target.value)}
                className="w-full bg-white text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded-lg shadow-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 sm:text-sm p-2.5 outline-none font-medium"
                placeholder="e.g. Eduroam"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full bg-white text-slate-900 placeholder:text-slate-400 border border-slate-300 rounded-lg shadow-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 sm:text-sm p-2.5 outline-none font-medium"
                placeholder="Leave blank if open network"
              />
            </div>
            <div className="flex gap-2 mt-2">
              <button
                type="submit"
                disabled={!port || !ssid}
                className="flex-1 bg-slate-900 hover:bg-slate-800 text-white disabled:bg-slate-300 px-5 py-2.5 rounded-lg font-medium transition-colors"
              >
                Save & Reboot
              </button>
              <button
                type="button"
                onClick={forgetWifi}
                disabled={!port}
                className="flex-1 bg-rose-50 hover:bg-rose-100 text-rose-700 disabled:bg-slate-100 disabled:text-slate-400 border border-rose-200 disabled:border-slate-200 px-5 py-2.5 rounded-lg font-medium transition-colors"
              >
                Forget Credentials
              </button>
            </div>
          </form>
        </div>

        {/* Live Logs Terminal */}
        <div className="bg-slate-900 rounded-2xl shadow-sm overflow-hidden flex flex-col h-80">
          <div className="border-b border-slate-800 bg-slate-900/50 p-3 px-4 flex justify-between items-center">
            <h2 className="font-semibold text-slate-200 text-sm flex items-center gap-2">
              <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M4 15a2 2 0 002 2h12a2 2 0 002-2V9a2 2 0 00-2-2H6a2 2 0 00-2 2v6z" />
              </svg>
              Live Serial Logs
            </h2>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none hover:text-slate-300">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-0 w-3.5 h-3.5"
                />
                Auto-scroll
              </label>
              {logs.length > 0 && (
                <button
                  type="button"
                  onClick={() => setLogs([])}
                  className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
                >
                  Clear
                </button>
              )}
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-slate-700"></div>
                <div className="w-2.5 h-2.5 rounded-full bg-slate-700"></div>
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></div>
              </div>
            </div>
          </div>
          <div
            ref={logsContainerRef}
            className="flex-1 p-4 overflow-y-auto font-mono text-xs text-emerald-400 leading-relaxed scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent"
          >
            {logs.length === 0 ? (
              <span className="text-slate-600 italic">Waiting for serial data...</span>
            ) : (
              logs.map((log, i) => (
                <div key={i} className="break-all whitespace-pre-wrap">{log}</div>
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
