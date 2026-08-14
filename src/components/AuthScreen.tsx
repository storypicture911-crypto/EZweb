import { useState, type FormEvent } from "react";
import { KeyRound, ShieldCheck, Sparkles } from "lucide-react";
import { invoke, safeMessage, supabase } from "../lib/supabase";

type Mode = "login" | "activate";
interface SessionPayload { session: { access_token: string; refresh_token: string } }

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>("login");
  const [generatedName, setGeneratedName] = useState("");
  const [pin, setPin] = useState("");
  const [code, setCode] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError("");
    if (!/^@py[A-HJ-NP-Z2-9]{6}$/i.test(generatedName.trim())) return setError("Generated ID ပုံစံ မမှန်ပါ။");
    if (!/^\d{4}$/.test(pin)) return setError("PIN ကို ဂဏန်း 4 လုံး ထည့်ပါ။");
    if (mode === "activate" && pin !== confirmPin) return setError("PIN နှစ်ခု မတူပါ။");
    if (mode === "activate" && new Set(["0000","1111","2222","3333","4444","5555","6666","7777","8888","9999","1234","4321"]).has(pin)) return setError("ဒီ PIN က ခန့်မှန်းရလွယ်ပါတယ်။ အခြား PIN တစ်ခု ရွေးပေးပါ။");
    if (mode === "activate" && (nickname.trim().length < 1 || nickname.trim().length > 30)) return setError("Nickname ကို စာလုံး 1 မှ 30 အတွင်း ထည့်ပါ။");
    setBusy(true);
    try {
      const result = await invoke<SessionPayload>(mode === "login" ? "login-ezwin-user" : "activate-ezwin-user", {
        generated_name: generatedName.trim(), pin, ...(mode === "activate" ? { one_time_code: code.trim(), nickname: nickname.trim() } : {}),
      });
      await supabase.auth.setSession(result.session);
    } catch (reason) { setError(safeMessage(reason)); } finally { setBusy(false); }
  };

  return <main className="auth-page">
    <section className="auth-brand">
      <div className="brand-mark"><Sparkles size={25} /> EZWin</div>
      <h1>ကံစမ်းမှုထက်<br/><em>အသိုင်းအဝိုင်း။</em></h1>
      <p>သင့်ဂဏန်းများ၊ ရလဒ်များနှင့် အပတ်စဉ်မှတ်တမ်းအားလုံးကို လုံခြုံစွာ ကြည့်ရှုပါ။</p>
      <div className="security-note"><ShieldCheck size={20}/><span>Anonymous ID · Secure 4-digit PIN<br/>ကိုယ်ရေးအချက်အလက် မလိုအပ်ပါ</span></div>
    </section>
    <section className="auth-card">
      <div className="auth-icon"><KeyRound /></div>
      <p className="eyebrow">WELCOME BACK</p>
      <h2>{mode === "login" ? "အကောင့်ဝင်မည်" : "ပထမဆုံး စတင်မည်"}</h2>
      <p className="muted">Admin ပေးထားသော Generated ID ဖြင့် ဝင်ပါ</p>
      <div className="segmented"><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>PIN ဖြင့်ဝင်မည်</button><button className={mode === "activate" ? "active" : ""} onClick={() => setMode("activate")}>စတင်အသုံးပြုမည်</button></div>
      <form onSubmit={submit}>
        <label>Generated ID<input value={generatedName} onChange={(e) => setGeneratedName(e.target.value)} autoCapitalize="none" autoComplete="username" placeholder="@py7K9M2Q" /></label>
        {mode === "activate" && <label>One-Time Code<input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoComplete="one-time-code" placeholder="K7M9-Q4PX" /></label>}
        {mode === "activate" && <label>Nickname<input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={30} placeholder="ဆရာကြီး" /></label>}
        <label>{mode === "login" ? "4 Digit PIN" : "သင့်အတွက် PIN သတ်မှတ်ပါ"}<input className="pin-input" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0,4))} type="password" inputMode="numeric" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="••••" /></label>
        {mode === "activate" && <label>Confirm PIN<input className="pin-input" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0,4))} type="password" inputMode="numeric" placeholder="••••" /></label>}
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="primary wide" disabled={busy}>{busy ? "စစ်ဆေးနေပါသည်..." : mode === "login" ? "အကောင့်ဝင်မည်" : "စတင်မည်"}</button>
      </form>
      <p className="privacy-line">သင့်အချက်အလက်များကို EZWin က လုံခြုံစွာ ထိန်းသိမ်းထားပါသည်။</p>
    </section>
  </main>;
}
