"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { useRouter } from "next/navigation";

type Enrollment = {
  id: string;
  status: string;
  rejection_reason: string | null;
  requested_at: string;
  decided_at: string | null;
  eligibility_percentage: number;
  profiles: {
    id: string;
    full_name: string;
    matric_number: string;
  };
};

export default function EnrollmentManager({
  initialEnrollments,
}: {
  initialEnrollments: Enrollment[];
}) {
  const [enrollments, setEnrollments] = useState(initialEnrollments);
  const [activeTab, setActiveTab] = useState<"pending" | "approved" | "rejected">("pending");
  const [isRejectModalOpen, setIsRejectModalOpen] = useState(false);
  const [rejectingEnrollmentId, setRejectingEnrollmentId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const supabase = createClient();
  const router = useRouter();

  const handleApprove = async (enrollmentId: string) => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.rpc("decide_enrollment", {
        p_enrollment_id: enrollmentId,
        p_decision: "approve",
      });

      if (error) throw new Error(error.message);

      setEnrollments((prev) =>
        prev.map((e) => (e.id === enrollmentId ? { ...e, status: "approved" } : e))
      );
      router.refresh();
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to approve.");
    } finally {
      setIsLoading(false);
    }
  };

  const openRejectModal = (enrollmentId: string) => {
    setRejectingEnrollmentId(enrollmentId);
    setRejectionReason("");
    setIsRejectModalOpen(true);
  };

  const handleReject = async () => {
    if (!rejectingEnrollmentId) return;
    if (rejectionReason.trim().length < 5) {
      setErrorMsg("Rejection reason must be at least 5 characters.");
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.rpc("decide_enrollment", {
        p_enrollment_id: rejectingEnrollmentId,
        p_decision: "reject",
        p_reason: rejectionReason.trim(),
      });

      if (error) throw new Error(error.message);

      setEnrollments((prev) =>
        prev.map((e) =>
          e.id === rejectingEnrollmentId
            ? { ...e, status: "rejected", rejection_reason: rejectionReason.trim() }
            : e
        )
      );
      setIsRejectModalOpen(false);
      router.refresh();
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to reject.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetDevice = async (studentId: string) => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ device_id: null })
        .eq("id", studentId);
      
      if (error) throw new Error(error.message);
      
      alert("Student's device binding has been reset.");
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to reset device.");
    } finally {
      setIsLoading(false);
    }
  };

  const filteredEnrollments = enrollments.filter((e) => e.status === activeTab);

  return (
    <div className="flex flex-col h-full relative">
      {/* Tabs */}
      <div className="flex items-center gap-4 px-6 border-b border-slate-200 bg-slate-50">
        {(["pending", "approved", "rejected"] as const).map((tab) => {
          const count = enrollments.filter((e) => e.status === tab).length;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`py-4 text-sm font-semibold capitalize relative transition-colors ${
                activeTab === tab
                  ? "text-indigo-600"
                  : "text-slate-500 hover:text-slate-900"
              }`}
            >
              {tab} ({count})
              {activeTab === tab && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-indigo-600 rounded-t-full" />
              )}
            </button>
          );
        })}
      </div>

      {errorMsg && (
        <div className="m-6 p-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-600 text-sm">
          {errorMsg}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {filteredEnrollments.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500 py-12">
            <p>No {activeTab} requests found.</p>
          </div>
        ) : (
          <table className="w-full text-left text-sm text-slate-700">
            <thead className="text-xs uppercase bg-slate-50 border-b border-slate-200 text-slate-500 sticky top-0 backdrop-blur-md">
              <tr>
                <th className="px-6 py-4 font-semibold">Student Name</th>
                <th className="px-6 py-4 font-semibold">Matric Number</th>
                <th className="px-6 py-4 font-semibold">Requested At</th>
                {activeTab === "rejected" && (
                  <th className="px-6 py-4 font-semibold">Reason</th>
                )}
                {(activeTab === "pending" || activeTab === "approved") && (
                  <th className="px-6 py-4 font-semibold text-right">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredEnrollments.map((e) => (
                <tr key={e.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-6 py-4 font-medium text-slate-900">
                    <div className="flex items-center gap-2">
                      {e.profiles?.full_name || "Unknown"}
                      {activeTab === "approved" && e.eligibility_percentage < 75 && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-700 tracking-wide uppercase border border-rose-200">
                          At Risk
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 font-mono text-xs text-indigo-700">
                    {e.profiles?.matric_number || "N/A"}
                  </td>
                  <td className="px-6 py-4 text-slate-600">
                    {new Date(e.requested_at).toLocaleDateString()}
                  </td>
                  {activeTab === "rejected" && (
                    <td className="px-6 py-4 text-rose-600 max-w-xs truncate">
                      {e.rejection_reason}
                    </td>
                  )}
                  {activeTab === "pending" && (
                    <td className="px-6 py-4 text-right space-x-2">
                      <button
                        onClick={() => handleApprove(e.id)}
                        disabled={isLoading}
                        className="px-3 py-1.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-medium transition-colors disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => openRejectModal(e.id)}
                        disabled={isLoading}
                        className="px-3 py-1.5 rounded bg-rose-50 text-rose-700 hover:bg-rose-100 font-medium transition-colors disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </td>
                  )}
                  {activeTab === "approved" && (
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => handleResetDevice(e.profiles.id)}
                        disabled={isLoading}
                        className="px-3 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-indigo-600 font-medium transition-colors disabled:opacity-50"
                        title="Unbind the student's mobile device so they can log in on a new phone."
                      >
                        Reset Device
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Reject Modal */}
      {isRejectModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-2xl p-6">
            <h3 className="text-xl font-bold text-slate-900 mb-2">Reject Request</h3>
            <p className="text-sm text-slate-500 mb-4">
              Please provide a reason for rejecting this student. They will see this message.
            </p>
            <textarea
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="e.g., Wrong course, contact dept..."
              className="w-full bg-white border border-slate-300 rounded-lg p-3 text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 mb-4 resize-none h-24"
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setIsRejectModalOpen(false)}
                disabled={isLoading}
                className="px-4 py-2 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors border border-transparent"
              >
                Cancel
              </button>
              <button
                onClick={handleReject}
                disabled={isLoading || rejectionReason.trim().length < 5}
                className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? "Rejecting..." : "Confirm Rejection"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
