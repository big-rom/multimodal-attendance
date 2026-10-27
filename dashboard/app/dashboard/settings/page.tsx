"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/utils/supabase/client";

export default function SettingsPage() {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);
  const [isLoadingSecurity, setIsLoadingSecurity] = useState(false);
  
  const [profileMessage, setProfileMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [securityMessage, setSecurityMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const supabase = createClient();

  useEffect(() => {
    async function loadProfile() {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        setEmail(user.email || "");
        const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", user.id).single();
        if (profile) {
          setFullName(profile.full_name);
        }
      }
    }
    loadProfile();
  }, []);

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoadingProfile(true);
    setProfileMessage(null);
    
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    
    const updates = [];
    if (user.email !== email) {
      const { error } = await supabase.auth.updateUser({ email });
      if (error) {
        setProfileMessage({ type: "error", text: error.message });
        setIsLoadingProfile(false);
        return;
      }
      updates.push("Email updated (please check your inbox to confirm)");
    }
    
    const { error: profileError } = await supabase.from("profiles").update({ full_name: fullName }).eq("id", user.id);
    if (profileError) {
      setProfileMessage({ type: "error", text: profileError.message });
    } else {
      updates.push("Name updated");
      setProfileMessage({ type: "success", text: updates.join(". ") + "." });
    }
    setIsLoadingProfile(false);
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setSecurityMessage({ type: "error", text: "Passwords do not match." });
      return;
    }
    if (newPassword.length < 6) {
      setSecurityMessage({ type: "error", text: "Password must be at least 6 characters." });
      return;
    }

    setIsLoadingSecurity(true);
    setSecurityMessage(null);

    const { data: { user } } = await supabase.auth.getUser();

    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) {
      setSecurityMessage({ type: "error", text: error.message });
    } else {
      if (user) {
        await supabase.from("profiles").update({ force_password_reset: false }).eq("id", user.id);
      }
      setSecurityMessage({ type: "success", text: "Password updated successfully!" });
      setNewPassword("");
      setConfirmPassword("");
    }
    setIsLoadingSecurity(false);
  };

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-8 h-full pb-10">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Settings</h1>
        <p className="text-sm text-slate-600 mt-1">
          Manage your account preferences and security.
        </p>
      </div>

      <div className="bg-white border border-slate-200 shadow-sm rounded-2xl overflow-hidden p-6">
        <h2 className="text-lg font-bold text-slate-900 mb-4">Profile</h2>
        <form onSubmit={handleUpdateProfile} className="max-w-md space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Full Name
            </label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Email Address
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {profileMessage && (
            <div
              className={`p-3 rounded-lg text-sm border ${
                profileMessage.type === "error"
                  ? "bg-rose-50 border-rose-200 text-rose-600"
                  : "bg-emerald-50 border-emerald-200 text-emerald-600"
              }`}
            >
              {profileMessage.text}
            </div>
          )}

          <div className="pt-2">
            <button
              type="submit"
              disabled={isLoadingProfile}
              className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors shadow-sm disabled:opacity-50"
            >
              {isLoadingProfile ? "Saving..." : "Save Profile"}
            </button>
          </div>
        </form>
      </div>

      <div className="bg-white border border-slate-200 shadow-sm rounded-2xl overflow-hidden p-6">
        <h2 className="text-lg font-bold text-slate-900 mb-4">Security</h2>
        
        <form onSubmit={handleUpdatePassword} className="max-w-md space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              New Password
            </label>
            <input
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder="••••••••"
              minLength={6}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Confirm New Password
            </label>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              placeholder="••••••••"
              minLength={6}
            />
          </div>

          {securityMessage && (
            <div
              className={`p-3 rounded-lg text-sm border ${
                securityMessage.type === "error"
                  ? "bg-rose-50 border-rose-200 text-rose-600"
                  : "bg-emerald-50 border-emerald-200 text-emerald-600"
              }`}
            >
              {securityMessage.text}
            </div>
          )}

          <div className="pt-2">
            <button
              type="submit"
              disabled={isLoadingSecurity}
              className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors shadow-sm disabled:opacity-50"
            >
              {isLoadingSecurity ? "Resetting..." : "Reset Password"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
