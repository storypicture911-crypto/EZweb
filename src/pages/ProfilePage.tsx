import { useEffect, useMemo, useState } from "react";
import { Copy, Eye, EyeOff, LockKeyhole, LogOut, Pencil, Save } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { EmptyState, PageHeading } from "../components/AppShell";
import { StatusPill } from "../components/StatusPill";
import { avatarCatalog, avatarEmoji } from "../lib/avatar";
import { maskGeneratedName } from "../lib/lottery";
import { invoke, safeMessage, supabase } from "../lib/supabase";
import type { LotteryBatch } from "../types";

export function ProfilePage() {
  const { profile, refreshProfile, signOut } = useAuth(); const [showId, setShowId] = useState(false); const [edit, setEdit] = useState(false); const [nickname, setNickname] = useState(profile?.nickname || ""); const [avatar, setAvatar] = useState(profile?.avatar_key || "lucky-clover-01"); const [batches, setBatches] = useState<LotteryBatch[]>([]); const [message, setMessage] = useState(""); const [pinOpen, setPinOpen] = useState(false);
  const loadBatches = async () => { const { data } = await supabase.from("lottery_batches").select("*, lottery_weeks(*), lottery_entries(*)").order("created_at", { ascending: false }); setBatches((data || []) as LotteryBatch[]); };
  useEffect(() => { void loadBatches(); const channel = supabase.channel("my-batches").on("postgres_changes", { event: "*", schema: "public", table: "lottery_batches", filter: `user_id=eq.${profile?.id}` }, () => void loadBatches()).subscribe(); return () => { void supabase.removeChannel(channel); }; }, [profile?.id]);
  const save = async () => { setMessage(""); const { error } = await supabase.rpc("update_my_profile", { p_nickname: nickname, p_avatar_key: avatar }); if (error) setMessage(safeMessage(error)); else { await refreshProfile(); setEdit(false); setMessage("Profile သိမ်းပြီးပါပြီ ✨"); } };
  const stats = useMemo(() => ({ weeks: new Set(batches.map((b) => b.week_id)).size, numbers: batches.reduce((n,b) => n + (b.lottery_entries?.length || 0), 0), wins: batches.filter((b) => b.status === "approved").length }), [batches]);
  return <>
    <PageHeading eyebrow="MY SPACE" title="My Profile" description="သင့် account, ဂဏန်းများနှင့် မှတ်တမ်းများ။"/>
    <section className="profile-hero card"><div className="profile-avatar">{avatarEmoji(profile?.avatar_key)}</div><div className="profile-main"><span className="role-tag">{profile?.role}</span><h2>{profile?.nickname || "Nickname မသတ်မှတ်ရသေးပါ"}</h2><div className="id-line"><code>{showId ? profile?.generated_name : maskGeneratedName(profile?.generated_name || "")}</code><button onClick={() => setShowId(!showId)}>{showId ? <EyeOff/> : <Eye/>}{showId ? "ဖုံးမည်" : "Show My Full ID"}</button><button aria-label="Copy ID" onClick={() => void navigator.clipboard.writeText(profile?.generated_name || "")}><Copy/></button></div></div><button className="secondary" onClick={() => setEdit(!edit)}><Pencil size={16}/> Edit Profile</button></section>
    {message && <div className={message.includes("ပြီး") ? "success-note" : "form-error"}>{message}</div>}
    {edit && <section className="card edit-panel"><h3>Profile ပြင်မည်</h3><label>Nickname<input value={nickname} maxLength={30} onChange={(e) => setNickname(e.target.value)}/></label><p className="label-text">Avatar ရွေးပါ</p>{avatarCatalog.map((group) => <div className="avatar-group" key={group.category}><small>{group.category}</small><div>{group.items.map(([key,emoji]) => <button className={avatar === key ? "selected" : ""} key={key} onClick={() => setAvatar(key)} title={key}>{emoji}</button>)}</div></div>)}<button className="primary" onClick={() => void save()}><Save size={17}/> သိမ်းမည်</button></section>}
    <div className="stats-grid"><div><span>အပတ်စဉ်ပါဝင်မှု</span><b>{stats.weeks}</b><small>Weeks</small></div><div><span>ရွေးဖူးသောဂဏန်း</span><b>{stats.numbers}</b><small>Numbers</small></div><div><span>Approved Batches</span><b>{stats.wins}</b><small>Records</small></div></div>
    <div className="section-title"><div><p className="eyebrow">LOTTERY HISTORY</p><h2>My Numbers</h2></div></div>
    <section className="batch-list">{!batches.length ? <EmptyState title="ဒီအပတ်အတွက် ဂဏန်းမရှိသေးပါ" body="Admin သို့မဟုတ် Staff က ဂဏန်းထည့်ပြီးတာနဲ့ ဒီမှာ အလိုအလျောက် ပေါ်လာပါမယ်။"/> : batches.map((batch) => <article className="batch-card" key={batch.id}><header><div><small>{batch.lottery_weeks?.title}</small><h3>({batch.sequence_no || "—"}) {profile?.nickname}</h3></div><StatusPill status={batch.status}/></header><div className="number-chips">{batch.lottery_entries?.map((entry) => <span key={entry.id}><b>{entry.number}</b><small>{Number(entry.amount).toLocaleString()} Ks</small></span>)}</div><footer><span>ဒိုင် Confirm <b>{batch.dealer_confirmed_at ? "✅ Confirmed" : "⏳ စောင့်ဆိုင်းဆဲ"}</b></span><span>Total <strong>{Number(batch.total_amount).toLocaleString()} Ks</strong></span></footer></article>)}</section>
    <section className="profile-actions card"><button onClick={() => setPinOpen(!pinOpen)}><LockKeyhole/>Change PIN</button><button onClick={() => void signOut()}><LogOut/>Logout</button></section>
    {pinOpen && <PinPanel onDone={() => setPinOpen(false)}/>}</>;
}

function PinPanel({ onDone }: { onDone: () => void }) {
  const [currentPin, setCurrent] = useState(""); const [newPin, setNew] = useState(""); const [confirm, setConfirm] = useState(""); const [message, setMessage] = useState("");
  const change = async () => { if (newPin !== confirm) return setMessage("PIN အသစ် နှစ်ခု မတူပါ။"); try { await invoke("change-pin", { current_pin: currentPin, new_pin: newPin }); setMessage("PIN ပြောင်းပြီးပါပြီ 🔐"); setTimeout(onDone, 900); } catch (e) { setMessage(safeMessage(e)); } };
  return <div className="modal-backdrop"><div className="modal"><button className="modal-close" onClick={onDone}>×</button><h2>Change PIN</h2><p>လက်ရှိ PIN ကို ပြန်လည်အတည်ပြုပါ။</p><label>Current PIN<input type="password" inputMode="numeric" value={currentPin} onChange={(e)=>setCurrent(e.target.value.replace(/\D/g,"").slice(0,4))}/></label><label>New PIN<input type="password" inputMode="numeric" value={newPin} onChange={(e)=>setNew(e.target.value.replace(/\D/g,"").slice(0,4))}/></label><label>Confirm PIN<input type="password" inputMode="numeric" value={confirm} onChange={(e)=>setConfirm(e.target.value.replace(/\D/g,"").slice(0,4))}/></label>{message && <div className={message.includes("ပြီး") ? "success-note" : "form-error"}>{message}</div>}<button className="primary wide" onClick={() => void change()}>PIN ပြောင်းမည်</button></div></div>;
}
