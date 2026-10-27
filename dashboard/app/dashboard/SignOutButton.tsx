"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export default function SignOutButton() {
  const router = useRouter();

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <button
      id="sign-out-btn"
      onClick={handleSignOut}
      className="text-sm font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 transition-colors"
    >
      Sign out
    </button>
  );
}
