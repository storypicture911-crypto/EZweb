import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import { AuthScreen } from "./components/AuthScreen";
import { AppShell } from "./components/AppShell";
import { isConfigured } from "./lib/supabase";
import { CommunityPage } from "./pages/CommunityPage";
import { ProfilePage } from "./pages/ProfilePage";
import { ResultPage } from "./pages/ResultPage";
import { DreamPage } from "./pages/DreamPage";
import { EntryPage } from "./pages/EntryPage";
import { AdminPage } from "./pages/AdminPage";

function SetupRequired() { return <main className="setup-page"><div className="setup-card"><span>⚙️</span><p className="eyebrow">ONE-TIME SETUP</p><h1>Supabase ချိတ်ဆက်ရန် လိုအပ်ပါသည်</h1><p><code>.env</code> ဖိုင်တွင် public Supabase URL နှင့် publishable key ထည့်ပြီး app ကို ပြန်စတင်ပါ။ လျှို့ဝှက် server keys မထည့်ပါနှင့်။</p><pre>VITE_SUPABASE_URL=https://…supabase.co{"\n"}VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…</pre></div></main> }

function Protected({ roles, children }: { roles?: string[]; children: React.ReactNode }) {
  const { profile } = useAuth();
  if (!profile) return <Navigate to="/" replace />;
  return !roles || roles.includes(profile.role) ? children : <Navigate to="/community" replace />;
}

export default function App() {
  const { session, loading } = useAuth();
  if (!isConfigured) return <SetupRequired />;
  if (loading) return <div className="app-loader"><span className="logo-orb">✦</span><b>EZWin</b><i/></div>;
  if (!session) return <AuthScreen />;
  return <Routes><Route element={<AppShell/>}>
    <Route index element={<Navigate to="/community" replace/>}/>
    <Route path="/community" element={<CommunityPage/>}/>
    <Route path="/result" element={<ResultPage/>}/>
    <Route path="/profile" element={<ProfilePage/>}/>
    <Route path="/dream100" element={<DreamPage/>}/>
    <Route path="/entry" element={<Protected roles={["admin","staff"]}><EntryPage/></Protected>}/>
    <Route path="/admin" element={<Protected roles={["admin"]}><AdminPage/></Protected>}/>
    <Route path="*" element={<Navigate to="/community" replace/>}/>
  </Route></Routes>;
}
