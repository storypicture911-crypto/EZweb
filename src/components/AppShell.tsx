import { NavLink, Outlet } from "react-router-dom";
import { Bell, BookOpen, CircleUserRound, Hash, LayoutDashboard, LogOut, MessageCircle, Shield, Sparkles, Trophy } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { avatarEmoji } from "../lib/avatar";

const baseLinks = [
  { to: "/community", label: "Community", icon: MessageCircle },
  { to: "/result", label: "ထီတိုက်မည်", icon: Trophy },
  { to: "/profile", label: "My Profile", icon: CircleUserRound },
  { to: "/dream100", label: "အိပ်မက်100", icon: BookOpen },
];

export function AppShell() {
  const { profile, signOut } = useAuth();
  const links = [...baseLinks, ...(profile?.role !== "user" ? [{ to: "/entry", label: "ဂဏန်းထည့်မည်", icon: Hash }] : []), ...(profile?.role === "admin" ? [{ to: "/admin", label: "Admin Panel", icon: Shield }] : [])];
  return <div className="app-frame">
    <aside className="sidebar">
      <div className="logo"><span><Sparkles size={18}/></span>EZWin</div>
      <nav>{links.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to}><Icon size={19}/><span>{label}</span></NavLink>)}</nav>
      <div className="sidebar-foot"><div className="mini-profile"><span className="avatar small">{avatarEmoji(profile?.avatar_key)}</span><div><b>{profile?.nickname || "EZWin Member"}</b><small>{profile?.role}</small></div></div><button aria-label="Logout" onClick={() => void signOut()}><LogOut size={18}/></button></div>
    </aside>
    <div className="main-column">
      <header className="topbar"><div className="mobile-logo"><Sparkles size={18}/> EZWin</div><div className="top-actions"><button className="icon-button" aria-label="Notifications"><Bell size={19}/><i/></button><span className="avatar small">{avatarEmoji(profile?.avatar_key)}</span></div></header>
      <div className="page-wrap"><Outlet /></div>
      <nav className="bottom-nav">{links.slice(0, profile?.role === "user" ? 4 : 5).map(({ to, label, icon: Icon }) => <NavLink key={to} to={to}><Icon/><span>{label === "My Profile" ? "Profile" : label}</span></NavLink>)}</nav>
    </div>
  </div>;
}

export function PageHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

export function EmptyState({ icon = "🍀", title, body }: { icon?: string; title: string; body: string }) {
  return <div className="empty-state"><span>{icon}</span><h3>{title}</h3><p>{body}</p></div>;
}
