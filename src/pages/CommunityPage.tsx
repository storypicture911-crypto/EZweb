import { useEffect, useMemo, useState } from "react";
import { CalendarDays, RefreshCw } from "lucide-react";
import { EmptyState, PageHeading } from "../components/AppShell";
import { avatarEmoji } from "../lib/avatar";
import { luckyNumberToday } from "../lib/lottery";
import { safeMessage, supabase } from "../lib/supabase";
import type { Activity } from "../types";

const reactions = ["👏","🔥","😂","😭","🍀","🎉","❤️"];
const activityText: Record<string, string> = {
  batch_approved: "ဒီအပတ်ဂဏန်း အတည်ပြုပြီးပါပြီ 🍀",
  twd_won: "တွဒ်ဆု ရရှိခဲ့သည် 🔥",
  exact_won: "ကံထူးရှင် ဖြစ်သွားပါပြီ 🎉",
  result_checked: "Result ကြည့်ပြီးပါပြီ",
};

export function CommunityPage() {
  const [items, setItems] = useState<Activity[]>([]); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const load = async () => { setLoading(true); const { data, error: reason } = await supabase.from("community_activity").select("*, community_reactions(reaction)").order("created_at", { ascending: false }).limit(30); if (reason) setError(safeMessage(reason)); else setItems((data || []) as Activity[]); setLoading(false); };
  useEffect(() => { void load(); const channel = supabase.channel("community-live").on("postgres_changes", { event: "*", schema: "public", table: "community_activity" }, () => void load()).subscribe(); return () => { void supabase.removeChannel(channel); }; }, []);
  const react = async (activityId: string, reaction: string) => { const { error: reason } = await supabase.rpc("add_community_reaction", { p_activity_id: activityId, p_reaction: reaction }); if (!reason) void load(); };
  const today = useMemo(() => luckyNumberToday(), []);
  return <>
    <PageHeading eyebrow="EZWIN SOCIAL" title="🔥 Community" description="အသိုင်းအဝိုင်းရဲ့ ကံကောင်းသတင်းတွေကို အတူမျှဝေကြမယ်။" action={<button className="secondary" onClick={() => void load()}><RefreshCw size={17}/> Refresh</button>}/>
    <section className="lucky-banner"><div><span className="sun">☀️</span><div><p className="eyebrow">TODAY'S LUCKY NUMBER</p><h2>{today}</h2><small>ဖျော်ဖြေရေးအတွက်သာ · ခန့်မှန်းချက် မဟုတ်ပါ</small></div></div><CalendarDays/><i/></section>
    {error && <div className="form-error">{error}</div>}
    <section className="feed-list">{loading ? <div className="loading-card">Community ကို ရယူနေပါသည်...</div> : !items.length ? <EmptyState icon="✨" title="Community မှာ တိတ်ဆိတ်နေသေးတယ်" body="Batch အတည်ပြုပြီးတာနဲ့ လုံခြုံသော activity ကို ဒီမှာ တွေ့ရပါမယ်။"/> : items.map((item) => <article className="feed-card" key={item.id}>
      <div className="feed-avatar">{avatarEmoji(item.avatar_key_snapshot)}</div><div className="feed-content"><div className="feed-meta"><div><b>{item.nickname_snapshot || "EZWin Member"}</b><span>{item.masked_id_snapshot}</span></div><time>{new Intl.DateTimeFormat("my-MM", { dateStyle: "medium" }).format(new Date(item.created_at))}</time></div><p>{activityText[item.activity_type] || item.safe_payload.message || "EZWin activity အသစ်တစ်ခုရှိပါသည်။"}</p><div className="reaction-row">{reactions.map((emoji) => { const count = item.community_reactions?.filter((r) => r.reaction === emoji).length || 0; return <button key={emoji} onClick={() => void react(item.id, emoji)}>{emoji}{count > 0 && <span>{count}</span>}</button>; })}</div></div>
    </article>)}</section>
  </>;
}
