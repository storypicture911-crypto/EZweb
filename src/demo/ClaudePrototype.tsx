// @ts-nocheck
import React, { useState, useEffect, useMemo, useCallback, useRef, createContext, useContext } from "react";
import {
  Home, Users, Ticket, History, User, Shield, Search, Plus, X, Check,
  ChevronRight, ChevronLeft, Calendar, Sparkles, Award, LogOut, Eye, EyeOff,
  Menu, ArrowLeft, Clock, TrendingUp, FileText, UserPlus, Save, Send,
  AlertCircle, Trophy, Coins, Filter, RotateCcw, BookOpen, ClipboardCheck,
  Layers, ScrollText
} from "lucide-react";
import {
  cloudEnabled,
  getCloudState,
  getCloudProfile,
  loginCloud,
  registerCloud,
  requestCloudRecovery,
  signOutCloud,
  setCloudState,
  updateCloudProfile,
  verifyCloudRecovery,
} from "./supabaseAuth";

/* =====================================================================
   EZWIN — points-based lottery community prototype
   Every amount in this app is a virtual demo credit. No real payments,
   deposits, withdrawals, or cash-out exist anywhere in this build.
   ===================================================================== */

/* ---------------------------------------------------------------------
   DATA ACCESS LAYER
   Every read/write funnels through `db.*` so the mock layer below can be
   swapped for real Supabase calls later without touching any component.
   Personal data uses window.storage (shared:false) so it survives reloads
   for the person using this browser, without being visible to anyone else.
--------------------------------------------------------------------- */
const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateId() {
  let s = "";
  for (let i = 0; i < 6; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return "@py" + s;
}
function maskId(id) {
  if (!id || id.length < 7) return id;
  return id.slice(0, 4) + "***" + id.slice(-2);
}
function AvatarVisual({ value, className = "" }) {
  return typeof value === "string" && value.startsWith("data:image/")
    ? <img className={className} src={value} alt="Profile" />
    : <span className={className}>{value}</span>;
}
const AVATARS = ["🐯", "🐉", "🦋", "🌸", "🎆", "🪙", "🎏", "🧧", "🌙", "⭐", "🔥", "🍀", "🎯", "🐢", "🦚", "🐘"];

async function storageGet(key, fallback) {
  if (cloudEnabled) {
    try {
      const cloudValue = await getCloudState(key);
      if (cloudValue !== undefined) return cloudValue;
    } catch (error) {
      console.error("cloud state read failed", key, error);
    }
  }
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
async function storageSet(key, value) {
  if (cloudEnabled) {
    try {
      if (await setCloudState(key, value)) return;
    } catch (error) {
      console.error("cloud state write failed", key, error);
    }
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("storage set failed", key, e);
  }
}

/* ---------------------------------------------------------------------
   LOTTERY RULES ENGINE — the single source of truth for all prize math.
   Every screen (entry preview, draw reveal, admin ledger, admin winners)
   reads results from this module instead of computing prizes locally.
   This is a 3-digit-only system — 2-digit entries are rejected at parse time.
--------------------------------------------------------------------- */
const RULES = { EXACT_MULTIPLIER: 550, TWD_MULTIPLIER: 10 };

// EZWin business display rule: distinct R = 6 plays, one repeated pair R = 4 plays.
function reverseStakeUnits(number) {
  const unique = new Set(number.split("")).size;
  return unique === 3 ? 6 : unique === 2 ? 4 : 1;
}

function entryStakeTotal(entry, closedNumbers = []) {
  if (!entry.hasR && closedNumbers.includes(entry.number)) return 0;
  return entry.hasR ? entry.amount * reverseStakeUnits(entry.number) : entry.amount;
}

// Returns every distinct arrangement of a 3-digit string.
// "123" (3 distinct digits) -> 6 arrangements. "122" (a repeated digit) -> 3
// distinct arrangements (122, 212, 221) — that's the mathematical count for
// a 3-digit multiset with one repeated digit.
function permutationsOf(digits) {
  const chars = digits.split("");
  const out = new Set();
  const go = (rest, acc) => {
    if (rest.length === 0) { out.add(acc); return; }
    for (let i = 0; i < rest.length; i++) {
      go(rest.slice(0, i).concat(rest.slice(i + 1)), acc + rest[i]);
    }
  };
  go(chars, "");
  return Array.from(out);
}

// R RULE — "spreading" a number across all its digit arrangements, split
// evenly across however many arrangements exist for that specific number.
//
// CONFIRMED from your examples: "123R" (3 distinct digits) spreads across
// 6 arrangements — matches standard permutation math exactly.
//
// FLAGGED — needs your confirmation: you described "122R" (a repeated
// digit) as spreading across 4 arrangements, but a 3-digit number with one
// repeated digit only has 3 distinct arrangements (122, 212, 221). I don't
// know what the 4th one is supposed to be, so I'm not guessing it — this
// build currently spreads repeated-digit R numbers across the 3 arrangements
// that exist, and marks the difference here so it's easy to find and fix
// once you tell me what the 4th arrangement should be.
function expandR(number) {
  const variants = permutationsOf(number);
  const hasRepeat = new Set(number.split("")).size < 3;
  return { variants, note: hasRepeat ? "twin-digit R: spread across 3 arrangements (you described 4 — unconfirmed, see note above the function)" : null };
}

// Splits an R entry's total amount evenly across its arrangements, excluding
// any arrangement that's on the closed-numbers list (that stake is void and
// does not receive a share).
//
// FLAGGED — needs your confirmation: your example "344R-5000" with 344
// closed noted the result as "2000 Ks", but evenly splitting 5000 across the
// non-closed arrangements doesn't land on 2000 under any arrangement count
// this build can derive (3 or 4 arrangements). Until you confirm the exact
// redistribution formula, this build uses plain even-split-of-the-remainder
// as its default, and visibly labels closed arrangements so admins can see
// which stake was voided.
function splitRAmount(totalAmount, variants, closedNumbers) {
  const openVariants = variants.filter((v) => !closedNumbers.includes(v));
  const share = openVariants.length > 0 ? totalAmount / openVariants.length : 0;
  return variants.map((v) => ({
    number: v,
    closed: closedNumbers.includes(v),
    amount: closedNumbers.includes(v) ? 0 : Math.round(share),
  }));
}

// Counts how many digit values two 3-digit numbers have in common, treating
// each as a multiset (so a repeated digit can count twice).
function sharedDigitCount(a, b) {
  const count = (s) => {
    const c = {};
    for (const d of s) c[d] = (c[d] || 0) + 1;
    return c;
  };
  const ca = count(a), cb = count(b);
  let shared = 0;
  for (const d of Object.keys(ca)) shared += Math.min(ca[d], cb[d] || 0);
  return shared;
}

// TWD — the published number's distinct permutations, plus its immediate
// numeric neighbors. Example: 122 => 121, 123, 212 and 221.
function matchesTWD(entryDigits, winningDigits) {
  if (entryDigits === winningDigits) return false; // exact match pays the Exact tier, not TWD
  const entryCount = [...entryDigits].sort().join("");
  const winningCount = [...winningDigits].sort().join("");
  const isPermutation = entryCount === winningCount;
  const numericNeighbor = Math.abs(Number(entryDigits) - Number(winningDigits)) === 1;
  return isPermutation || numericNeighbor;
}

// "Korea-miss" — no prize, but two digits remain in the same positions.
// Example: 125 against 123.
function isKoreaMiss(entryDigits, winningDigits) {
  if (entryDigits === winningDigits) return false;
  if (matchesTWD(entryDigits, winningDigits)) return false;
  return [...entryDigits].filter((digit, index) => digit === winningDigits[index]).length === 2;
}

// Evaluates a single saved entry (which may internally be an R spread)
// against the published winning number. Returns one result per number
// actually in play, so an R entry can show multiple lines.
function calculateEntryResult(entry, winningNumber, closedNumbers = []) {
  if (!winningNumber || winningNumber.length !== 3) {
    return { number: entry.number, amount: entry.amount, outcome: "pending", multiplier: 0, prize: 0, closed: false };
  }

  const evalOne = (number, amount, closed) => {
    if (closed) return { number, amount, outcome: "closed", multiplier: 0, prize: 0, closed: true };
    if (number === winningNumber) return { number, amount, outcome: "exact", multiplier: RULES.EXACT_MULTIPLIER, prize: amount * RULES.EXACT_MULTIPLIER, closed: false };
    if (matchesTWD(number, winningNumber)) return { number, amount, outcome: "twd", multiplier: RULES.TWD_MULTIPLIER, prize: amount * RULES.TWD_MULTIPLIER, closed: false };
    if (isKoreaMiss(number, winningNumber)) return { number, amount, outcome: "koreamiss", multiplier: 0, prize: 0, closed: false };
    return { number, amount, outcome: "none", multiplier: 0, prize: 0, closed: false };
  };

  if (!entry.hasR) {
    const closed = closedNumbers.includes(entry.number);
    return evalOne(entry.number, entry.amount, closed);
  }
  const { variants } = expandR(entry.number);
  const evaluated = variants.map((number) => evalOne(number, entry.amount, false));
  return evaluated.find((result) => result.outcome === "exact")
    || evaluated.find((result) => result.outcome === "twd")
    || evaluated.find((result) => result.outcome === "koreamiss")
    || evaluated[0];
}

function parseEntryLines(raw, closedNumbers = []) {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d{3})(R)?-(\d{1,7})$/i);
      if (!m) return { raw: line, valid: false };
      const [, number, r, amount] = m;
      const hasR = !!r;
      const entry = { raw: line, valid: true, number, hasR, amount: parseInt(amount, 10) };
      if (hasR) {
        const { variants, note } = expandR(number);
        entry.rVariants = variants;
        entry.rNote = note;
      } else if (closedNumbers.includes(number)) {
        entry.closedWarning = true;
      }
      return entry;
    });
}

/* ---------------------------------------------------------------------
   YANGON TIME
--------------------------------------------------------------------- */
function useYangonClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const yangon = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Yangon" }));
  return yangon;
}
function fmtClock(d) {
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
}
function nextDrawTarget(yangonNow) {
  const t = new Date(yangonNow);
  t.setHours(15, 30, 0, 0);
  if (yangonNow.getTime() > t.getTime()) t.setDate(t.getDate() + 1);
  return t;
}
function fmtCountdown(ms) {
  if (ms <= 0) return "00:00:00";
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}
function todayKey(yangonNow) {
  return yangonNow.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------------
   SEED / MOCK DATA — clearly-marked demo content
--------------------------------------------------------------------- */
const SEED_NAMES = ["Thiri", "Kaung", "Su Su", "Zayar", "Hnin", "Aung Aung", "Moe Moe", "Htet", "Yadanar", "Nay Chi"];
const seedCommunity = SEED_NAMES.map((name, i) => ({
  id: generateId(),
  nickname: name,
  avatar: AVATARS[i % AVATARS.length],
  joined: `2025-0${(i % 9) + 1}-14`,
  entries: [
    { number: String(100 + i * 37).slice(-3), amount: 500 * ((i % 4) + 1), hasR: i % 5 === 0 },
    { number: String(20 + i * 7).padStart(3, "0").slice(-3), amount: 300 * ((i % 3) + 1), hasR: false },
  ],
  wins: i % 3 === 0 ? [{ date: "2025-07-21", label: "Exact win", amount: 550000 }] : [],
}));

const seedPreviousResults = [
  { date: "2025-08-14", number: "704", month: "August", year: 2025, note: "" },
  { date: "2025-08-13", number: "218", month: "August", year: 2025, note: "" },
  { date: "2025-08-12", number: "955", month: "August", year: 2025, note: "" },
  { date: "2025-08-11", number: "063", month: "August", year: 2025, note: "" },
  { date: "2025-08-08", number: "342", month: "August", year: 2025, note: "" },
  { date: "2025-07-31", number: "119", month: "July", year: 2025, note: "" },
  { date: "2025-07-30", number: "588", month: "July", year: 2025, note: "" },
  { date: "2025-07-29", number: "471", month: "July", year: 2025, note: "" },
];

const seedStaffCandidates = seedCommunity.slice(0, 4);
const seedWeeks = [
  { id: "aug-16", title: "August 16 Week", date: "2026-08-16", time: "15:30", status: "current" },
  { id: "aug-09", title: "August 9 Week", date: "2026-08-09", time: "15:30", status: "closed" },
];
const seedDream100 = [
  { number: "001", label: "နဂါး", meaning: "အခွင့်အရေးအသစ်" },
  { number: "007", label: "ကြယ်", meaning: "ကံကောင်းခြင်း" },
  { number: "100", label: "ပန်း", meaning: "ပျော်ရွှင်ခြင်း" },
];

const DEMO_ACCOUNTS = {
  "@admin": { pin: "2468", role: "admin", nickname: "EZWin Admin", avatar: AVATARS[5] },
  "@kol37xi": { pin: "1234", role: "user", nickname: "ဆရာကြီး", avatar: AVATARS[3] },
};

function cloudProfileToApp(row) {
  return {
    id: row.generated_name,
    userId: row.id,
    nickname: row.nickname || "EZWin Member",
    email: row.recovery_email || "",
    avatar: AVATARS[0],
    avatarKey: row.avatar_key || "lucky-clover-01",
    joined: String(row.created_at || new Date().toISOString()).slice(0, 10),
    role: row.role,
    cloud: true,
  };
}

/* ---------------------------------------------------------------------
   APP CONTEXT
--------------------------------------------------------------------- */
const Ctx = createContext(null);
const useApp = () => useContext(Ctx);

/* ---------------------------------------------------------------------
   ROOT APP
--------------------------------------------------------------------- */
export default function EZWinApp() {
  const [booted, setBooted] = useState(false);
  const [profile, setProfile] = useState(null); // null = signed out
  const [entries, setEntries] = useState([]); // this user's own entries
  const [staff, setStaff] = useState([]); // promoted staff (demo, shared:false personal record acting as "system" record)
  const [drawRecord, setDrawRecord] = useState({ draft: null, published: null, date: null });
  const [previousResults, setPreviousResults] = useState(seedPreviousResults);
  const [managedUsers, setManagedUsers] = useState([]);
  const [closedNumbers, setClosedNumbers] = useState(["344"]);
  const [weeks, setWeeks] = useState(seedWeeks);
  const [dream100, setDream100] = useState(seedDream100);
  const [auditLogs, setAuditLogs] = useState([]);
  const [view, setView] = useState("home");
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [toast, setToast] = useState(null);
  const yangonNow = useYangonClock();
  const today = todayKey(yangonNow);

  useEffect(() => {
    (async () => {
      let p = await storageGet("ezwin:profile", null);
      if (cloudEnabled) {
        try {
          const cloudProfile = await getCloudProfile();
          if (cloudProfile) p = cloudProfileToApp(cloudProfile);
          else if (p?.cloud) p = null;
        } catch (error) {
          console.error("Supabase session restore failed", error);
        }
      }
      const e = await storageGet("ezwin:entries", []);
      const s = await storageGet("ezwin:staff", []);
      const d = await storageGet("ezwin:draw", { draft: null, published: null, date: null });
      const pr = await storageGet("ezwin:previousResults", seedPreviousResults);
      const mu = await storageGet("ezwin:managedUsers", []);
      const cn = await storageGet("ezwin:closedNumbers", ["344"]);
      const wk = await storageGet("ezwin:weeks", seedWeeks);
      const dr = await storageGet("ezwin:dream100", seedDream100);
      const al = await storageGet("ezwin:auditLogs", []);
      setProfile(p);
      setEntries(e);
      setStaff(s);
      setDrawRecord(d);
      setPreviousResults(pr);
      setManagedUsers(mu);
      setClosedNumbers(cn);
      setWeeks(wk);
      setDream100(dr);
      setAuditLogs(al);
      setBooted(true);
    })();
  }, []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const saveProfile = useCallback(async (next) => {
    if (next?.cloud && cloudEnabled) {
      await updateCloudProfile(next.nickname, next.avatarKey || "lucky-clover-01");
    }
    setProfile(next);
    await storageSet("ezwin:profile", next);
  }, []);
  const saveEntries = useCallback(async (next) => {
    setEntries(next);
    await storageSet("ezwin:entries", next);
  }, []);
  const saveStaff = useCallback(async (next) => {
    setStaff(next);
    await storageSet("ezwin:staff", next);
  }, []);
  const saveDrawRecord = useCallback(async (next) => {
    setDrawRecord(next);
    await storageSet("ezwin:draw", next);
  }, []);
  const savePreviousResults = useCallback(async (next) => {
    setPreviousResults(next);
    await storageSet("ezwin:previousResults", next);
  }, []);
  const saveManagedUsers = useCallback(async (next) => {
    setManagedUsers(next);
    await storageSet("ezwin:managedUsers", next);
  }, []);
  const saveClosedNumbers = useCallback(async (next) => {
    setClosedNumbers(next);
    await storageSet("ezwin:closedNumbers", next);
  }, []);
  const saveWeeks = useCallback(async (next) => {
    setWeeks(next);
    await storageSet("ezwin:weeks", next);
  }, []);
  const saveDream100 = useCallback(async (next) => {
    setDream100(next);
    await storageSet("ezwin:dream100", next);
  }, []);
  const addAudit = useCallback(async (action, detail = "") => {
    const item = { id: Math.random().toString(36).slice(2), action, detail, actor: profile?.id || "system", createdAt: new Date().toISOString() };
    const next = [item, ...auditLogs].slice(0, 200);
    setAuditLogs(next);
    await storageSet("ezwin:auditLogs", next);
  }, [auditLogs, profile]);

  const logout = useCallback(async () => {
    if (profile?.cloud && cloudEnabled) await signOutCloud();
    setProfile(null);
    await storageSet("ezwin:profile", null);
    setView("home");
    setAdminAuthed(false);
  }, [profile]);

  const ctxValue = {
    profile, saveProfile, entries, saveEntries, staff, saveStaff,
    drawRecord, saveDrawRecord, previousResults, savePreviousResults,
    view, setView, adminAuthed, setAdminAuthed, logout, showToast,
    yangonNow, today, managedUsers, saveManagedUsers, closedNumbers, saveClosedNumbers,
    weeks, saveWeeks, dream100, saveDream100, auditLogs, addAudit,
  };

  if (!booted) {
    return (
      <div className="ez-root ez-boot">
        <style>{CSS}</style>
        <div className="ez-boot-mark">EZ<span>Win</span></div>
      </div>
    );
  }

  const isAdminView = view === "admin" && profile?.role === "admin";

  return (
    <Ctx.Provider value={ctxValue}>
      <div className={isAdminView ? "ez-root ez-root-admin" : "ez-root"}>
        <style>{CSS}</style>
        {!isAdminView && <TopBar />}
        <main className={isAdminView ? "ez-admin-main" : "ez-main"}>
          {view === "home" && <HomeView />}
          {view === "community" && <CommunityView />}
          {view === "draw" && <DrawView />}
          {view === "entry" && <EntryView />}
          {view === "dream100" && <Dream100View />}
          {view === "previous" && <PreviousView />}
          {view === "profile" && <ProfileView />}
          {view === "auth" && <AuthView />}
          {view === "admin" && <AdminView />}
        </main>
        {!isAdminView && <BottomNav />}
        {toast && <div className="ez-toast">{toast}</div>}
      </div>
    </Ctx.Provider>
  );
}

/* ---------------------------------------------------------------------
   SHELL PIECES
--------------------------------------------------------------------- */
function TopBar() {
  const { profile, setView } = useApp();
  return (
    <header className="ez-topbar">
      <div className="ez-brand" onClick={() => setView("home")}>
        <span className="ez-brand-mark">EZ</span>
        <span className="ez-brand-mark2">Win</span>
      </div>
      {profile ? (
        <div className="ez-top-actions">
          {profile.role === "admin" && <button className="ez-admin-open" onClick={() => setView("admin")}><Shield size={14}/> Admin Panel</button>}
          <button className="ez-idchip" onClick={() => setView("profile")}>
            <AvatarVisual className="ez-idchip-avatar" value={profile.avatar} />
            <span className="ez-idchip-id">{maskId(profile.id)}</span>
          </button>
        </div>
      ) : (
        <button className="ez-btn ez-btn-gold ez-btn-sm" onClick={() => setView("auth")}>
          အကောင့်ဝင်မည်
        </button>
      )}
    </header>
  );
}

function BottomNav() {
  const { view, setView, profile } = useApp();
  const items = [
    { key: "home", icon: Home, label: "Home" },
    { key: "community", icon: Users, label: "Community" },
    { key: "draw", icon: Ticket, label: "ထီတိုက်မည်" },
    { key: "dream100", icon: BookOpen, label: "အိပ်မက်1000" },
    { key: "profile", icon: User, label: profile ? "ကျွန်ုပ်" : "Login" },
  ];
  return (
    <nav className="ez-bottomnav">
      {items.map((it) => {
        const Icon = it.icon;
        const active = view === it.key || (it.key === "profile" && view === "auth");
        return (
          <button
            key={it.key}
            className={"ez-navbtn" + (active ? " active" : "")}
            onClick={() => setView(it.key === "profile" && !profile ? "auth" : it.key)}
          >
            <Icon size={20} strokeWidth={active ? 2.4 : 1.8} />
            <span>{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function AdminFooterLink() {
  const { setView } = useApp();
  return (
    <div className="ez-adminlink" onClick={() => setView("admin")} title="Admin">
      <Shield size={11} /> admin
    </div>
  );
}

/* ---------------------------------------------------------------------
   TICKET CARD — shared signature component (torn/perforated edge)
--------------------------------------------------------------------- */
function Ticket_({ children, className = "", accent }) {
  return (
    <div className={"ez-ticket" + (accent ? ` ez-ticket-${accent}` : "") + " " + className}>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------------
   HOME
--------------------------------------------------------------------- */
function HomeView() {
  const { setView, yangonNow, profile, entries, closedNumbers, drawRecord, weeks } = useApp();
  const target = nextDrawTarget(yangonNow);
  const remaining = target.getTime() - yangonNow.getTime();
  const adminNumbers = useMemo(() => new Set(entries.filter((entry) => entry.viaAdmin).flatMap((entry) => entry.hasR ? expandR(entry.number).variants : [entry.number])), [entries]);
  const numberBoard = useMemo(() => Array.from({ length: 1000 }, (_, index) => String(index).padStart(3, "0")), []);
  const publicWinners = useMemo(() => {
    if (!drawRecord.published) return [];
    return entries.filter((entry) => entry.viaAdmin && entry.drawDate === drawRecord.date).map((entry) => ({ entry, result: calculateEntryResult(entry, drawRecord.published, closedNumbers) })).filter(({ result }) => result.outcome === "exact" || result.outcome === "twd");
  }, [entries, drawRecord, closedNumbers]);
  const adminEntries = entries.filter((entry) => entry.viaAdmin);
  const dealerPending = adminEntries.filter((entry) => entry.workflowStatus !== "confirmed").length;
  const dealerConfirmed = adminEntries.filter((entry) => entry.workflowStatus === "confirmed").length;

  return (
    <div className="ez-view">
      <section className="ez-hero">
        <div className="ez-hero-eyebrow"><Sparkles size={13} /> ဒီနေ့ ထီပွဲ</div>
        <div className="ez-hero-clock">{fmtClock(yangonNow)}</div>
        <div className="ez-hero-sub">Myanmar Time · Asia/Yangon</div>
        <div className="ez-hero-countdown">
          <span className="ez-hero-countdown-label">ထီထွက်ရန်</span>
          <span className="ez-hero-countdown-time">{fmtCountdown(remaining)}</span>
        </div>
        <button className="ez-btn ez-btn-gold ez-btn-lg" onClick={() => setView("draw")}>
          ထီတိုက်မည် <ChevronRight size={17} />
        </button>
      </section>

      {profile?.role === "admin" && <Ticket_ accent="gold" className="ez-admin-home-summary">
        <div className="ez-admin-summary-head"><div><Shield size={16}/> <strong>Admin Overview</strong></div><button className="ez-btn ez-btn-gold ez-btn-sm" onClick={() => setView("admin")}>Open Admin Panel</button></div>
        <div className="ez-admin-summary-grid">
          <span><small>Current Week</small><b>{weeks.find((week) => week.status === "current")?.title || "—"}</b></span>
          <span><small>Total Entries</small><b>{adminEntries.length}</b></span>
          <span><small>Total Amount</small><b>{adminEntries.reduce((sum, entry) => sum + entryStakeTotal(entry, closedNumbers), 0).toLocaleString()} Ks</b></span>
          <span><small>Dealer Pending</small><b>{dealerPending}</b></span>
          <span><small>Confirmed</small><b>{dealerConfirmed}</b></span>
          <span><small>Latest Result</small><b>{drawRecord.published || "—"}</b></span>
          <span><small>Winners</small><b>{publicWinners.length}</b></span>
        </div>
      </Ticket_>}

      <div className="ez-row-head">
        <h2>000–999 ဂဏန်းအခြေအနေ</h2>
        <span className="ez-board-count">Admin records only</span>
      </div>
      <Ticket_ accent="gold" className="ez-number-board-card">
        <div className="ez-number-legend"><span><i className="empty"/>မထိုးရသေး</span><span><i className="taken"/>ထိုးထား</span><span><i className="closed"/>ပိတ်ဂဏန်း</span></div>
        <div className="ez-number-board" aria-label="000 to 999 number status">
          {numberBoard.map((number) => <span key={number} className={`ez-number-cell ${closedNumbers.includes(number) ? "closed" : adminNumbers.has(number) ? "taken" : "empty"}`}>{number}</span>)}
        </div>
      </Ticket_>

      {publicWinners.length > 0 && <>
        <div className="ez-row-head"><h2>ဒီပွဲကံထူးရှင်များ</h2><span className="ez-board-count">Nickname only</span></div>
        <div className="ez-public-winners">
          {publicWinners.map(({ entry, result }, index) => <Ticket_ accent={result.outcome === "exact" ? "gold" : undefined} className={`ez-public-winner ${result.outcome}`} key={`${entry.id}-${index}`}>
            <AvatarVisual className="ez-public-winner-avatar" value={entry.ownerAvatar || "🍀"}/>
            <div><small>{result.outcome === "exact" ? "EXACT WINNER · 550×" : "TWD WINNER · 10×"}</small><strong>{entry.ownerName || "EZWin Member"}</strong><span>ဆုငွေ {result.prize.toLocaleString()} ကျပ်</span></div>
          </Ticket_>)}
        </div>
      </>}

      <div className="ez-row-head">
        <h2>Quick actions</h2>
      </div>
      <div className="ez-quickgrid">
        <button className="ez-quick" onClick={() => setView("entry")}>
          <Plus size={19} />
          <span>ဂဏန်းထည့်မည်</span>
        </button>
        <button className="ez-quick" onClick={() => setView("community")}>
          <Users size={19} />
          <span>Community</span>
        </button>
        <button className="ez-quick" onClick={() => setView(profile ? "profile" : "auth")}>
          <History size={19} />
          <span>My history</span>
        </button>
      </div>

      {!profile && (
        <Ticket_ className="ez-cta-signup">
          <div>
            <strong>အကောင့်ရှိမှ ဂဏန်းထိုးနိုင်၊ ရလဒ်စစ်နိုင်ပါမယ်</strong>
            <p>Browsing is always free — no account needed until you save a number.</p>
          </div>
          <button className="ez-btn ez-btn-cream ez-btn-sm" onClick={() => setView("auth")}>Create account</button>
        </Ticket_>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   DREAM 100
--------------------------------------------------------------------- */
function Dream100View() {
  const { dream100 } = useApp();
  const [q, setQ] = useState("");
  const filtered = dream100.filter((item) => `${item.number} ${item.label} ${item.meaning}`.toLowerCase().includes(q.toLowerCase()));
  return <div className="ez-view">
    <h1 className="ez-h1">အိပ်မက် 1000</h1>
    <p className="ez-sub">အိပ်မက်အလိုက် ကံစမ်းဂဏန်းများ</p>
    <div className="ez-searchbox"><Search size={14}/><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ဂဏန်း သို့မဟုတ် အိပ်မက် ရှာရန်"/></div>
    <div className="ez-dream-grid">{filtered.map((item) => <Ticket_ key={item.number} className="ez-dream-card"><strong>{item.number}</strong><div><b>{item.label}</b><span>{item.meaning}</span></div></Ticket_>)}</div>
  </div>;
}

/* ---------------------------------------------------------------------
   COMMUNITY
--------------------------------------------------------------------- */
function CommunityView() {
  const { profile } = useApp();
  const [openProfile, setOpenProfile] = useState(null);
  const allMembers = useMemo(() => {
    const mine = profile
      ? [{ id: profile.id, nickname: profile.nickname, avatar: profile.avatar, joined: profile.joined, entries: [], wins: [], self: true }]
      : [];
    return [...mine, ...seedCommunity];
  }, [profile]);

  return (
    <div className="ez-view">
      <h1 className="ez-h1">Community</h1>
      <p className="ez-sub">လူသားရေချာလှတဲ့ ထီအသိုင်းအဝိုင်း — demo credits only</p>
      <div className="ez-communitygrid">
        {allMembers.map((m) => (
          <button key={m.id} className="ez-membercard" onClick={() => setOpenProfile(m)}>
            <div className="ez-membercard-avatar">{m.avatar}</div>
            <div className="ez-membercard-name">{m.nickname}{m.self && <span className="ez-you-badge">you</span>}</div>
            <div className="ez-membercard-meta">{m.entries.length} active {m.entries.length === 1 ? "entry" : "entries"}</div>
          </button>
        ))}
      </div>
      {openProfile && <MemberModal member={openProfile} onClose={() => setOpenProfile(null)} />}
    </div>
  );
}

function MemberModal({ member, onClose }) {
  return (
    <div className="ez-modal-backdrop" onClick={onClose}>
      <div className="ez-modal" onClick={(e) => e.stopPropagation()}>
        <button className="ez-modal-close" onClick={onClose}><X size={18} /></button>
        <div className="ez-modal-avatar">{member.avatar}</div>
        <div className="ez-modal-name">{member.nickname}</div>
        <div className="ez-modal-joined">Joined {member.joined}</div>

        {member.entries.length > 0 && (
          <>
            <div className="ez-modal-section">ထိုးထားသောဂဏန်း (public)</div>
            <div className="ez-modal-numbers">
              {member.entries.map((e, i) => (
                <span key={i} className="ez-numpill">{e.number}{e.hasR ? "R" : ""}</span>
              ))}
            </div>
          </>
        )}

        <div className="ez-modal-section">Win badges</div>
        {member.wins.length === 0 ? (
          <p className="ez-modal-empty">No wins recorded yet — every draw is a fresh shot.</p>
        ) : (
          member.wins.map((w, i) => (
            <div key={i} className="ez-winbadge">
              <Trophy size={14} /> {w.label} · {w.date} · <strong>{w.amount.toLocaleString()} Ks</strong>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------
   ENTRY — ဂဏန်းထည့်ခြင်း
--------------------------------------------------------------------- */
function EntryView() {
  const { profile, entries, saveEntries, setView, showToast, today } = useApp();
  const [raw, setRaw] = useState("");
  const parsed = useMemo(() => parseEntryLines(raw), [raw]);
  const validLines = parsed.filter((p) => p.valid);
  const invalidLines = parsed.filter((p) => !p.valid);
  const entryTotal = validLines.reduce((sum, line) => sum + entryStakeTotal(line), 0);

  if (!profile) {
    return (
      <div className="ez-view">
        <EmptyGate
          title="ဂဏန်းထိုးရန် အကောင့်လိုအပ်ပါသည်"
          body="Create a free account to save numbers to your own history."
          cta="Create account"
          onClick={() => setView("auth")}
        />
      </div>
    );
  }

  const submit = async () => {
    if (validLines.length === 0) return;
    const next = [
      ...entries,
      ...validLines.map((l) => ({
        id: Math.random().toString(36).slice(2, 10),
        number: l.number,
        hasR: l.hasR,
        amount: l.amount,
        raw: l.raw,
        source: "self",
        ownerId: profile.id,
        ownerName: profile.nickname,
        ownerAvatar: profile.avatar,
        drawDate: today,
        createdAt: new Date().toISOString(),
      })),
    ];
    await saveEntries(next);
    setRaw("");
    showToast(`${validLines.length} number(s) saved to today's draw`);
  };

  const todaysEntries = entries.filter((e) => e.drawDate === today && e.ownerId === profile.id);

  return (
    <div className="ez-view">
      <h1 className="ez-h1">ဂဏန်းထည့်မည်</h1>
      <p className="ez-sub">တစ်ကြောင်းလျှင် ဂဏန်း-ကျပ်ပမာဏ တစ်ခုစီ ရေးပါ။ Example: <code>344-5000</code></p>

      <textarea
        className="ez-textarea"
        placeholder={"344-5000\n122R-1000\n455-2000"}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={5}
      />

      {parsed.length > 0 && (
        <div className="ez-preview">
          <div className="ez-preview-head">Preview</div>
          {validLines.map((l, i) => (
            <div key={i} className="ez-preview-row ok">
              <Check size={14} />
              <span className="ez-preview-num">{l.number}{l.hasR && <em className="ez-r-badge">R</em>}</span>
              <span className="ez-preview-amt">{l.amount.toLocaleString()} Ks{l.hasR ? ` × ${reverseStakeUnits(l.number)}` : ""}</span>
            </div>
          ))}
          {invalidLines.map((l, i) => (
            <div key={i} className="ez-preview-row bad">
              <AlertCircle size={14} />
              <span>"{l.raw}" — format not recognized (expected 344-5000 or 122R-1000)</span>
            </div>
          ))}
          {validLines.length > 0 && <div className="ez-preview-total">Total · {entryTotal.toLocaleString()} Ks</div>}
        </div>
      )}

      <button className="ez-btn ez-btn-gold ez-btn-lg ez-btn-block" disabled={validLines.length === 0} onClick={submit}>
        <Save size={16} /> သိမ်းမည်
      </button>

      <div className="ez-row-head" style={{ marginTop: 28 }}>
        <h2>ယနေ့ ထိုးထားသောဂဏန်း</h2>
      </div>
      {todaysEntries.length === 0 ? (
        <p className="ez-empty-note">No numbers saved for today's draw yet.</p>
      ) : (
        <div className="ez-entrylist">
          {todaysEntries.map((e) => (
            <Ticket_ key={e.id} className="ez-entry-row">
              <span className="ez-entry-num">{e.number}{e.hasR && <em className="ez-r-badge">R</em>}</span>
              <span className="ez-entry-amt">{e.amount.toLocaleString()} Ks</span>
              <span className="ez-entry-src">{e.source === "self" ? "self" : e.source}</span>
            </Ticket_>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyGate({ title, body, cta, onClick }) {
  return (
    <Ticket_ className="ez-gate">
      <Ticket size={26} />
      <h3>{title}</h3>
      <p>{body}</p>
      <button className="ez-btn ez-btn-gold" onClick={onClick}>{cta}</button>
    </Ticket_>
  );
}

/* ---------------------------------------------------------------------
   DRAW — the signature screen
--------------------------------------------------------------------- */
function DrawView() {
  const { yangonNow, drawRecord, entries, profile, today, showToast, closedNumbers } = useApp();
  const target = nextDrawTarget(yangonNow);
  const remaining = target.getTime() - yangonNow.getTime();
  const officiallyPublished = drawRecord.published && drawRecord.date === today ? drawRecord.published : null;

  const [demoNumber, setDemoNumber] = useState(null); // demo-only local preview, never persisted as official
  const [phase, setPhase] = useState("idle"); // idle -> rolling -> revealing -> done
  const [tiles, setTiles] = useState(["〰", "〰", "〰"]);
  const rollRef = useRef(null);

  const activeNumber = officiallyPublished || demoNumber;

  useEffect(() => {
    if (!activeNumber && phase === "idle") {
      rollRef.current = setInterval(() => {
        setTiles([
          String(Math.floor(Math.random() * 10)),
          String(Math.floor(Math.random() * 10)),
          String(Math.floor(Math.random() * 10)),
        ]);
      }, 140);
      return () => clearInterval(rollRef.current);
    }
  }, [activeNumber, phase]);

  useEffect(() => {
    if (activeNumber && phase === "idle") {
      setPhase("revealing");
      clearInterval(rollRef.current);
      const digits = activeNumber.split("");
      digits.forEach((d, i) => {
        setTimeout(() => {
          setTiles((prev) => {
            const next = [...prev];
            next[i] = d;
            return next;
          });
          if (i === digits.length - 1) setTimeout(() => setPhase("done"), 500);
        }, 500 + i * 550);
      });
    }
  }, [activeNumber]); // eslint-disable-line

  const myResults = useMemo(() => {
    if (!activeNumber) return [];
    return entries
      .filter((e) => e.drawDate === today && (profile?.role === "admin" ? e.viaAdmin : e.ownerId === profile?.id))
      .map((e) => ({ entry: e, result: calculateEntryResult(e, activeNumber, closedNumbers) }));
  }, [entries, activeNumber, today, closedNumbers, profile]);

  const myWins = myResults.filter((r) => r.result.outcome === "exact" || r.result.outcome === "twd");
  const koreaMisses = myResults.filter((r) => r.result.outcome === "koreamiss");
  const iWon = phase === "done" && myWins.length > 0;

  const runDemoPreview = () => {
    const n = String(Math.floor(Math.random() * 900) + 100);
    setDemoNumber(n);
    showToast("Demo preview only — not an official result");
  };
  const resetDemo = () => {
    setDemoNumber(null);
    setPhase("idle");
    setTiles(["〰", "〰", "〰"]);
  };

  return (
    <div className="ez-view ez-drawview">
      <div className="ez-draw-clock">{fmtClock(yangonNow)} <span>Myanmar Time</span></div>

      {!activeNumber && (
        <div className="ez-draw-countdown">
          <Clock size={14} /> ထီထွက်ရန် <strong>{fmtCountdown(remaining)}</strong>
        </div>
      )}
      {officiallyPublished && (
        <div className="ez-draw-status published"><Sparkles size={13} /> Official result published</div>
      )}
      {!officiallyPublished && demoNumber && (
        <div className="ez-draw-status demo"><AlertCircle size={13} /> Demo preview — not saved as official</div>
      )}

      <div className={"ez-lanterns " + (phase === "done" ? "settled" : "")}>
        {tiles.map((t, i) => (
          <div key={i} className={"ez-lantern" + (phase === "done" ? " lit" : "")} style={{ animationDelay: `${i * 0.22}s` }}>
            <div className="ez-lantern-cap" />
            <div className="ez-lantern-digit">{t}</div>
          </div>
        ))}
      </div>

      {phase === "done" && myResults.length > 0 && (
        <div className="ez-drawresults">
          <div className="ez-match-summary">
            <div className="ez-match-summary-title">တိုက်စစ်ရလဒ်</div>
            {myResults.map(({ entry, result }, index) => (
              <div key={index} className={`ez-match-row ${result.outcome}`}>
                <strong>{entry.number}{entry.hasR ? "R" : ""}</strong>
                <span><b className="ez-result-owner">{entry.ownerName || profile?.nickname || "EZWin Member"}</b>{result.outcome === "exact" ? "တိတိကျကျ ပေါက်သည်" : result.outcome === "twd" ? "တွဒ် ပေါက်သည်" : result.outcome === "koreamiss" ? "ကိုရီးယားလွဲလေး လွဲသွားပါပြီ 🥰" : result.outcome === "closed" ? "ပိတ်ဂဏန်း" : "မနီးစပ်ပါ"}</span>
                {(result.outcome === "exact" || result.outcome === "twd") && <b>{result.prize.toLocaleString()} Ks</b>}
              </div>
            ))}
          </div>
          {myWins.length === 0 && koreaMisses.length === 0 && (
            <Ticket_ className="ez-resultcard none">
              <div className="ez-resultcard-title">ဒီတစ်ခါတော့ မပေါက်သေးပါ 🌱</div>
              <div className="ez-resultcard-sub">နောက်တစ်ကြိမ် ကံကောင်းပါစေ။</div>
            </Ticket_>
          )}
          {koreaMisses.length > 0 && (
            <Ticket_ className="ez-resultcard none">
              <div className="ez-resultcard-title">ကိုရီးယားလွဲလေး လွဲသွားပါပြီ 🥰</div>
              <div className="ez-resultcard-sub">နီးစပ်ပေမယ့် ဒီတစ်ခါ ဆုမရသေးပါ။</div>
            </Ticket_>
          )}
          {myWins.map(({ entry, result }, i) => (
            <Ticket_ key={i} accent="gold" className={"ez-resultcard win " + (iWon ? "celebrate" : "")}>
              <div className="ez-result-profile"><AvatarVisual className="ez-history-avatar" value={entry.ownerAvatar || profile?.avatar || "🍀"}/><strong>{entry.ownerName || profile?.nickname || "EZWin Member"}</strong></div>
              <div className="ez-resultcard-title">
                {result.outcome === "exact" ? "Congratulations 🎉" : "TWD WIN 🎉"}
              </div>
              <div className="ez-resultcard-grid">
                <div><span>Winning Number</span><strong>{activeNumber}</strong></div>
                <div><span>Your Number</span><strong>{entry.number}</strong></div>
                <div><span>Amount</span><strong>{entry.amount.toLocaleString()} Ks</strong></div>
                <div><span>Multiplier</span><strong>{result.multiplier}×</strong></div>
              </div>
              <div className="ez-resultcard-prize">ဆုငွေ {result.prize.toLocaleString()} ကျပ် ပေါက်ပါသည်။</div>
              {iWon && <Confetti />}
            </Ticket_>
          ))}
        </div>
      )}

      {phase === "done" && myResults.length === 0 && (
        <p className="ez-empty-note" style={{ textAlign: "center" }}>
          {profile ? "You had no numbers saved for today's draw." : "Sign in and save a number to see your result here."}
        </p>
      )}

      <div className="ez-demo-controls">
        {!activeNumber ? (
          <button className="ez-btn ez-btn-ghost ez-btn-sm" onClick={runDemoPreview}>
            ▶ Demo: preview reveal now
          </button>
        ) : (
          !officiallyPublished && (
            <button className="ez-btn ez-btn-ghost ez-btn-sm" onClick={resetDemo}>
              <RotateCcw size={13} /> Reset preview
            </button>
          )
        )}
      </div>
    </div>
  );
}

function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.4,
        dur: 1.6 + Math.random() * 1.1,
        color: ["#E7B54B", "#E1495B", "#F4ECD8", "#5CA98F"][i % 4],
        rot: Math.random() * 360,
      })),
    []
  );
  return (
    <div className="ez-confetti">
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            left: `${p.left}%`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            background: p.color,
            transform: `rotate(${p.rot}deg)`,
          }}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------
   PREVIOUS RESULTS
--------------------------------------------------------------------- */
function PreviousView() {
  const { previousResults } = useApp();
  const [month, setMonth] = useState("all");
  const [year, setYear] = useState("all");
  const [q, setQ] = useState("");

  const months = useMemo(() => ["all", ...new Set(previousResults.map((r) => r.month))], [previousResults]);
  const years = useMemo(() => ["all", ...new Set(previousResults.map((r) => r.year))], [previousResults]);

  const filtered = previousResults.filter((r) => {
    if (month !== "all" && r.month !== month) return false;
    if (year !== "all" && String(r.year) !== String(year)) return false;
    if (q && !r.number.includes(q.trim())) return false;
    return true;
  });

  return (
    <div className="ez-view">
      <h1 className="ez-h1">ယခင်ထွက်ဂဏန်းများ</h1>
      <div className="ez-filterbar">
        <select className="ez-select" value={month} onChange={(e) => setMonth(e.target.value)}>
          {months.map((m) => <option key={m} value={m}>{m === "all" ? "All months" : m}</option>)}
        </select>
        <select className="ez-select" value={year} onChange={(e) => setYear(e.target.value)}>
          {years.map((y) => <option key={y} value={y}>{y === "all" ? "All years" : y}</option>)}
        </select>
        <div className="ez-searchbox">
          <Search size={13} />
          <input placeholder="Search number" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {filtered.length === 0 ? (
        <p className="ez-empty-note">No results match those filters.</p>
      ) : (
        <div className="ez-resultslist">
          {filtered.map((r, i) => (
            <Ticket_ key={i} className="ez-resultrow">
              <span className="ez-resultrow-num">{r.number}</span>
              <span className="ez-resultrow-date"><Calendar size={12} /> {r.date}</span>
              {r.note && <span className="ez-resultrow-note">{r.note}</span>}
            </Ticket_>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   AUTH
--------------------------------------------------------------------- */
function AuthView() {
  const { saveProfile, setView, showToast } = useApp();
  const [mode, setMode] = useState("login"); // login | register | forgot
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loginId, setLoginId] = useState("");
  const [loginPin, setLoginPin] = useState("");
  const [showPin, setShowPin] = useState(false);
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [fpStep, setFpStep] = useState(1);
  const [fpId, setFpId] = useState("");
  const [fpCode, setFpCode] = useState("");
  const [fpRequestId, setFpRequestId] = useState("");
  const [fpMaskedEmail, setFpMaskedEmail] = useState("");
  const [fpNewPin, setFpNewPin] = useState("");
  const [error, setError] = useState("");

  const register = async () => {
    setError("");
    if (!nickname.trim()) return setError("Nickname လိုအပ်ပါသည်");
    if (!email.trim()) return setError("Recovery email လိုအပ်ပါသည်");
    if (!/^\d{4}$/.test(pin)) return setError("PIN ကို ဂဏန်း ၄ လုံးတိတိ ထည့်ပါ");
    if (pin !== confirm) return setError("Password မတူညီပါ");
    try {
      const profile = cloudEnabled
        ? cloudProfileToApp(await registerCloud({ nickname: nickname.trim(), recoveryEmail: email.trim(), pin }))
        : { id: generateId(), nickname: nickname.trim(), email: email.trim(), avatar, joined: new Date().toISOString().slice(0, 10), role: "user" };
      if (!profile) throw new Error("Profile မရရှိပါ");
      profile.avatar = avatar;
      await saveProfile(profile);
      showToast(`Welcome, ${profile.nickname}! Your ID is ${profile.id}`);
      setView("profile");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "အကောင့်ဖန်တီးမှု မအောင်မြင်ပါ");
    }
  };

  const login = async () => {
    setError("");
    if (!loginId.trim() || !loginPin.trim()) return setError("ID နှင့် Password ထည့်ပါ");
    const normalized = loginId.trim().toLowerCase();
    const demoAccount = DEMO_ACCOUNTS[normalized];
    if (demoAccount && demoAccount.pin !== loginPin) return setError("ID သို့မဟုတ် PIN မမှန်ပါ");
    try {
      const profile = demoAccount
        ? { id: normalized, nickname: demoAccount.nickname, email: "", avatar: demoAccount.avatar, joined: "2025-01-01", role: demoAccount.role }
        : cloudEnabled
          ? cloudProfileToApp(await loginCloud(loginId.trim(), loginPin))
          : null;
      if (!profile) throw new Error("Supabase မချိတ်ထားသေးပါ");
      await saveProfile(profile);
      showToast("Signed in");
      setView("profile");
    } catch {
      setError("ID သို့မဟုတ် PIN မမှန်ပါ");
    }
  };

  const sendRecovery = async () => {
    setError("");
    try {
      const result = await requestCloudRecovery(fpId);
      if (!result.request_id) throw new Error("Recovery email မရှိပါ");
      setFpRequestId(result.request_id);
      setFpMaskedEmail(result.masked_email || "recovery email");
      setFpStep(2);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Recovery request မအောင်မြင်ပါ");
    }
  };

  const finishRecovery = async () => {
    setError("");
    if (!/^\d{4}$/.test(fpNewPin)) return setError("PIN ကို ဂဏန်း ၄ လုံးတိတိ ထည့်ပါ");
    try {
      await verifyCloudRecovery(fpRequestId, fpCode, fpNewPin);
      setMode("login");
      showToast("Password updated — please sign in");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Code မမှန်ပါ သို့မဟုတ် သက်တမ်းကုန်သွားပါပြီ");
    }
  };

  return (
    <div className="ez-view ez-authview">
      <div className="ez-auth-tabs">
        <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Login</button>
        <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Create account</button>
      </div>

      {mode === "register" && (
        <Ticket_ className="ez-authcard">
          <div className="ez-avatarpicker">
            {AVATARS.map((a) => (
              <button key={a} className={"ez-avatarpicker-item" + (avatar === a ? " sel" : "")} onClick={() => setAvatar(a)}>{a}</button>
            ))}
          </div>
          <label className="ez-field">
            <span>Nickname / နာမည်</span>
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="e.g. Thiri" />
          </label>
          <label className="ez-field">
            <span>Recovery Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <label className="ez-field">
            <span>Password / PIN</span>
            <div className="ez-pwrow">
              <input type={showPin ? "text" : "password"} value={pin} onChange={(e) => setPin(e.target.value)} />
              <button type="button" onClick={() => setShowPin((s) => !s)}>{showPin ? <EyeOff size={15} /> : <Eye size={15} />}</button>
            </div>
          </label>
          <label className="ez-field">
            <span>Confirm Password</span>
            <input type={showPin ? "text" : "password"} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          {error && <div className="ez-error">{error}</div>}
          <button className="ez-btn ez-btn-gold ez-btn-block" onClick={register}>Create account</button>
          <p className="ez-authnote">We'll generate a permanent ID like <strong>@py7K9M2Q</strong> — your nickname can change anytime, your ID never will.</p>
        </Ticket_>
      )}

      {mode === "login" && (
        <Ticket_ className="ez-authcard">
          <label className="ez-field">
            <span>Generated ID</span>
            <input value={loginId} onChange={(e) => setLoginId(e.target.value)} placeholder="@py7K9M2Q" />
          </label>
          <label className="ez-field">
            <span>Password / PIN</span>
            <div className="ez-pwrow">
              <input type={showPin ? "text" : "password"} value={loginPin} onChange={(e) => setLoginPin(e.target.value)} />
              <button type="button" onClick={() => setShowPin((s) => !s)}>{showPin ? <EyeOff size={15} /> : <Eye size={15} />}</button>
            </div>
          </label>
          {error && <div className="ez-error">{error}</div>}
          <button className="ez-btn ez-btn-gold ez-btn-block" onClick={login}>Login</button>
          <p className="ez-authnote">Demo: <strong>@kol37xi / 1234</strong> · Admin: <strong>@admin / 2468</strong></p>
          <button className="ez-link" onClick={() => { setMode("forgot"); setFpStep(1); }}>Forgot password?</button>
        </Ticket_>
      )}

      {mode === "forgot" && (
        <Ticket_ className="ez-authcard">
          <div className="ez-fp-steps">
            {[1, 2, 3].map((s) => <div key={s} className={"ez-fp-dot" + (fpStep >= s ? " active" : "")} />)}
          </div>
          {fpStep === 1 && (
            <>
              <label className="ez-field"><span>Generated ID</span><input value={fpId} onChange={(e) => setFpId(e.target.value)} placeholder="@py7K9M2Q" /></label>
              <button className="ez-btn ez-btn-gold ez-btn-block" onClick={sendRecovery}>Send verification code</button>
            </>
          )}
          {fpStep === 2 && (
            <>
              <p className="ez-authnote">Verification code sent to {fpMaskedEmail}.</p>
              <label className="ez-field"><span>Verification code</span><input value={fpCode} onChange={(e) => setFpCode(e.target.value)} placeholder="123456" /></label>
              <button className="ez-btn ez-btn-gold ez-btn-block" onClick={() => setFpStep(3)}>Verify</button>
            </>
          )}
          {fpStep === 3 && (
            <>
              <label className="ez-field"><span>New PIN</span><input type="password" inputMode="numeric" maxLength={4} value={fpNewPin} onChange={(e) => setFpNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))} /></label>
              <button className="ez-btn ez-btn-gold ez-btn-block" onClick={finishRecovery}>
                Set new password
              </button>
            </>
          )}
          {error && <div className="ez-error">{error}</div>}
          <button className="ez-link" onClick={() => setMode("login")}>Back to login</button>
        </Ticket_>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------
   PROFILE
--------------------------------------------------------------------- */
function ProfileView() {
  const { profile, saveProfile, entries, logout, setView, showToast, previousResults } = useApp();
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState(profile?.nickname || "");
  const [email, setEmail] = useState(profile?.email || "");
  const [avatar, setAvatar] = useState(profile?.avatar || AVATARS[0]);

  const history = useMemo(() => {
    if (!profile) return [];
    return entries.filter((e) => e.ownerId === profile.id).map((e) => {
      const result = previousResults.find((r) => r.date === e.drawDate);
      const outcome = result ? calculateEntryResult(e, result.number) : { outcome: "pending" };
      return { ...e, outcome };
    });
  }, [entries, previousResults, profile]);

  if (!profile) {
    return (
      <div className="ez-view">
        <EmptyGate title="အကောင့်မရှိသေးပါ" body="Log in or create a free account to see your profile." cta="Go to login" onClick={() => setView("auth")} />
      </div>
    );
  }

  const save = async () => {
    await saveProfile({ ...profile, nickname, email, avatar });
    setEditing(false);
    showToast("Profile updated");
  };

  return (
    <div className="ez-view">
      <div className="ez-profilehead">
        <AvatarVisual className="ez-profile-avatar" value={editing ? avatar : profile.avatar} />
        <div className="ez-profile-name">{editing ? (
          <input className="ez-inline-input" value={nickname} onChange={(e) => setNickname(e.target.value)} />
        ) : profile.nickname}</div>
        <div className="ez-profile-id">{profile.id}</div>
        <div className="ez-profile-joined">Joined {profile.joined}</div>
      </div>

      {profile.role === "admin" && <button className="ez-btn ez-btn-gold ez-btn-block ez-profile-admin" onClick={() => setView("admin")}><Shield size={15}/> Open Admin Panel</button>}

      {editing ? (
        <Ticket_ className="ez-authcard">
          <div className="ez-avatarpicker">
            {AVATARS.map((a) => (
              <button key={a} className={"ez-avatarpicker-item" + (avatar === a ? " sel" : "")} onClick={() => setAvatar(a)}>{a}</button>
            ))}
          </div>
          <label className="ez-btn ez-btn-ghost ez-btn-sm ez-photo-upload">Profile photo ရွေးမည်<input type="file" accept="image/*" onChange={(e) => { const file = e.target.files?.[0]; if (!file || file.size > 2_000_000) return; const reader = new FileReader(); reader.onload = () => setAvatar(String(reader.result)); reader.readAsDataURL(file); }}/></label>
          <label className="ez-field"><span>Recovery Email</span><input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="ez-field"><span>New Password</span><input type="password" placeholder="Leave blank to keep current" /></label>
          <div className="ez-editrow">
            <button className="ez-btn ez-btn-ghost ez-btn-sm" onClick={() => setEditing(false)}>Cancel</button>
            <button className="ez-btn ez-btn-gold ez-btn-sm" onClick={save}>Save changes</button>
          </div>
        </Ticket_>
      ) : (
        <button className="ez-btn ez-btn-ghost ez-btn-block" onClick={() => setEditing(true)}>Edit profile</button>
      )}

      <div className="ez-row-head" style={{ marginTop: 26 }}><h2>ထိုးထားသောဂဏန်းများ</h2></div>
      {history.length === 0 ? (
        <p className="ez-empty-note">You haven't saved any numbers yet.</p>
      ) : (
        <div className="ez-entrylist">
          {history.slice().reverse().map((e) => (
            <Ticket_ key={e.id} className="ez-entry-row">
              <span className="ez-entry-num">{e.number}{e.hasR && <em className="ez-r-badge">R</em>}</span>
              <span className="ez-entry-amt">{e.amount.toLocaleString()} Ks</span>
              <OutcomePill outcome={e.outcome.outcome} />
            </Ticket_>
          ))}
        </div>
      )}

      <button className="ez-btn ez-btn-ghost ez-btn-block" style={{ marginTop: 24 }} onClick={logout}>
        <LogOut size={15} /> Sign out
      </button>
    </div>
  );
}

function OutcomePill({ outcome }) {
  const map = {
    pending: { label: "pending", cls: "pending" },
    none: { label: "no win", cls: "none" },
    exact: { label: "exact win", cls: "win" },
    twd: { label: "TWD win", cls: "win" },
    koreamiss: { label: "ကိုရီးယားလွဲ 🥰", cls: "none" },
  };
  const m = map[outcome] || map.pending;
  return <span className={"ez-outcome " + m.cls}>{m.label}</span>;
}

/* =======================================================================
   ADMIN
======================================================================= */
function AdminView() {
  const { profile, setView } = useApp();
  const [tab, setTab] = useState("overview");

  if (profile?.role !== "admin") return <div className="ez-view"><EmptyGate title="Admin access only" body="This area requires an authenticated Admin role." cta="Back to Home" onClick={() => setView("home")}/></div>;

  const tabs = [
    { key: "overview", label: "Overview", icon: TrendingUp },
    { key: "users", label: "Users", icon: Users },
    { key: "history", label: "Entries / Lottery History", icon: History },
    { key: "results", label: "Draws & Results", icon: Send },
    { key: "dealer", label: "Dealer Confirmations", icon: ClipboardCheck },
    { key: "weeks", label: "Weeks", icon: Calendar },
    { key: "dream", label: "Dream1000", icon: BookOpen },
    { key: "staff", label: "Staff Management", icon: Shield },
    { key: "audit", label: "Audit History", icon: ScrollText },
    { key: "enter", label: "ဂဏန်းထည့်မည်", icon: Plus },
  ];

  return (
    <div className="ez-admin">
      <aside className="ez-admin-side">
        <div className="ez-admin-brand" onClick={() => setView("home")}><ArrowLeft size={14} /> EZWin Admin</div>
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.key} className={"ez-admin-navitem" + (tab === t.key ? " active" : "")} onClick={() => setTab(t.key)}>
              <Icon size={15} /> {t.label}
            </button>
          );
        })}
        <button className="ez-admin-navitem ez-admin-logout" onClick={() => setView("home")}>
          <LogOut size={15} /> Exit admin
        </button>
      </aside>
      <div className="ez-admin-content">
        {tab === "overview" && <AdminDashboard setTab={setTab} />}
        {tab === "users" && <AdminUsers />}
        {tab === "history" && <AdminHistory />}
        {tab === "results" && <AdminResults />}
        {tab === "dealer" && <AdminDealerConfirmations />}
        {tab === "weeks" && <AdminWeeks />}
        {tab === "dream" && <AdminDream100 />}
        {tab === "staff" && <AdminStaff />}
        {tab === "audit" && <AdminAudit />}
        {tab === "enter" && <AdminEnterNumbers />}
      </div>
    </div>
  );
}

function AdminLogin() {
  const { setAdminAuthed, setView } = useApp();
  const [email, setEmail] = useState("@admin");
  const [pw, setPw] = useState("2468");
  const [error, setError] = useState("");
  const login = () => {
    if (email.trim().toLowerCase() !== "@admin" || pw !== "2468") return setError("Admin ID သို့မဟုတ် PIN မမှန်ပါ");
    setError(""); setAdminAuthed(true);
  };
  return (
    <div className="ez-adminlogin">
      <div className="ez-adminlogin-card">
        <div className="ez-adminlogin-mark"><Shield size={20} /> Admin</div>
        <p>Demo admin: @admin · PIN 2468</p>
        <label className="ez-field"><span>Admin ID</span><input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="ez-field"><span>PIN</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {error && <div className="ez-error">{error}</div>}
        <button className="ez-btn ez-btn-gold ez-btn-block" onClick={login}>Enter admin</button>
        <button className="ez-link" onClick={() => setView("home")}>Back to site</button>
      </div>
    </div>
  );
}

function allEntriesForAdmin(entries, profile) {
  const mineTagged = entries.map((e) => ({
    ...e,
    ownerId: e.ownerId || profile?.id,
    ownerName: e.ownerName || profile?.nickname,
    ownerAvatar: e.ownerAvatar || profile?.avatar,
  }));
  return mineTagged;
}

function AdminDashboard({ setTab }) {
  const { entries, profile, previousResults, drawRecord, managedUsers } = useApp();
  const all = allEntriesForAdmin(entries, profile);
  const totalAmount = all.reduce((s, e) => s + e.amount, 0);
  return (
    <div className="ez-admin-view">
      <h1 className="ez-admin-h1">Overview</h1>
      <div className="ez-statgrid">
        <StatCard label="Total members" value={managedUsers.length + (profile ? 1 : 0)} icon={Users} />
        <StatCard label="Entries today" value={all.length} icon={Ticket} />
        <StatCard label="Total staked (Ks)" value={totalAmount.toLocaleString()} icon={Coins} />
        <StatCard label="Published results on file" value={previousResults.length} icon={FileText} />
      </div>
      <Ticket_ className="ez-admin-panel">
        <div className="ez-admin-panel-title">Current draw status</div>
        {drawRecord.published ? (
          <p>Published for {drawRecord.date}: <strong>{drawRecord.published}</strong></p>
        ) : drawRecord.draft ? (
          <p>Draft saved for {drawRecord.date}: <strong>{drawRecord.draft}</strong> — not visible to users yet.</p>
        ) : (
          <p>No draft saved yet. Go to Draws & Results to enter today's winning number.</p>
        )}
      </Ticket_>
      <div className="ez-admin-shortcuts"><button className="ez-btn ez-btn-gold" onClick={() => setTab("results")}><Send size={15}/> Draws & Results</button><button className="ez-btn ez-btn-ghost" onClick={() => setTab("history")}><History size={15}/> Member History</button><button className="ez-btn ez-btn-ghost" onClick={() => setTab("enter")}><Plus size={15}/> ဂဏန်းထည့်မည်</button></div>
    </div>
  );
}
function StatCard({ label, value, icon: Icon }) {
  return (
    <div className="ez-statcard">
      <Icon size={16} />
      <div className="ez-statcard-value">{value}</div>
      <div className="ez-statcard-label">{label}</div>
    </div>
  );
}

function AdminUsers() {
  const { entries, profile, managedUsers, saveManagedUsers, showToast } = useApp();
  const [q, setQ] = useState("");
  const [openUser, setOpenUser] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newNickname, setNewNickname] = useState("");
  const [createdCredentials, setCreatedCredentials] = useState(null);
  const users = [
    ...(profile ? [{ id: profile.id, nickname: profile.nickname, avatar: profile.avatar, joined: profile.joined, role: "User", status: "Active" }] : []),
    ...managedUsers,
  ];
  const filtered = users.filter((u) => u.nickname.toLowerCase().includes(q.toLowerCase()) || u.id.toLowerCase().includes(q.toLowerCase()));
  const all = allEntriesForAdmin(entries, profile);
  const createUser = async () => {
    if (!newNickname.trim()) return;
    const user = { id: generateId(), nickname: newNickname.trim(), avatar: AVATARS[managedUsers.length % AVATARS.length], joined: new Date().toISOString().slice(0, 10), role: "User", status: "Active", pin: String(Math.floor(1000 + Math.random() * 9000)) };
    await saveManagedUsers([...managedUsers, user]);
    setCreatedCredentials(user);
    showToast("Member account created");
  };

  return (
    <div className="ez-admin-view">
      <div className="ez-admin-titlebar"><h1 className="ez-admin-h1">Users</h1><button className="ez-btn ez-btn-gold ez-btn-sm" onClick={() => setCreateOpen(true)}><UserPlus size={14}/> Create user</button></div>
      <div className="ez-searchbox ez-admin-search">
        <Search size={14} />
        <input placeholder="Search by nickname or ID" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <table className="ez-table">
        <thead><tr><th>#</th><th></th><th>Nickname</th><th>Generated ID</th><th>Role</th><th>Status</th><th>Joined</th><th></th></tr></thead>
        <tbody>
          {filtered.map((u, index) => (
            <tr key={u.id}>
              <td className="mono">{index + 1}</td>
              <td className="ez-table-avatar">{u.avatar}</td>
              <td>{u.nickname}</td>
              <td className="mono">{u.id}</td>
              <td>{u.role}</td>
              <td><span className="ez-status-active">{u.status}</span></td>
              <td>{u.joined}</td>
              <td><button className="ez-link" onClick={() => setOpenUser(u)}>View</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {createOpen && (
        <div className="ez-modal-backdrop" onClick={() => { setCreateOpen(false); setCreatedCredentials(null); }}>
          <div className="ez-modal ez-modal-sm" onClick={(e) => e.stopPropagation()}>
            <button className="ez-modal-close" onClick={() => { setCreateOpen(false); setCreatedCredentials(null); }}><X size={18}/></button>
            <div className="ez-modal-name">Create member</div>
            {createdCredentials ? <>
              <div className="ez-credential"><span>Generated ID</span><strong>{createdCredentials.id}</strong><span>Demo PIN</span><strong>{createdCredentials.pin}</strong></div>
              <button className="ez-btn ez-btn-gold ez-btn-block" onClick={() => navigator.clipboard.writeText(`${createdCredentials.id}\nPIN: ${createdCredentials.pin}`)}>Copy credentials</button>
            </> : <>
              <label className="ez-field"><span>Nickname</span><input value={newNickname} onChange={(e) => setNewNickname(e.target.value)} placeholder="ဆရာကြီး"/></label>
              <button className="ez-btn ez-btn-gold ez-btn-block" onClick={createUser}><UserPlus size={14}/> Create account</button>
            </>}
          </div>
        </div>
      )}
      {openUser && (
        <div className="ez-modal-backdrop" onClick={() => setOpenUser(null)}>
          <div className="ez-modal" onClick={(e) => e.stopPropagation()}>
            <button className="ez-modal-close" onClick={() => setOpenUser(null)}><X size={18} /></button>
            <div className="ez-modal-avatar">{openUser.avatar}</div>
            <div className="ez-modal-name">{openUser.nickname}</div>
            <div className="ez-modal-id mono">{openUser.id}</div>
            <div className="ez-modal-section">Current & previous numbers</div>
            <div className="ez-modal-numbers">
              {all.filter((e) => e.ownerId === openUser.id).map((e, i) => (
                <span key={i} className="ez-numpill">{e.number}{e.hasR ? "R" : ""} · {e.amount.toLocaleString()}</span>
              ))}
              {all.filter((e) => e.ownerId === openUser.id).length === 0 && <span className="ez-modal-empty">No entries on file.</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AdminStaff() {
  const { staff, saveStaff, showToast, managedUsers } = useApp();
  const [confirmTarget, setConfirmTarget] = useState(null);
  const isStaff = (id) => staff.some((s) => s.id === id);

  const promote = async (candidate) => {
    await saveStaff([...staff, { id: candidate.id, nickname: candidate.nickname, role: "Staff" }]);
    setConfirmTarget(null);
    showToast(`${candidate.nickname} is now Staff`);
  };
  const revoke = async (id) => {
    await saveStaff(staff.filter((s) => s.id !== id));
  };

  return (
    <div className="ez-admin-view">
      <h1 className="ez-admin-h1">Staff</h1>
      <p className="ez-admin-lead">Staff can enter numbers for users and manage draws. Staff cannot create admins, promote themselves, or access secrets.</p>

      <div className="ez-row-head"><h2>Current staff</h2></div>
      {staff.length === 0 ? <p className="ez-empty-note">No staff promoted yet.</p> : (
        <div className="ez-stafflist">
          {staff.map((s) => (
            <Ticket_ key={s.id} className="ez-entry-row">
              <span>{s.nickname}</span>
              <span className="mono">{s.id}</span>
              <button className="ez-link" onClick={() => revoke(s.id)}>Remove</button>
            </Ticket_>
          ))}
        </div>
      )}

      <div className="ez-row-head" style={{ marginTop: 22 }}><h2>Invite as staff</h2></div>
      <div className="ez-stafflist">
        {managedUsers.filter((c) => !isStaff(c.id)).map((c) => (
          <Ticket_ key={c.id} className="ez-entry-row">
            <span>{c.avatar} {c.nickname}</span>
            <span className="mono">{c.id}</span>
            <button className="ez-btn ez-btn-gold ez-btn-sm" onClick={() => setConfirmTarget(c)}>Invite as Staff</button>
          </Ticket_>
        ))}
      </div>

      {confirmTarget && (
        <div className="ez-modal-backdrop" onClick={() => setConfirmTarget(null)}>
          <div className="ez-modal ez-modal-sm" onClick={(e) => e.stopPropagation()}>
            <p>Promote <strong>{confirmTarget.nickname}</strong> ({confirmTarget.id}) to Staff?</p>
            <div className="ez-editrow">
              <button className="ez-btn ez-btn-ghost ez-btn-sm" onClick={() => setConfirmTarget(null)}>Cancel</button>
              <button className="ez-btn ez-btn-gold ez-btn-sm" onClick={() => promote(confirmTarget)}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AdminEnterNumbers() {
  const { entries, saveEntries, profile, today, showToast, managedUsers, saveManagedUsers, closedNumbers, saveClosedNumbers } = useApp();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(null);
  const [raw, setRaw] = useState("");
  const [enteredBy, setEnteredBy] = useState("staff");
  const [closedRaw, setClosedRaw] = useState(closedNumbers.join(", "));
  const [sequence, setSequence] = useState("1");
  const [nameMode, setNameMode] = useState("profile");
  const [newName, setNewName] = useState("");
  const [newId, setNewId] = useState("");
  const users = [
    ...(profile ? [{ id: profile.id, nickname: profile.nickname, avatar: profile.avatar }] : []),
    ...managedUsers.map((m) => ({ id: m.id, nickname: m.nickname, avatar: m.avatar })),
  ];
  const filtered = q ? users.filter((u) => u.nickname.toLowerCase().includes(q.toLowerCase()) || u.id.toLowerCase().includes(q.toLowerCase())) : [];
  const parsedClosedNumbers = closedRaw.split(/[\s,]+/).filter((n) => /^\d{3}$/.test(n));
  const parsed = useMemo(() => parseEntryLines(raw, parsedClosedNumbers), [raw, closedRaw]);
  const validLines = parsed.filter((p) => p.valid);
  const total = validLines.reduce((sum, line) => sum + entryStakeTotal(line, parsedClosedNumbers), 0);
  const historyGroups = useMemo(() => {
    const groups = {};
    entries.filter((entry) => entry.viaAdmin).forEach((entry) => {
      const key = entry.batchId || `${entry.ownerId}-${entry.sequenceNo || 1}-${entry.drawDate}`;
      if (!groups[key]) groups[key] = { id: key, ownerId: entry.ownerId, ownerName: entry.ownerName, ownerAvatar: entry.ownerAvatar, sequenceNo: entry.sequenceNo || 1, status: entry.workflowStatus || "saved", createdAt: entry.createdAt, lines: [] };
      groups[key].lines.push(entry);
    });
    return Object.values(groups).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }, [entries]);

  useEffect(() => {
    if (!selected && users.length > 0) setSelected(users[0]);
  }, [profile, managedUsers]); // eslint-disable-line react-hooks/exhaustive-deps

  const dealerText = () => {
    if (!selected || validLines.length === 0) return "";
    const lines = validLines.map((line) => `${line.number}${line.hasR ? "R" : ""}-${line.amount.toLocaleString()}${!line.hasR && parsedClosedNumbers.includes(line.number) ? " (ပိတ် X)" : line.hasR ? ` (${reverseStakeUnits(line.number)} လုံး)` : ""}`).join("\n");
    return `(${sequence}) ${selected.id} (${selected.nickname})\n\n${lines}\n\nTotal - ${total.toLocaleString()} Ks`;
  };

  const persist = async (workflowStatus, copyForDealer = false) => {
    if (!selected || validLines.length === 0) return;
    const copyText = dealerText();
    const batchId = Math.random().toString(36).slice(2, 11);
    const next = [...entries, ...validLines.map((l) => ({
      id: Math.random().toString(36).slice(2, 10), number: l.number, hasR: l.hasR, amount: l.amount,
      raw: l.raw, source: enteredBy, drawDate: today, createdAt: new Date().toISOString(),
      ownerId: selected.id, ownerName: selected.nickname, ownerAvatar: selected.avatar,
      viaAdmin: true, batchId, sequenceNo: Number(sequence), workflowStatus,
    }))];
    await saveEntries(next);
    await saveClosedNumbers(parsedClosedNumbers);
    if (copyForDealer) {
      try {
        await navigator.clipboard.writeText(copyText);
        showToast("ဒိုင်ဆီပို့ရန် History မှာသိမ်းပြီး Copy လုပ်ပြီးပါပြီ");
      } catch {
        showToast("ဒိုင်ဆီပို့ရန် History မှာ သိမ်းပြီးပါပြီ");
      }
    } else showToast(`${validLines.length} line History မှာ သိမ်းပြီးပါပြီ`);
    setRaw("");
  };
  const createQuickUser = async () => {
    if (!newName.trim() && !newId.trim()) return;
    const id = newId.trim() || generateId();
    const user = { id, nickname: newName.trim() || `Member ${managedUsers.length + 1}`, avatar: AVATARS[managedUsers.length % AVATARS.length], joined: today, role: "User", status: "Active", pin: String(Math.floor(1000 + Math.random() * 9000)) };
    await saveManagedUsers([...managedUsers, user]);
    setSelected(user); setQ(""); setNewName(""); setNewId(""); setNameMode("profile");
    setSequence(String(Math.min(100, users.length + 1)));
    showToast(`User created: ${user.nickname}`);
  };
  const deleteLine = async (id) => {
    await saveEntries(entries.filter((entry) => entry.id !== id));
    showToast("History line ဖျက်ပြီးပါပြီ");
  };
  const copyAll = async () => {
    if (!selected || validLines.length === 0) return;
    await navigator.clipboard.writeText(dealerText());
    showToast("Copy All လုပ်ပြီးပါပြီ");
  };
  const copyHistoryGroup = async (group) => {
    const lines = group.lines.map((line) => `${line.number}${line.hasR ? "R" : ""}-${Number(line.amount).toLocaleString()}${!line.hasR && closedNumbers.includes(line.number) ? " (ပိတ် X)" : ""}`).join("\n");
    const groupTotal = group.lines.reduce((sum, line) => sum + entryStakeTotal(line, closedNumbers), 0);
    await navigator.clipboard.writeText(`(${group.sequenceNo}) ${group.ownerId} (${group.ownerName})\n\n${lines}\n\nTotal - ${groupTotal.toLocaleString()} Ks`);
    showToast("History batch Copy လုပ်ပြီးပါပြီ");
  };

  return (
    <div className="ez-admin-view">
      <h1 className="ez-admin-h1">ဂဏန်းထည့်မည် — on behalf of a user</h1>
      <Ticket_ className="ez-admin-control-card">
        <div className="ez-admin-control-grid"><label className="ez-field"><span>အမှတ်စဉ် (1–100)</span><input type="number" min="1" max="100" value={sequence} onChange={(e) => setSequence(String(Math.max(1, Math.min(100, Number(e.target.value) || 1))))}/></label><label className="ez-field"><span>ပိတ်ဂဏန်းများ</span><input value={closedRaw} onChange={(e) => setClosedRaw(e.target.value.replace(/[^\d,\s]/g, ""))} placeholder="344, 455"/></label></div>
        <button className="ez-btn ez-btn-ghost ez-btn-sm" onClick={() => { saveClosedNumbers(parsedClosedNumbers); showToast("ပိတ်ဂဏန်း သိမ်းပြီးပါပြီ"); }}>ပိတ်ဂဏန်း သိမ်းမည်</button>
      </Ticket_>
      <Ticket_ className="ez-name-picker">
        <div className="ez-admin-panel-title">အမည်ရွေးမည်</div>
        <div className="ez-name-mode" role="group" aria-label="Name source">
          <button className={nameMode === "profile" ? "active" : ""} onClick={() => setNameMode("profile")}>ရှိပြီး Profile</button>
          <button className={nameMode === "new" ? "active" : ""} onClick={() => setNameMode("new")}>New Name</button>
        </div>
        {nameMode === "profile" ? <>
          <label className="ez-field"><span>Profile / အမည်</span><select className="ez-select" value={selected?.id || ""} onChange={(e) => setSelected(users.find((item) => item.id === e.target.value) || null)}><option value="" disabled>Profile ရွေးပါ</option>{users.map((user) => <option key={user.id} value={user.id}>{user.nickname} · {user.id}</option>)}</select></label>
          <div className="ez-searchbox ez-admin-search"><Search size={14}/><input placeholder="Profile name သို့ ID ရှာရန်" value={q} onChange={(e) => setQ(e.target.value)}/></div>
          {q && <div className="ez-userpicklist">{filtered.map((user) => <button key={user.id} className={"ez-userpick" + (selected?.id === user.id ? " sel" : "")} onClick={() => { setSelected(user); setQ(""); }}>{user.avatar} {user.nickname}<span className="mono">{user.id}</span></button>)}</div>}
        </> : <>
          <div className="ez-admin-control-grid"><label className="ez-field"><span>New Name</span><input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="ဥပမာ — ဆရာကြီး"/></label><label className="ez-field"><span>ID (optional)</span><input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="မထည့်လျှင် Auto ID"/></label></div>
          <button className="ez-btn ez-btn-gold ez-btn-sm" onClick={createQuickUser}><UserPlus size={14}/> New Name သိမ်းပြီးရွေးမည်</button>
        </>}
      </Ticket_>
      {selected && (
        <Ticket_ className="ez-authcard" style={{ marginTop: 16 }}>
          <div className="ez-selected-profile"><AvatarVisual value={selected.avatar || "🍀"} className="ez-history-avatar"/><div><span>ဂဏန်းထည့်မည့် Profile</span><strong>{selected.nickname}</strong><code>{selected.id}</code></div></div>
          <textarea className="ez-textarea" rows={4} placeholder={"344-5000\n122R-1000"} value={raw} onChange={(e) => setRaw(e.target.value)} />
          {validLines.length > 0 && <div className="ez-admin-copy-preview">
            <strong>({sequence}) {selected.id} ({selected.nickname})</strong>
            {validLines.map((line, index) => <div key={index}>{line.number}{line.hasR ? "R" : ""}-{line.amount.toLocaleString()} {!line.hasR && parsedClosedNumbers.includes(line.number) && <em>(ပိတ် X)</em>} {line.hasR && <span>{reverseStakeUnits(line.number)} လုံး</span>}</div>)}
            <b>Total - {total.toLocaleString()} Ks</b>
          </div>}
          <label className="ez-field">
            <span>Entered by</span>
            <select className="ez-select" value={enteredBy} onChange={(e) => setEnteredBy(e.target.value)}>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <div className="ez-admin-entry-actions"><button className="ez-btn ez-btn-cream ez-btn-sm" disabled={validLines.length === 0} onClick={() => persist("saved")}><Save size={14}/> သိမ်းမည်</button><button className="ez-btn ez-btn-ghost ez-btn-sm" disabled={validLines.length === 0} onClick={copyAll}>Copy</button><button className="ez-btn ez-btn-gold ez-btn-sm" disabled={validLines.length === 0} onClick={() => persist("sent", true)}><Send size={14}/> ဒိုင်ဆီပို့မည်</button></div>
        </Ticket_>
      )}
      <div className="ez-row-head"><h2>ထိုးထားသောဂဏန်းများ</h2><span className="ez-board-count">Admin only</span></div>
      {historyGroups.length === 0 ? <p className="ez-empty-note">Admin entry history မရှိသေးပါ။</p> : <div className="ez-admin-history">{historyGroups.map((group) => {
        const groupTotal = group.lines.reduce((sum, line) => sum + entryStakeTotal(line, closedNumbers), 0);
        return <Ticket_ key={group.id} className="ez-history-batch"><div className="ez-history-head"><AvatarVisual className="ez-history-avatar" value={group.ownerAvatar || "🍀"}/><div><strong>({group.sequenceNo}) {group.ownerName}</strong><code>{group.ownerId}</code></div><span className={`ez-history-status ${group.status}`}>{group.status === "sent" ? "ဒိုင်ဆီပို့ပြီး" : group.status === "confirmed" ? "အတည်ပြုပြီး" : "သိမ်းပြီး"}</span></div><div className="ez-history-lines">{group.lines.map((line) => <div key={line.id}><span>{line.number}{line.hasR ? "R" : ""}-{Number(line.amount).toLocaleString()}</span><button title="Delete line" onClick={() => deleteLine(line.id)}><X size={13}/></button></div>)}</div><div className="ez-history-total"><span>Total</span><strong>{groupTotal.toLocaleString()} Ks</strong></div><button className="ez-btn ez-btn-ghost ez-btn-sm ez-btn-block" onClick={() => copyHistoryGroup(group)}>Copy this batch</button></Ticket_>;
      })}</div>}
    </div>
  );
}

function AdminHistory() {
  const { entries, profile, managedUsers, previousResults, drawRecord, closedNumbers } = useApp();
  const all = allEntriesForAdmin(entries, profile);
  const members = [...new Map([
    ...(profile ? [[profile.id, profile]] : []),
    ...managedUsers.map((user) => [user.id, user]),
  ]).values()];
  const [memberId, setMemberId] = useState("all");
  const filtered = memberId === "all" ? all : all.filter((entry) => entry.ownerId === memberId);
  const groups = Object.values(filtered.reduce((out, entry) => {
    const key = entry.batchId || `${entry.ownerId}-${entry.drawDate}-${entry.id}`;
    if (!out[key]) out[key] = { id: key, member: entry.ownerName, memberId: entry.ownerId, week: entry.weekTitle || entry.drawDate, status: entry.workflowStatus || "saved", createdAt: entry.createdAt || entry.drawDate, lines: [] };
    out[key].lines.push(entry);
    return out;
  }, {})).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return <div className="ez-admin-view">
    <h1 className="ez-admin-h1">Entries / Lottery History</h1>
    <label className="ez-field ez-admin-member-filter"><span>Select member</span><select className="ez-select" value={memberId} onChange={(e) => setMemberId(e.target.value)}><option value="all">All members</option>{members.map((member) => <option key={member.id} value={member.id}>{member.nickname} · {member.id}</option>)}</select></label>
    {groups.length === 0 ? <p className="ez-empty-note">No lottery history found.</p> : <div className="ez-history-detail-list">{groups.map((group) => {
      const total = group.lines.reduce((sum, line) => sum + entryStakeTotal(line, closedNumbers), 0);
      const resultRecord = group.lines[0].drawDate === drawRecord.date && drawRecord.published ? { number: drawRecord.published } : previousResults.find((item) => item.date === group.lines[0].drawDate);
      const outcomes = resultRecord ? group.lines.map((line) => calculateEntryResult(line, resultRecord.number, closedNumbers)) : [];
      const prize = outcomes.reduce((sum, result) => sum + (result.prize || 0), 0);
      const resultLabel = !resultRecord ? "Pending" : prize > 0 ? "Winner" : outcomes.some((result) => result.outcome === "koreamiss") ? "ကိုရီးယားလွဲ 🥰" : "No prize";
      return <Ticket_ key={group.id} className="ez-history-detail"><div className="ez-history-detail-head"><div><strong>{group.member || "Member"}</strong><code>{group.memberId}</code></div><span className={`ez-history-status ${group.status}`}>{group.status}</span></div><dl><div><dt>Week</dt><dd>{group.week}</dd></div><div><dt>Entered numbers</dt><dd>{group.lines.map((line) => `${line.number}${line.hasR ? "R" : ""}`).join(", ")}</dd></div><div><dt>Amount per number</dt><dd>{group.lines.map((line) => Number(line.amount).toLocaleString()).join(", ")} Ks</dd></div><div><dt>Total</dt><dd>{total.toLocaleString()} Ks</dd></div><div><dt>Dealer confirmation</dt><dd>{group.status}</dd></div><div><dt>Result</dt><dd>{resultLabel}</dd></div><div><dt>Prize / payout</dt><dd>{prize.toLocaleString()} Ks</dd></div><div><dt>Created</dt><dd>{group.createdAt ? new Date(group.createdAt).toLocaleString() : "—"}</dd></div></dl></Ticket_>;
    })}</div>}
  </div>;
}

function AdminDealerConfirmations() {
  const { entries, saveEntries, showToast, addAudit, closedNumbers } = useApp();
  const groups = Object.values(entries.filter((entry) => entry.viaAdmin).reduce((out, entry) => {
    const key = entry.batchId || entry.id;
    if (!out[key]) out[key] = { id: key, member: entry.ownerName, memberId: entry.ownerId, sequenceNo: entry.sequenceNo, status: entry.workflowStatus || "saved", lines: [] };
    out[key].lines.push(entry);
    return out;
  }, {}));
  const confirm = async (group) => {
    const confirmedAt = new Date().toISOString();
    await saveEntries(entries.map((entry) => (entry.batchId || entry.id) === group.id ? { ...entry, workflowStatus: "confirmed", dealerConfirmedAt: confirmedAt } : entry));
    await addAudit("Dealer confirmation", `${group.member} · batch ${group.id}`);
    showToast("Dealer confirmation မှတ်တမ်းတင်ပြီးပါပြီ");
  };
  return <div className="ez-admin-view"><h1 className="ez-admin-h1">Dealer Confirmations</h1><p className="ez-admin-lead">Saved and sent entry batches are confirmed here.</p>{groups.length === 0 ? <p className="ez-empty-note">No dealer batches yet.</p> : <div className="ez-admin-history">{groups.map((group) => <Ticket_ key={group.id} className="ez-history-batch"><div className="ez-history-head"><div><strong>({group.sequenceNo || 1}) {group.member}</strong><code>{group.memberId}</code></div><span className={`ez-history-status ${group.status}`}>{group.status}</span></div><div className="ez-history-lines">{group.lines.map((line) => <div key={line.id}><span>{line.number}{line.hasR ? "R" : ""}-{Number(line.amount).toLocaleString()}</span></div>)}</div><div className="ez-history-total"><span>Total</span><strong>{group.lines.reduce((sum, line) => sum + entryStakeTotal(line, closedNumbers), 0).toLocaleString()} Ks</strong></div>{group.status !== "confirmed" && <button className="ez-btn ez-btn-gold ez-btn-block ez-btn-sm" onClick={() => confirm(group)}><Check size={14}/> Confirm Dealer</button>}</Ticket_>)}</div>}</div>;
}

function AdminWeeks() {
  const { weeks, saveWeeks, showToast, addAudit } = useApp();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("15:30");
  const add = async () => {
    if (!title.trim() || !date) return showToast("Week title and date are required");
    const next = [...weeks.map((week) => ({ ...week, status: week.status === "current" ? "closed" : week.status })), { id: Math.random().toString(36).slice(2), title: title.trim(), date, time, status: "current" }];
    await saveWeeks(next); await addAudit("Week created", `${title} · ${date} ${time}`); setTitle(""); setDate(""); showToast("Current week created");
  };
  const makeCurrent = async (id) => { await saveWeeks(weeks.map((week) => ({ ...week, status: week.id === id ? "current" : week.status === "current" ? "closed" : week.status }))); await addAudit("Current week changed", id); };
  return <div className="ez-admin-view"><h1 className="ez-admin-h1">Weeks</h1><Ticket_ className="ez-authcard"><label className="ez-field"><span>Week title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="August 23 Week"/></label><div className="ez-admin-control-grid"><label className="ez-field"><span>Draw date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)}/></label><label className="ez-field"><span>Draw time</span><input type="time" value={time} onChange={(e) => setTime(e.target.value)}/></label></div><button className="ez-btn ez-btn-gold ez-btn-block" onClick={add}>Create week</button></Ticket_><div className="ez-week-list">{weeks.map((week) => <Ticket_ key={week.id} className="ez-week-row"><div><strong>{week.title}</strong><span>{week.date} · {week.time}</span></div><span className={`ez-history-status ${week.status === "current" ? "sent" : ""}`}>{week.status}</span>{week.status !== "current" && <button className="ez-link" onClick={() => makeCurrent(week.id)}>Make current</button>}</Ticket_>)}</div></div>;
}

function AdminDream100() {
  const { dream100, saveDream100, showToast, addAudit } = useApp();
  const [number, setNumber] = useState(""); const [label, setLabel] = useState(""); const [meaning, setMeaning] = useState("");
  const add = async () => { if (!/^\d{3}$/.test(number) || !label.trim()) return showToast("3-digit number and label are required"); const next = [...dream100.filter((item) => item.number !== number), { number, label: label.trim(), meaning: meaning.trim() }].sort((a, b) => a.number.localeCompare(b.number)); await saveDream100(next); await addAudit("Dream1000 updated", `${number} · ${label}`); setNumber(""); setLabel(""); setMeaning(""); };
  const remove = async (target) => { await saveDream100(dream100.filter((item) => item.number !== target)); await addAudit("Dream1000 deleted", target); };
  return <div className="ez-admin-view"><h1 className="ez-admin-h1">Dream1000</h1><Ticket_ className="ez-authcard"><div className="ez-admin-control-grid"><label className="ez-field"><span>Number</span><input value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, "").slice(0, 3))} placeholder="001"/></label><label className="ez-field"><span>Dream label</span><input value={label} onChange={(e) => setLabel(e.target.value)}/></label></div><label className="ez-field"><span>Meaning</span><input value={meaning} onChange={(e) => setMeaning(e.target.value)}/></label><button className="ez-btn ez-btn-gold ez-btn-block" onClick={add}>Save Dream1000 item</button></Ticket_><div className="ez-dream-grid">{dream100.map((item) => <Ticket_ key={item.number} className="ez-dream-card"><strong>{item.number}</strong><div><b>{item.label}</b><span>{item.meaning}</span></div><button className="ez-link" onClick={() => remove(item.number)}>Delete</button></Ticket_>)}</div></div>;
}

function AdminAudit() {
  const { auditLogs } = useApp();
  return <div className="ez-admin-view"><h1 className="ez-admin-h1">Audit History</h1>{auditLogs.length === 0 ? <p className="ez-empty-note">No admin actions recorded yet.</p> : <table className="ez-table"><thead><tr><th>Date / time</th><th>Admin</th><th>Action</th><th>Detail</th></tr></thead><tbody>{auditLogs.map((log) => <tr key={log.id}><td>{new Date(log.createdAt).toLocaleString()}</td><td className="mono">{log.actor}</td><td>{log.action}</td><td>{log.detail || "—"}</td></tr>)}</tbody></table>}</div>;
}

function AdminResults() {
  const { drawRecord, saveDrawRecord, today, showToast, previousResults, savePreviousResults, weeks, profile, entries, closedNumbers, addAudit } = useApp();
  const currentWeek = weeks.find((week) => week.status === "current") || weeks[0];
  const [weekId, setWeekId] = useState(currentWeek?.id || "");
  const selectedWeek = weeks.find((week) => week.id === weekId) || currentWeek;
  const [num, setNum] = useState(drawRecord.draft || "");
  const [date, setDate] = useState(selectedWeek?.date || today);
  const relevantEntries = allEntriesForAdmin(entries, profile).filter((entry) => entry.drawDate === date);
  const computed = drawRecord.published && drawRecord.date === date ? relevantEntries.map((entry) => ({ entry, result: calculateEntryResult(entry, drawRecord.published, closedNumbers) })) : [];
  const winners = computed.filter(({ result }) => result.outcome === "exact" || result.outcome === "twd");

  const saveDraft = async () => {
    if (!/^\d{3}$/.test(num)) return showToast("Enter a 3-digit number");
    const next = { ...drawRecord, draft: num, published: drawRecord.date === date ? drawRecord.published : null, date, weekId, weekTitle: selectedWeek?.title, draftUpdatedAt: new Date().toISOString() };
    await saveDrawRecord(next);
    await addAudit("Draw draft saved", `${selectedWeek?.title || date} · ${num}`);
    showToast("Draft saved — not visible to users yet");
  };
  const publish = async () => {
    const n = drawRecord.draft || num;
    if (!/^\d{3}$/.test(n)) return showToast("Save a valid 3-digit draft first");
    const publishedAt = new Date().toISOString();
    await saveDrawRecord({ ...drawRecord, draft: n, published: n, date, weekId, weekTitle: selectedWeek?.title, publishedAt, publishedBy: profile.id });
    const d = new Date(date);
    const record = { date, number: n, weekId, weekTitle: selectedWeek?.title, drawTime: selectedWeek?.time || "15:30", publishedAt, publishedBy: profile.id, month: d.toLocaleString("en-US", { month: "long" }), year: d.getFullYear(), note: "" };
    await savePreviousResults([record, ...previousResults.filter((r) => !(r.date === date && (r.weekId || "") === (weekId || "")))]);
    await addAudit("Result published", `${selectedWeek?.title || date} · ${n}`);
    showToast(`Published ${n} for ${date} — winners now calculated automatically`);
  };

  return (
    <div className="ez-admin-view">
      <h1 className="ez-admin-h1">Draws & Results</h1>
      <Ticket_ className="ez-authcard">
        <label className="ez-field"><span>Lottery Week / Draw</span><select className="ez-select" value={weekId} onChange={(e) => { const nextId = e.target.value; const week = weeks.find((item) => item.id === nextId); setWeekId(nextId); if (week) setDate(week.date); }}><option value="">Select week</option>{weeks.map((week) => <option key={week.id} value={week.id}>{week.title} · {week.date} {week.time}</option>)}</select></label>
        <label className="ez-field"><span>Winning Number</span><input value={num} onChange={(e) => setNum(e.target.value.replace(/\D/g, "").slice(0, 3))} placeholder="312" /></label>
        <label className="ez-field"><span>Draw Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <div className="ez-editrow">
          <button className="ez-btn ez-btn-ghost ez-btn-sm" onClick={saveDraft}>Save Draft</button>
          <button className="ez-btn ez-btn-gold ez-btn-sm" onClick={publish}><Send size={14} /> Publish Result</button>
        </div>
        <p className="ez-authnote">Draft results are never shown publicly. Publishing runs the rules engine against every saved entry for that date.</p>
      </Ticket_>
      {drawRecord.draft && (
        <Ticket_ className="ez-draw-admin-status"><strong>{drawRecord.weekTitle || drawRecord.date}</strong><span>Winning number: <b>{drawRecord.draft}</b> · {drawRecord.published === drawRecord.draft ? "Published" : "Draft / editable"}</span>{drawRecord.publishedAt && <small>Published {new Date(drawRecord.publishedAt).toLocaleString()} by {drawRecord.publishedBy}</small>}</Ticket_>
      )}
      {drawRecord.published && drawRecord.date === date && <><div className="ez-statgrid ez-result-stats"><StatCard label="Entries" value={relevantEntries.length} icon={Ticket}/><StatCard label="Winners" value={winners.length} icon={Trophy}/><StatCard label="Prize total (Ks)" value={winners.reduce((sum, item) => sum + item.result.prize, 0).toLocaleString()} icon={Coins}/></div>{winners.length > 0 && <table className="ez-table"><thead><tr><th>Member</th><th>ID</th><th>Entry</th><th>Result</th><th>Prize</th></tr></thead><tbody>{winners.map(({ entry, result }) => <tr key={entry.id}><td>{entry.ownerName}</td><td className="mono">{entry.ownerId}</td><td>{entry.number}{entry.hasR ? "R" : ""}</td><td>{result.outcome} · {result.multiplier}×</td><td>{result.prize.toLocaleString()} Ks</td></tr>)}</tbody></table>}</>}
      <div className="ez-row-head"><h2>Published result history</h2></div><table className="ez-table"><thead><tr><th>Week</th><th>Number</th><th>Draw date / time</th><th>Published by</th></tr></thead><tbody>{previousResults.map((result, index) => <tr key={`${result.date}-${index}`}><td>{result.weekTitle || `${result.month} ${result.date}`}</td><td className="mono">{result.number}</td><td>{result.date} · {result.drawTime || "—"}</td><td className="mono">{result.publishedBy || "Demo import"}</td></tr>)}</tbody></table>
    </div>
  );
}

function AdminWinners() {
  const { entries, profile, drawRecord } = useApp();
  const winningNumber = drawRecord.published;
  const all = allEntriesForAdmin(entries, profile).filter((e) => e.drawDate === drawRecord.date);
  const computed = all.map((e) => ({ entry: e, result: winningNumber ? calculateEntryResult(e, winningNumber) : { outcome: "pending" } }));
  const winners = computed.filter((c) => c.result.outcome === "exact" || c.result.outcome === "twd");
  const totalBet = all.reduce((s, e) => s + e.amount, 0);
  const totalLiability = winners.reduce((s, w) => s + w.result.prize, 0);

  return (
    <div className="ez-admin-view">
      <h1 className="ez-admin-h1">Winners</h1>
      {!winningNumber ? (
        <p className="ez-empty-note">Publish a result in Draws & Results to compute winners.</p>
      ) : (
        <>
          <div className="ez-statgrid">
            <StatCard label="Total entries" value={all.length} icon={Ticket} />
            <StatCard label="Total staked (Ks)" value={totalBet.toLocaleString()} icon={Coins} />
            <StatCard label="Exact winners" value={winners.filter((w) => w.result.outcome === "exact").length} icon={Award} />
            <StatCard label="TWD winners" value={winners.filter((w) => w.result.outcome === "twd").length} icon={Award} />
            <StatCard label="Total winners" value={winners.length} icon={Trophy} />
            <StatCard label="Total prize liability (Ks)" value={totalLiability.toLocaleString()} icon={Coins} />
          </div>
          <div className="ez-row-head"><h2>Result: {winningNumber}</h2></div>
          {winners.length === 0 ? <p className="ez-empty-note">No winners for this draw.</p> : (
            <table className="ez-table">
              <thead><tr><th></th><th>Nickname</th><th>ID</th><th>Number</th><th>Amount</th><th>Outcome</th><th>Multiplier</th><th>Prize</th></tr></thead>
              <tbody>
                {winners.map((w, i) => (
                  <tr key={i}>
                    <td>{w.entry.ownerAvatar}</td>
                    <td>{w.entry.ownerName}</td>
                    <td className="mono">{w.entry.ownerId}</td>
                    <td>{w.entry.number}{w.entry.hasR ? "R" : ""}</td>
                    <td>{w.entry.amount.toLocaleString()}</td>
                    <td>{w.result.outcome === "exact" ? "Exact Win" : "TWD Win"}</td>
                    <td>{w.result.multiplier}×</td>
                    <td><strong>{w.result.prize.toLocaleString()}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function AdminPrevious() {
  const { previousResults, savePreviousResults, showToast } = useApp();
  const [num, setNum] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");

  const add = async () => {
    if (!/^\d{3}$/.test(num) || !date) return showToast("Enter a 3-digit number and date");
    const d = new Date(date);
    await savePreviousResults([
      { date, number: num, month: d.toLocaleString("en-US", { month: "long" }), year: d.getFullYear(), note },
      ...previousResults,
    ]);
    setNum(""); setDate(""); setNote("");
    showToast("Historical result added");
  };

  return (
    <div className="ez-admin-view">
      <h1 className="ez-admin-h1">Previous Results — manage history</h1>
      <Ticket_ className="ez-authcard">
        <label className="ez-field"><span>Winning Number</span><input value={num} onChange={(e) => setNum(e.target.value.replace(/\D/g, "").slice(0, 3))} placeholder="704" /></label>
        <label className="ez-field"><span>Draw Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="ez-field"><span>Note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. imported from last month" /></label>
        <button className="ez-btn ez-btn-gold ez-btn-block" onClick={add}>Add historical result</button>
      </Ticket_>
      <div className="ez-row-head" style={{ marginTop: 20 }}><h2>All results ({previousResults.length})</h2></div>
      <table className="ez-table">
        <thead><tr><th>Date</th><th>Number</th><th>Month</th><th>Year</th><th>Note</th></tr></thead>
        <tbody>
          {previousResults.map((r, i) => (
            <tr key={i}><td>{r.date}</td><td className="mono">{r.number}</td><td>{r.month}</td><td>{r.year}</td><td>{r.note || "—"}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* =======================================================================
   STYLES
======================================================================= */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,500;0,600;0,700;1,600&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&family=Noto+Sans+Myanmar:wght@400;500;600;700&display=swap');

:root{
  --ink:#0A1512; --panel:#12241F; --panel2:#16302A; --jade:#1F5C4F;
  --gold:#E7B54B; --gold-deep:#C9932E; --ruby:#E1495B; --cream:#F4ECD8; --mist:#8FA39B;
  --sage:#5CA98F; --radius:16px;
}
*{box-sizing:border-box;}
.ez-root{
  background:var(--ink); color:var(--cream); min-height:100vh; max-width:480px; margin:0 auto;
  font-family:'Inter','Noto Sans Myanmar',sans-serif; position:relative; padding-bottom:78px;
  background-image: radial-gradient(circle at 20% 0%, rgba(31,92,79,0.35), transparent 55%), radial-gradient(circle at 90% 10%, rgba(231,181,75,0.08), transparent 45%);
}
.ez-root-admin{max-width:none;width:100%;padding-bottom:0;}
.ez-root *{font-family:'Inter','Noto Sans Myanmar',sans-serif;}
.ez-boot{display:flex;align-items:center;justify-content:center;min-height:100vh;}
.ez-boot-mark{font-family:'Fraunces',serif;font-size:34px;font-weight:600;color:var(--cream);letter-spacing:0.5px;}
.ez-boot-mark span{color:var(--gold);}

.ez-topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 10px;}
.ez-top-actions{display:flex;align-items:center;gap:7px;}.ez-admin-open{display:flex;align-items:center;gap:5px;background:var(--gold);color:#221505;border:0;border-radius:99px;padding:8px 10px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;}
.ez-brand{display:flex;align-items:baseline;gap:2px;cursor:pointer;font-family:'Fraunces',serif;font-weight:600;font-size:20px;}
.ez-brand-mark{color:var(--cream);}
.ez-brand-mark2{color:var(--gold);font-style:italic;}
.ez-idchip{display:flex;align-items:center;gap:7px;background:var(--panel);border:1px solid rgba(244,236,216,0.08);padding:6px 12px 6px 6px;border-radius:99px;cursor:pointer;}
.ez-idchip-avatar{width:26px;height:26px;border-radius:50%;background:var(--panel2);display:flex;align-items:center;justify-content:center;font-size:14px;}
.ez-idchip-id{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--mist);}

.ez-main{padding:6px 18px 20px;}
.ez-admin-main{padding:0;}
.ez-view{animation:fadeIn .35s ease;}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}

.ez-h1{font-family:'Fraunces',serif;font-size:26px;font-weight:600;margin:8px 0 2px;}
.ez-sub{color:var(--mist);font-size:13px;margin:0 0 18px;}

/* ticket / signature card */
.ez-ticket{position:relative;background:var(--panel);border-radius:var(--radius);padding:20px 18px;margin-bottom:12px;border:1px solid rgba(244,236,216,0.06);}
.ez-ticket::before,.ez-ticket::after{content:'';position:absolute;left:8px;right:8px;height:9px;
  background-image:radial-gradient(circle at 9px 5px, var(--ink) 4.5px, transparent 5px);
  background-size:18px 9px;background-repeat:repeat-x;}
.ez-ticket::before{top:-1px;}
.ez-ticket::after{bottom:-1px;transform:rotate(180deg);}
.ez-ticket-gold{background:linear-gradient(160deg, var(--panel2), var(--panel));border-color:rgba(231,181,75,0.25);}

.ez-hero{text-align:center;padding:26px 6px 10px;}
.ez-hero-eyebrow{display:inline-flex;align-items:center;gap:5px;color:var(--gold);font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:600;}
.ez-hero-clock{font-family:'JetBrains Mono',monospace;font-size:40px;font-weight:700;margin-top:10px;color:var(--cream);letter-spacing:1px;}
.ez-hero-sub{color:var(--mist);font-size:12px;margin-top:2px;}
.ez-hero-countdown{margin:18px auto 20px;display:inline-flex;flex-direction:column;gap:2px;background:var(--panel);padding:12px 24px;border-radius:14px;border:1px solid rgba(231,181,75,0.2);}
.ez-hero-countdown-label{font-size:11px;color:var(--mist);}
.ez-hero-countdown-time{font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:700;color:var(--gold);}

.ez-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:none;border-radius:12px;padding:13px 20px;font-weight:600;font-size:14px;cursor:pointer;transition:transform .15s ease, opacity .15s ease;font-family:inherit;}
.ez-btn:active{transform:scale(0.97);}
.ez-btn-gold{background:linear-gradient(160deg, var(--gold), var(--gold-deep));color:#211405;}
.ez-btn-cream{background:var(--cream);color:var(--ink);}
.ez-btn-ghost{background:transparent;border:1px solid rgba(244,236,216,0.18);color:var(--cream);}
.ez-btn-sm{padding:9px 14px;font-size:13px;}
.ez-btn-lg{padding:15px 26px;font-size:15px;}
.ez-btn-block{width:100%;}
.ez-btn:disabled{opacity:0.4;cursor:not-allowed;}
.ez-link{background:none;border:none;color:var(--gold);font-size:13px;cursor:pointer;padding:6px 0;font-weight:600;}

.ez-row-head{display:flex;align-items:center;justify-content:space-between;margin:22px 0 10px;}
.ez-row-head h2{font-family:'Fraunces',serif;font-size:17px;font-weight:600;margin:0;}

.ez-latest{display:flex;flex-direction:column;align-items:center;padding:26px 18px;}
.ez-latest-date{font-size:11px;color:var(--mist);display:flex;align-items:center;gap:5px;}
.ez-latest-number{font-family:'JetBrains Mono',monospace;font-size:46px;font-weight:700;color:var(--gold);letter-spacing:6px;margin:8px 0 4px;}
.ez-latest-tag{font-size:11px;color:var(--mist);}
.ez-board-count{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--mist);text-transform:uppercase;letter-spacing:.5px;}
.ez-number-board-card{padding:16px 12px 14px;}
.ez-number-legend{display:flex;justify-content:center;gap:14px;margin:3px 0 13px;font-size:9px;color:var(--mist);}
.ez-number-legend span{display:flex;align-items:center;gap:5px;}.ez-number-legend i{width:10px;height:10px;border-radius:3px;border:1px solid rgba(244,236,216,.28);}.ez-number-legend i.empty{background:var(--cream);}.ez-number-legend i.taken{background:var(--gold);}.ez-number-legend i.closed{background:var(--ruby);}
.ez-number-board{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:4px;max-height:330px;overflow-y:auto;padding:2px 4px 8px;scrollbar-color:var(--jade) transparent;}
.ez-number-cell{height:29px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;color:var(--ink);border:1px solid rgba(244,236,216,.2);}.ez-number-cell.empty{background:var(--cream);}.ez-number-cell.taken{background:var(--gold);border-color:var(--gold-deep);}.ez-number-cell.closed{background:var(--ruby);color:#fff;border-color:#b93344;}
.ez-public-winners{display:flex;flex-direction:column;gap:0;}.ez-public-winner{display:flex;align-items:center;gap:14px;padding:17px 18px;}.ez-public-winner-avatar{width:54px;height:54px;border-radius:50%;background:var(--panel2);border:2px solid rgba(231,181,75,.32);display:flex;align-items:center;justify-content:center;font-size:28px;object-fit:cover;flex:none;}.ez-public-winner>div{display:grid;gap:2px;}.ez-public-winner small{font-size:9px;color:var(--gold);letter-spacing:1px;font-weight:700;}.ez-public-winner strong{font-family:'Fraunces',serif;font-size:22px;line-height:1.15;}.ez-public-winner span{font-size:11px;color:var(--mist);}.ez-public-winner.exact{box-shadow:0 0 24px rgba(231,181,75,.12);}

.ez-quickgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
.ez-quick{background:var(--panel);border:1px solid rgba(244,236,216,0.07);border-radius:14px;padding:16px 8px;display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--cream);cursor:pointer;font-size:11.5px;font-weight:600;text-align:center;}
.ez-quick svg{color:var(--gold);}

.ez-cta-signup{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px;}
.ez-cta-signup p{color:var(--mist);font-size:12px;margin:4px 0 0;}

/* community */
.ez-communitygrid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;}
.ez-membercard{background:var(--panel);border:1px solid rgba(244,236,216,0.07);border-radius:16px;padding:16px 12px;text-align:left;cursor:pointer;color:var(--cream);}
.ez-membercard-avatar{font-size:26px;}
.ez-membercard-name{font-weight:600;font-size:13.5px;margin-top:8px;display:flex;align-items:center;gap:6px;}
.ez-you-badge{background:var(--gold);color:#221505;font-size:9px;padding:1px 6px;border-radius:99px;font-weight:700;}
.ez-membercard-id{font-family:'JetBrains Mono',monospace;font-size:10.5px;color:var(--mist);margin-top:2px;}
.ez-membercard-meta{font-size:10.5px;color:var(--sage);margin-top:6px;}

.ez-modal-backdrop{position:fixed;inset:0;background:rgba(5,10,8,0.72);display:flex;align-items:flex-end;justify-content:center;z-index:50;backdrop-filter:blur(2px);}
.ez-modal{background:var(--panel);width:100%;max-width:480px;border-radius:22px 22px 0 0;padding:26px 22px 30px;position:relative;animation:slideUp .28s ease;max-height:82vh;overflow-y:auto;}
.ez-modal-sm{border-radius:18px;max-width:340px;margin:auto;padding:22px;}
@keyframes slideUp{from{transform:translateY(30px);opacity:0;}to{transform:translateY(0);opacity:1;}}
.ez-modal-close{position:absolute;top:16px;right:16px;background:var(--panel2);border:none;color:var(--cream);border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;}
.ez-modal-avatar{font-size:40px;text-align:center;}
.ez-modal-name{text-align:center;font-family:'Fraunces',serif;font-size:19px;font-weight:600;margin-top:6px;}
.ez-modal-id{text-align:center;color:var(--mist);font-family:'JetBrains Mono',monospace;font-size:12px;margin-top:2px;}
.ez-modal-joined{text-align:center;color:var(--mist);font-size:11px;margin-top:4px;}
.ez-modal-section{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--sage);margin:20px 0 8px;font-weight:700;}
.ez-modal-numbers{display:flex;flex-wrap:wrap;gap:7px;}
.ez-numpill{background:var(--panel2);padding:6px 11px;border-radius:99px;font-family:'JetBrains Mono',monospace;font-size:12px;border:1px solid rgba(231,181,75,0.18);}
.ez-modal-empty{color:var(--mist);font-size:12.5px;}
.ez-winbadge{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--gold);background:rgba(231,181,75,0.08);padding:9px 12px;border-radius:10px;margin-bottom:6px;}

/* entry */
.ez-textarea{width:100%;background:var(--panel);border:1px solid rgba(244,236,216,0.1);border-radius:14px;padding:14px;color:var(--cream);font-family:'JetBrains Mono',monospace;font-size:14px;resize:vertical;}
.ez-textarea:focus{outline:2px solid var(--gold);}
.ez-preview{background:var(--panel);border-radius:14px;padding:12px 14px;margin:14px 0;}
.ez-preview-head{font-size:11px;color:var(--mist);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;font-weight:700;}
.ez-preview-row{display:flex;align-items:center;gap:9px;padding:6px 0;font-size:13.5px;}
.ez-preview-row.ok svg{color:var(--sage);}
.ez-preview-row.bad{color:var(--ruby);}
.ez-preview-row.bad svg{color:var(--ruby);flex-shrink:0;}
.ez-preview-num{font-family:'JetBrains Mono',monospace;font-weight:700;}
.ez-preview-amt{margin-left:auto;color:var(--gold);font-weight:600;}
.ez-preview-total{border-top:1px solid rgba(244,236,216,.08);margin-top:8px;padding-top:10px;text-align:right;color:var(--gold);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;}
.ez-r-badge{font-style:normal;background:var(--ruby);color:#fff;font-size:9px;padding:1px 5px;border-radius:5px;margin-left:4px;}
.ez-empty-note{color:var(--mist);font-size:13px;text-align:left;}
.ez-entrylist{display:flex;flex-direction:column;gap:0;}
.ez-entry-row{display:flex;align-items:center;gap:12px;padding:14px 16px;}
.ez-entry-num{font-family:'JetBrains Mono',monospace;font-weight:700;}
.ez-entry-amt{color:var(--gold);font-weight:600;font-size:13px;}
.ez-entry-src{margin-left:auto;font-size:10.5px;color:var(--mist);text-transform:uppercase;letter-spacing:0.5px;}
.ez-outcome{margin-left:auto;font-size:11px;padding:3px 9px;border-radius:99px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;}
.ez-outcome.pending{background:rgba(143,163,155,0.15);color:var(--mist);}
.ez-outcome.none{background:rgba(143,163,155,0.15);color:var(--mist);}
.ez-outcome.win{background:rgba(231,181,75,0.18);color:var(--gold);}

.ez-gate{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:34px 20px;}
.ez-gate svg{color:var(--gold);}
.ez-gate h3{font-family:'Fraunces',serif;font-size:18px;margin:4px 0 0;}
.ez-gate p{color:var(--mist);font-size:13px;margin:0 0 8px;}

/* draw */
.ez-drawview{text-align:center;}
.ez-draw-clock{font-family:'JetBrains Mono',monospace;font-size:15px;color:var(--mist);margin-top:6px;}
.ez-draw-clock span{font-size:10px;margin-left:6px;text-transform:uppercase;letter-spacing:1px;}
.ez-draw-countdown{display:inline-flex;align-items:center;gap:6px;background:var(--panel);padding:8px 16px;border-radius:99px;font-size:13px;color:var(--cream);margin:14px 0;}
.ez-draw-countdown strong{color:var(--gold);font-family:'JetBrains Mono',monospace;}
.ez-draw-status{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:6px 14px;border-radius:99px;margin:10px 0;font-weight:600;}
.ez-draw-status.published{background:rgba(92,169,143,0.15);color:var(--sage);}
.ez-draw-status.demo{background:rgba(231,181,75,0.12);color:var(--gold);}

.ez-lanterns{display:flex;justify-content:center;gap:16px;margin:38px 0 20px;padding-top:22px;}
.ez-lantern{width:72px;height:92px;background:linear-gradient(180deg,var(--gold),var(--gold-deep));border-radius:38% 38% 22% 22%/50% 50% 18% 18%;position:relative;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 26px rgba(231,181,75,0.18);animation:sway 3.6s ease-in-out infinite;}
.ez-lantern:nth-child(2){animation-duration:4.1s;}
.ez-lantern:nth-child(3){animation-duration:3.3s;}
.ez-lanterns.settled .ez-lantern{animation-play-state:paused;}
.ez-lantern.lit{box-shadow:0 0 32px rgba(231,181,75,0.55),0 10px 26px rgba(231,181,75,0.3);}
.ez-lantern-cap{position:absolute;top:-14px;width:3px;height:16px;background:rgba(244,236,216,0.4);}
.ez-lantern-digit{font-family:'JetBrains Mono',monospace;font-size:30px;font-weight:700;color:#231607;}
@keyframes sway{0%,100%{transform:rotate(-4deg);}50%{transform:rotate(4deg);}}

.ez-drawresults{margin-top:6px;}
.ez-match-summary{background:var(--panel);border:1px solid rgba(244,236,216,.07);border-radius:14px;padding:13px 14px;margin-bottom:14px;text-align:left;}.ez-match-summary-title{color:var(--mist);font-size:10px;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:7px;}.ez-match-row{display:grid;grid-template-columns:58px 1fr auto;align-items:center;gap:8px;padding:8px 0;border-top:1px solid rgba(244,236,216,.06);font-size:11px;}.ez-match-row strong{font-family:'JetBrains Mono',monospace;font-size:13px;}.ez-match-row span{color:var(--mist);}.ez-match-row b{font-family:'JetBrains Mono',monospace;color:var(--gold);font-size:10px;}.ez-match-row.exact strong,.ez-match-row.exact span{color:var(--gold);}.ez-match-row.twd strong,.ez-match-row.twd span{color:var(--sage);}.ez-match-row.koreamiss strong{color:var(--cream);}.ez-match-row.koreamiss span{color:var(--gold);}
.ez-resultcard{text-align:left;position:relative;overflow:hidden;}
.ez-resultcard-title{font-family:'Fraunces',serif;font-size:19px;font-weight:600;text-align:center;}
.ez-resultcard-sub{text-align:center;color:var(--mist);font-size:13px;margin-top:4px;}
.ez-resultcard-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0;}
.ez-resultcard-grid div{display:flex;flex-direction:column;gap:2px;}
.ez-resultcard-grid span{font-size:10.5px;color:var(--mist);text-transform:uppercase;letter-spacing:0.6px;}
.ez-resultcard-grid strong{font-family:'JetBrains Mono',monospace;font-size:16px;}
.ez-resultcard-prize{text-align:center;font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:700;color:var(--gold);margin-top:10px;line-height:1.45;text-shadow:0 0 18px rgba(231,181,75,.35);}
.ez-resultcard.celebrate{animation:pulseGlow 1.6s ease-in-out infinite;}
@keyframes pulseGlow{0%,100%{box-shadow:0 0 0 rgba(231,181,75,0);}50%{box-shadow:0 0 34px rgba(231,181,75,0.35);}}
.ez-confetti{position:absolute;inset:0;pointer-events:none;overflow:hidden;}
.ez-confetti span{position:absolute;top:-10px;width:7px;height:11px;opacity:0.9;animation:confettiFall linear forwards;}
@keyframes confettiFall{to{transform:translateY(220px) rotate(340deg);opacity:0;}}
.ez-demo-controls{margin-top:22px;}

/* previous results */
.ez-filterbar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;}
.ez-select{background:var(--panel);border:1px solid rgba(244,236,216,0.1);color:var(--cream);border-radius:10px;padding:9px 10px;font-size:12.5px;}
.ez-searchbox{display:flex;align-items:center;gap:6px;background:var(--panel);border:1px solid rgba(244,236,216,0.1);border-radius:10px;padding:8px 12px;flex:1;min-width:120px;}
.ez-searchbox input{background:none;border:none;color:var(--cream);font-size:12.5px;width:100%;}
.ez-searchbox input:focus{outline:none;}
.ez-resultslist{display:flex;flex-direction:column;gap:0;}
.ez-resultrow{display:flex;align-items:center;gap:14px;padding:14px 16px;}
.ez-resultrow-num{font-family:'JetBrains Mono',monospace;font-size:19px;font-weight:700;color:var(--gold);}
.ez-resultrow-date{font-size:11.5px;color:var(--mist);display:flex;align-items:center;gap:4px;margin-left:auto;}
.ez-resultrow-note{font-size:11px;color:var(--mist);}

/* auth */
.ez-authview{padding-top:10px;}
.ez-auth-tabs{display:flex;gap:6px;background:var(--panel);border-radius:12px;padding:4px;margin-bottom:18px;}
.ez-auth-tabs button{flex:1;background:none;border:none;color:var(--mist);padding:10px;border-radius:9px;font-weight:600;font-size:13px;cursor:pointer;}
.ez-auth-tabs button.active{background:var(--gold);color:#221505;}
.ez-authcard{display:flex;flex-direction:column;gap:12px;}
.ez-field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--mist);}
.ez-field input,.ez-field select{background:var(--panel2);border:1px solid rgba(244,236,216,0.1);color:var(--cream);border-radius:10px;padding:11px 12px;font-size:14px;}
.ez-field input:focus{outline:2px solid var(--gold);}
.ez-pwrow{display:flex;align-items:center;background:var(--panel2);border:1px solid rgba(244,236,216,0.1);border-radius:10px;}
.ez-pwrow input{background:none;border:none;flex:1;padding:11px 12px;color:var(--cream);font-size:14px;}
.ez-pwrow input:focus{outline:none;}
.ez-pwrow button{background:none;border:none;color:var(--mist);padding:0 12px;cursor:pointer;}
.ez-error{color:var(--ruby);font-size:12.5px;background:rgba(225,73,91,0.1);padding:8px 10px;border-radius:8px;}
.ez-authnote{color:var(--mist);font-size:11.5px;line-height:1.5;text-align:center;}
.ez-avatarpicker{display:grid;grid-template-columns:repeat(8,1fr);gap:6px;margin-bottom:4px;}
.ez-avatarpicker-item{background:var(--panel2);border:2px solid transparent;border-radius:10px;font-size:18px;padding:6px 0;cursor:pointer;}
.ez-avatarpicker-item.sel{border-color:var(--gold);}
.ez-fp-steps{display:flex;justify-content:center;gap:6px;margin-bottom:6px;}
.ez-fp-dot{width:7px;height:7px;border-radius:50%;background:rgba(244,236,216,0.15);}
.ez-fp-dot.active{background:var(--gold);}

/* profile */
.ez-profilehead{text-align:center;padding:14px 0 8px;}
.ez-profile-avatar{width:88px;height:88px;border-radius:50%;margin:0 auto;background:var(--panel2);border:2px solid rgba(231,181,75,.35);display:flex;align-items:center;justify-content:center;font-size:52px;object-fit:cover;}
.ez-photo-upload{cursor:pointer;}.ez-photo-upload input{display:none;}
.ez-profile-name{font-family:'Fraunces',serif;font-size:22px;font-weight:600;margin-top:8px;}
.ez-inline-input{background:var(--panel2);border:1px solid var(--gold);border-radius:8px;padding:6px 10px;font-size:18px;color:var(--cream);text-align:center;font-family:'Fraunces',serif;}
.ez-profile-id{font-family:'JetBrains Mono',monospace;color:var(--mist);font-size:13px;margin-top:2px;}
.ez-profile-joined{font-size:11px;color:var(--mist);margin-top:2px;}
.ez-profile-admin{margin:12px 0 18px;}
.ez-editrow{display:flex;gap:10px;justify-content:flex-end;}

.ez-bottomnav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:480px;background:rgba(18,36,31,0.94);backdrop-filter:blur(10px);display:flex;border-top:1px solid rgba(244,236,216,0.08);padding:8px 6px calc(8px + env(safe-area-inset-bottom));z-index:20;}
.ez-navbtn{flex:1;background:none;border:none;color:var(--mist);display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 2px;cursor:pointer;font-size:9.5px;font-weight:600;}
.ez-navbtn.active{color:var(--gold);}
.ez-adminlink{position:fixed;bottom:92px;right:14px;font-size:9px;color:rgba(143,163,155,0.35);display:flex;align-items:center;gap:3px;cursor:pointer;letter-spacing:0.5px;z-index:15;}

.ez-toast{position:fixed;bottom:96px;left:50%;transform:translateX(-50%);background:var(--cream);color:var(--ink);padding:11px 18px;border-radius:99px;font-size:12.5px;font-weight:600;z-index:60;box-shadow:0 8px 24px rgba(0,0,0,0.3);max-width:88%;text-align:center;}

/* admin shell */
.ez-admin{display:flex;min-height:100vh;font-size:13px;}
.ez-admin-side{width:190px;flex-shrink:0;background:var(--panel);padding:18px 12px;display:flex;flex-direction:column;gap:2px;border-right:1px solid rgba(244,236,216,0.06);}
.ez-admin-brand{display:flex;align-items:center;gap:7px;font-weight:700;font-size:12.5px;color:var(--mist);cursor:pointer;margin-bottom:14px;padding:4px 8px;}
.ez-admin-navitem{display:flex;align-items:center;gap:9px;background:none;border:none;color:var(--cream);padding:10px 10px;border-radius:9px;cursor:pointer;text-align:left;font-size:12.5px;font-weight:500;}
.ez-admin-navitem.active{background:var(--gold);color:#221505;font-weight:700;}
.ez-admin-navitem svg{flex-shrink:0;}
.ez-admin-logout{margin-top:auto;color:var(--ruby);}
.ez-admin-content{flex:1;padding:26px 30px;overflow-y:auto;max-height:100vh;}
.ez-admin-view{max-width:760px;}
.ez-admin-h1{font-family:'Fraunces',serif;font-size:22px;margin:0 0 18px;}
.ez-admin-titlebar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;}
.ez-admin-titlebar .ez-admin-h1{margin:0;}
.ez-credential{background:var(--panel2);border:1px dashed rgba(231,181,75,0.28);border-radius:12px;padding:14px;margin:18px 0 12px;display:grid;gap:4px;}
.ez-credential span{font-size:10px;color:var(--mist);text-transform:uppercase;letter-spacing:.6px;margin-top:4px;}
.ez-credential strong{font-family:'JetBrains Mono',monospace;color:var(--gold);font-size:18px;}
.ez-admin-lead{color:var(--mist);font-size:12.5px;margin:-10px 0 18px;}
.ez-admin-panel{max-width:420px;}
.ez-admin-panel-title{font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.6px;color:var(--sage);margin-bottom:6px;}
.ez-admin-home-summary{margin-bottom:22px;}.ez-admin-summary-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:15px;}.ez-admin-summary-head>div{display:flex;align-items:center;gap:7px;color:var(--gold);}.ez-admin-summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}.ez-admin-summary-grid span{display:grid;gap:3px;background:var(--panel2);border-radius:10px;padding:10px;}.ez-admin-summary-grid small{font-size:9px;text-transform:uppercase;color:var(--mist);letter-spacing:.5px;}.ez-admin-summary-grid b{font-family:'JetBrains Mono',monospace;font-size:12px;overflow-wrap:anywhere;}
.ez-admin-shortcuts{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;}
.ez-statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:22px;}
.ez-statcard{background:var(--panel);border-radius:14px;padding:16px;border:1px solid rgba(244,236,216,0.06);}
.ez-statcard svg{color:var(--gold);}
.ez-statcard-value{font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:700;margin-top:8px;}
.ez-statcard-label{font-size:11px;color:var(--mist);margin-top:2px;}
.ez-admin-search{max-width:320px;margin-bottom:16px;}
.ez-table{width:100%;border-collapse:collapse;font-size:12.5px;}
.ez-table th{text-align:left;color:var(--mist);font-weight:600;padding:8px 10px;border-bottom:1px solid rgba(244,236,216,0.08);font-size:11px;text-transform:uppercase;letter-spacing:0.4px;}
.ez-table td{padding:10px;border-bottom:1px solid rgba(244,236,216,0.05);}
.ez-table-avatar{font-size:16px;}
.ez-status-active{color:var(--sage);font-weight:600;}
.mono{font-family:'JetBrains Mono',monospace;}
.ez-stafflist{display:flex;flex-direction:column;gap:0;}
.ez-userpicklist{display:flex;flex-direction:column;gap:6px;max-width:420px;}
.ez-userpick{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid transparent;border-radius:10px;padding:10px 12px;cursor:pointer;color:var(--cream);text-align:left;font-size:12.5px;}
.ez-userpick.sel{border-color:var(--gold);}
.ez-userpick span{margin-left:auto;color:var(--mist);}
.ez-admin-copy-preview{background:var(--ink);border:1px solid rgba(231,181,75,.2);border-radius:12px;padding:14px;font-family:'JetBrains Mono',monospace;font-size:12px;display:grid;gap:7px;}
.ez-admin-copy-preview strong{color:var(--cream);margin-bottom:4px;}.ez-admin-copy-preview em{color:var(--ruby);font-style:normal;}.ez-admin-copy-preview span{color:var(--gold);}.ez-admin-copy-preview b{color:var(--gold);border-top:1px solid rgba(244,236,216,.1);padding-top:10px;margin-top:3px;}
.ez-admin-control-card,.ez-quick-create-user{max-width:620px;}.ez-admin-control-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;}.ez-admin-entry-actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;}.ez-admin-history{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}.ez-history-batch{margin:0;}.ez-history-head{display:flex;align-items:center;gap:10px;padding-top:2px;}.ez-history-avatar{width:38px;height:38px;border-radius:50%;background:var(--panel2);display:flex;align-items:center;justify-content:center;object-fit:cover;}.ez-history-head>div{display:grid;min-width:0;flex:1;}.ez-history-head strong{font-family:'Fraunces',serif;font-size:15px;}.ez-history-head code{font-size:9px;color:var(--mist);}.ez-history-status{font-size:8px;text-transform:uppercase;border-radius:99px;padding:4px 7px;background:rgba(143,163,155,.15);color:var(--mist);}.ez-history-status.sent{background:rgba(231,181,75,.14);color:var(--gold);}.ez-history-lines{display:grid;gap:0;margin:13px 0 8px;}.ez-history-lines>div{display:flex;align-items:center;justify-content:space-between;border-top:1px solid rgba(244,236,216,.06);padding:7px 0;font-family:'JetBrains Mono',monospace;font-size:11px;}.ez-history-lines button{width:26px;height:26px;border:0;border-radius:7px;background:rgba(225,73,91,.1);color:var(--ruby);display:grid;place-items:center;}.ez-history-total{display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(231,181,75,.2);padding:10px 0 12px;font-size:10px;color:var(--mist);}.ez-history-total strong{font-family:'JetBrains Mono',monospace;color:var(--gold);font-size:14px;}
.ez-admin-member-filter{max-width:420px;margin-bottom:16px;}.ez-history-detail-list{display:grid;gap:12px;}.ez-history-detail-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;}.ez-history-detail-head>div{display:grid;}.ez-history-detail-head strong{font-family:'Fraunces',serif;font-size:16px;}.ez-history-detail-head code{font-size:10px;color:var(--mist);}.ez-history-detail dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0;}.ez-history-detail dl>div{background:var(--panel2);border-radius:8px;padding:9px;display:grid;gap:3px;}.ez-history-detail dt{font-size:9px;color:var(--mist);text-transform:uppercase;letter-spacing:.4px;}.ez-history-detail dd{font-size:11px;margin:0;overflow-wrap:anywhere;}.ez-week-list{display:grid;gap:8px;margin-top:16px;}.ez-week-row{display:flex;align-items:center;gap:10px;}.ez-week-row>div{display:grid;flex:1;}.ez-week-row span{font-size:10px;color:var(--mist);}.ez-dream-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px;}.ez-dream-card{display:flex;align-items:center;gap:12px;}.ez-dream-card>strong{font-family:'JetBrains Mono',monospace;color:var(--gold);font-size:22px;}.ez-dream-card>div{display:grid;flex:1;}.ez-dream-card b{font-size:13px;}.ez-dream-card span{font-size:10px;color:var(--mist);}.ez-draw-admin-status{display:grid;gap:5px;margin-top:14px;}.ez-draw-admin-status strong{font-family:'Fraunces',serif;}.ez-draw-admin-status b{font-family:'JetBrains Mono',monospace;color:var(--gold);}.ez-draw-admin-status small{color:var(--mist);}.ez-result-stats{margin-top:16px;}

.ez-adminlogin{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--ink);}
.ez-adminlogin-card{background:var(--panel);border-radius:18px;padding:30px 26px;width:320px;display:flex;flex-direction:column;gap:12px;}
.ez-adminlogin-mark{display:flex;align-items:center;gap:8px;font-family:'Fraunces',serif;font-size:19px;font-weight:600;}
.ez-adminlogin-card p{color:var(--mist);font-size:11.5px;margin:0;}

/* Responsive layout and profile-based admin entry */
.ez-result-owner{display:block!important;font-family:'Inter','Noto Sans Myanmar',sans-serif!important;font-size:11px!important;margin-bottom:2px;color:var(--cream)!important;}
.ez-result-profile{display:flex;align-items:center;justify-content:center;gap:9px;margin:2px 0 13px;}.ez-result-profile strong{font-family:'Fraunces',serif;font-size:19px;}
.ez-admin{width:100%;min-height:100vh;min-height:100dvh;}
.ez-admin-content{min-width:0;padding:30px clamp(22px,4vw,54px);max-height:100vh;max-height:100dvh;}
.ez-admin-view{width:100%;max-width:1080px;margin:0 auto;}
.ez-name-picker{max-width:620px;}.ez-name-mode{display:grid;grid-template-columns:1fr 1fr;gap:5px;background:var(--ink);padding:4px;border-radius:11px;margin:10px 0 14px;}.ez-name-mode button{border:0;border-radius:8px;padding:10px;background:transparent;color:var(--mist);font-size:12px;font-weight:700;cursor:pointer;}.ez-name-mode button.active{background:var(--gold);color:#221505;}.ez-selected-profile{display:flex;align-items:center;gap:10px;background:var(--panel2);padding:11px 12px;border-radius:11px;}.ez-selected-profile>div{display:grid;gap:1px;}.ez-selected-profile span{font-size:9px;text-transform:uppercase;color:var(--mist);letter-spacing:.5px;}.ez-selected-profile strong{font-family:'Fraunces',serif;font-size:16px;}.ez-selected-profile code{font-size:9px;color:var(--mist);}
.ez-table{max-width:100%;}

@media (min-width:700px){
  .ez-root:not(.ez-root-admin){max-width:820px;}
  .ez-root:not(.ez-root-admin) .ez-main{width:min(760px,calc(100% - 44px));margin:0 auto;padding-left:0;padding-right:0;}
  .ez-root:not(.ez-root-admin) .ez-topbar{padding-left:30px;padding-right:30px;}
  .ez-root:not(.ez-root-admin) .ez-bottomnav{max-width:820px;}
  .ez-root:not(.ez-root-admin) .ez-number-board{grid-template-columns:repeat(15,minmax(0,1fr));max-height:420px;}
  .ez-root:not(.ez-root-admin) .ez-communitygrid{grid-template-columns:repeat(3,minmax(0,1fr));}
  .ez-root:not(.ez-root-admin) .ez-modal{max-width:560px;border-radius:22px;margin:auto;}
}
@media (min-width:1100px){
  .ez-root:not(.ez-root-admin){max-width:1080px;}
  .ez-root:not(.ez-root-admin) .ez-main{width:min(920px,calc(100% - 56px));}
  .ez-root:not(.ez-root-admin) .ez-bottomnav{max-width:1080px;}
  .ez-root:not(.ez-root-admin) .ez-number-board{grid-template-columns:repeat(20,minmax(0,1fr));max-height:470px;}
  .ez-root:not(.ez-root-admin) .ez-communitygrid{grid-template-columns:repeat(4,minmax(0,1fr));}
}
@media (max-width:760px){
  .ez-admin{flex-direction:column;}
  .ez-admin-side{width:100%;height:auto;flex-direction:row;overflow-x:auto;padding:10px;gap:6px;position:sticky;top:0;z-index:30;}
  .ez-admin-brand{display:none;}.ez-admin-navitem{flex-shrink:0;white-space:nowrap;}.ez-admin-logout{margin-top:0;}
  .ez-admin-content{padding:20px 16px 36px;max-height:none;overflow:visible;}
  .ez-admin-history,.ez-dream-grid{grid-template-columns:1fr;}.ez-admin-control-grid{grid-template-columns:1fr;}.ez-history-detail dl{grid-template-columns:1fr;}.ez-idchip-id{display:none;}
  .ez-table{display:block;white-space:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;}
  .ez-statgrid{grid-template-columns:repeat(2,minmax(0,1fr));}
}
@media (max-width:430px){
  .ez-topbar{padding-left:13px;padding-right:13px;}.ez-main{padding-left:13px;padding-right:13px;}.ez-hero-clock{font-size:34px;}.ez-number-board{gap:3px;}.ez-number-cell{height:27px;font-size:8px;}
  .ez-admin-entry-actions{grid-template-columns:1fr;}.ez-admin-entry-actions .ez-btn{min-height:44px;}.ez-name-mode{grid-template-columns:1fr;}.ez-statgrid{grid-template-columns:1fr 1fr;gap:8px;}.ez-admin-titlebar{align-items:flex-start;flex-direction:column;}.ez-admin-titlebar .ez-btn{width:100%;}.ez-resultcard-grid{grid-template-columns:1fr;}.ez-lantern{width:64px;height:84px;}.ez-lanterns{gap:10px;}.ez-cta-signup{align-items:stretch;flex-direction:column;}.ez-cta-signup .ez-btn{width:100%;}
}

@media (max-width:600px){
  .ez-admin{flex-direction:column;}
  .ez-admin-side{width:100%;flex-direction:row;overflow-x:auto;padding:10px;gap:6px;}
  .ez-admin-brand{display:none;}
  .ez-admin-navitem{flex-shrink:0;white-space:nowrap;}
  .ez-admin-logout{margin-top:0;}
  .ez-admin-content{padding:18px;}
  .ez-admin-history,.ez-dream-grid{grid-template-columns:1fr;}.ez-admin-control-grid{grid-template-columns:1fr;}.ez-history-detail dl{grid-template-columns:1fr;}.ez-idchip-id{display:none;}
}
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible{outline:2px solid var(--gold); outline-offset:2px;}
@media (prefers-reduced-motion: reduce){
  .ez-lantern, .ez-resultcard.celebrate, .ez-confetti span{animation:none !important;}
}
`;
