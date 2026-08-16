import { useEffect, useMemo, useState } from "react";
import { Share2, Sparkles } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { EmptyState, PageHeading } from "../components/AppShell";
import { avatarEmoji } from "../lib/avatar";
import { classifyLotteryNumber, maskGeneratedName, type MatchType } from "../lib/lottery";
import { supabase } from "../lib/supabase";
import type { LotteryBatch, LotteryWeek } from "../types";

const resultCopy: Record<MatchType, { icon: string; title: string; body: string }> = {
  exact: { icon: "🎉", title: "Winner! Exact Match", body: "ဂုဏ်ယူပါတယ် — ဂဏန်းတိတိကျကျ ကိုက်ညီပါတယ်။" },
  twd: { icon: "🔥", title: "တွဒ်ပေါက်သည်", body: "ဂဏန်းသုံးလုံး အစီအစဉ်ကွာပြီး ကိုက်ညီပါတယ်။" },
  "korea-miss": { icon: "🥰", title: "ကိုရီးယားလွဲလေး လွဲသွားပါပြီ", body: "နီးစပ်ပေမယ့် ဒီတစ်ခါ ဆုမရသေးပါ။" },
  none: { icon: "🌿", title: "ဒီတစ်ပတ် မကိုက်သေးပါ", body: "ရလဒ်ကို အေးဆေးစွာ မှတ်တမ်းထဲ သိမ်းထားပါတယ်။" },
};

export function ResultPage() {
  const { profile } = useAuth(); const [weeks, setWeeks] = useState<LotteryWeek[]>([]); const [weekId, setWeekId] = useState(""); const [batch, setBatch] = useState<LotteryBatch | null>(null); const [result, setResult] = useState<string | null>(null); const [revealed, setRevealed] = useState(0); const [checking, setChecking] = useState(false);
  useEffect(() => { void (async () => { const { data } = await supabase.from("lottery_weeks").select("*").order("draw_date", { ascending: false }); const list = (data || []) as LotteryWeek[]; setWeeks(list); setWeekId(list.find((w) => w.is_current)?.id || list[0]?.id || ""); })(); }, []);
  useEffect(() => { if (!weekId) return; void (async () => { const [{ data: batches }, { data: results }] = await Promise.all([supabase.from("lottery_batches").select("*, lottery_entries(*)").eq("week_id",weekId).eq("status","approved").maybeSingle(), supabase.from("lottery_results").select("result_number").eq("week_id",weekId).maybeSingle()]); setBatch(batches as LotteryBatch | null); setResult(results?.result_number || null); setRevealed(0); })(); }, [weekId]);
  const matches = useMemo(() => batch?.lottery_entries?.map((entry) => ({ ...entry, type: result ? classifyLotteryNumber(entry.number, result) : "none" as MatchType })) || [], [batch,result]);
  const best = useMemo<MatchType>(() => matches.some((m)=>m.type==="exact") ? "exact" : matches.some((m)=>m.type==="twd") ? "twd" : matches.some((m)=>m.type==="korea-miss") ? "korea-miss" : "none", [matches]);
  const check = () => { if (!result) return; setChecking(true); setRevealed(0); [1,2,3].forEach((n) => setTimeout(() => { setRevealed(n); if (n === 3) setChecking(false); }, n * 650)); };
  const share = async () => { if (!result) return; const text = `${resultCopy[best].icon} EZWin\n${profile?.nickname || "EZWin Member"}\n${maskGeneratedName(profile?.generated_name || "")}\n${resultCopy[best].title}\nResult: ${result}`; if (navigator.share) await navigator.share({ title: "EZWin Result", text }); else await navigator.clipboard.writeText(text); };
  return <><PageHeading eyebrow="LOTTERY CHECKER" title="ထီတိုက်မည်" description="Approved ဂဏန်းများကို ထွက်ဂဏန်းနဲ့ အလိုအလျောက် စစ်ပေးပါတယ်။"/>
    <section className="checker card"><div className="checker-top"><label>Week<select value={weekId} onChange={(e) => setWeekId(e.target.value)}>{weeks.map((w)=><option value={w.id} key={w.id}>{w.title}</option>)}</select></label><span className="avatar">{avatarEmoji(profile?.avatar_key)}</span></div>
      {!weekId ? <EmptyState icon="📅" title="Lottery week မရှိသေးပါ" body="Admin က week အသစ်ဖွင့်ပြီးတာနဲ့ ဒီမှာပေါ်လာပါမယ်။"/> : !result ? <EmptyState icon="⏳" title="Result မထွက်သေးပါ" body="Result publish ပြီးသည်အထိ စောင့်ကြည့်ပေးပါ။"/> : !batch ? <EmptyState title="Approved ဂဏန်း မရှိသေးပါ" body="ဒီအပတ်အတွက် အတည်ပြုပြီးသော batch မရှိသေးပါ။"/> : <>
        <div className="result-reel"><span>{revealed >= 1 ? result[0] : "?"}</span><span>{revealed >= 2 ? result[1] : "?"}</span><span>{revealed >= 3 ? result[2] : "?"}</span></div>
        {revealed < 3 ? <button className="primary check-button" disabled={checking} onClick={check}><Sparkles/> {checking ? "ဂဏန်းဖွင့်နေပါသည်..." : "Result ကြည့်မည်"}</button> : <div className={`result-card ${best}`}><span>{resultCopy[best].icon}</span><h2>{resultCopy[best].title}</h2><p>{resultCopy[best].body}</p><div className="match-list">{matches.map((match)=><i className={match.type} key={match.id}>{match.number}<small>{match.type}</small></i>)}</div><button className="secondary" onClick={() => void share()}><Share2/> Share Result Card</button></div>}
      </>}</section><p className="responsible-note">🍀 ရလဒ်စစ်ခြင်းသည် မှတ်တမ်းနှင့် ဖျော်ဖြေရေးအတွက်သာ ဖြစ်ပါသည်။</p></>;
}
