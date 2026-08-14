import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types";

interface AuthValue { session: Session | null; profile: Profile | null; loading: boolean; refreshProfile: () => Promise<void>; signOut: () => Promise<void> }
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshProfile = async () => {
    const { data: { session: active } } = await supabase.auth.getSession();
    if (!active) { setProfile(null); return; }
    const { data } = await supabase.from("profiles").select("*").eq("id", active.user.id).single();
    setProfile(data as Profile | null);
  };

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => { setSession(data.session); await refreshProfile(); setLoading(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next); setTimeout(() => void refreshProfile(), 0);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const value = useMemo(() => ({ session, profile, loading, refreshProfile, signOut: async () => { await supabase.auth.signOut(); setProfile(null); } }), [session, profile, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
