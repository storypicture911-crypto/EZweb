import { invoke, isConfigured, supabase } from "../lib/supabase";

const avatarEmoji = (key?: string | null) => {
  const map: Record<string, string> = {
    "cat-01": "🐯", "panda-03": "🐼", "fox-02": "🦊", "car-01": "🚗",
    "sports-car-02": "🏎️", "supercar-05": "🏁", "motorbike-01": "🏍️",
    "scooter-02": "🛵", "male-04": "👨", "female-08": "👩", "cartoon-11": "🧚",
    "robot-03": "🤖", "gaming-01": "🎮", "space-02": "🚀", "lucky-clover-01": "🍀",
    "moon-02": "🌙", "flower-03": "🌸", "wizard-01": "🧙", "dragon-02": "🐉", "food-01": "🍜",
  };
  return map[key || ""] || "🍀";
};

const dateParts = (value?: string | null) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return { date: "", time: "15:30" };
  return {
    date: date.toISOString().slice(0, 10),
    time: date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Yangon" }),
  };
};

const numberPermutations = (number: string) => {
  const output = new Set<string>();
  const walk = (rest: string[], built: string) => {
    if (!rest.length) return void output.add(built);
    rest.forEach((digit, index) => walk([...rest.slice(0, index), ...rest.slice(index + 1)], built + digit));
  };
  walk(number.split(""), "");
  return [...output];
};

const must = (error: { message?: string } | null) => {
  if (error) throw new Error(error.message || "Supabase query failed");
};

export async function loadProductionData(currentProfile?: { role?: string; userId?: string } | null) {
  if (!isConfigured) throw new Error("Production Supabase is not configured");
  const privileged = currentProfile?.role === "admin" || currentProfile?.role === "staff";
  const profileQuery = currentProfile
    ? privileged
      ? supabase.from("profiles").select("id,generated_name,nickname,role,avatar_key,is_active,created_at").order("created_at")
      : supabase.from("profiles").select("id,generated_name,nickname,role,avatar_key,is_active,created_at").eq("id", currentProfile.userId || "")
    : Promise.resolve({ data: [], error: null });

  const entryQuery = currentProfile
    ? supabase.from("lottery_entries").select("id,batch_id,week_id,user_id,number,amount,is_closed,has_r,created_at,lottery_batches(sequence_no,status,dealer_confirmed_at,created_at),profiles(nickname,generated_name,avatar_key),lottery_weeks(title,draw_date,is_current,is_open)").order("created_at")
    : Promise.resolve({ data: [], error: null });

  const closedQuery = privileged
    ? supabase.from("closed_numbers").select("id,week_id,number,reason,created_at")
    : Promise.resolve({ data: [], error: null });
  const auditQuery = currentProfile?.role === "admin"
    ? supabase.from("audit_logs").select("id,action,entity_type,entity_id,metadata,actor_id,created_at").order("created_at", { ascending: false }).limit(200)
    : Promise.resolve({ data: [], error: null });

  const [profiles, weeks, entries, results, community, board, closed, dream, audit] = await Promise.all([
    profileQuery,
    supabase.from("lottery_weeks").select("id,title,draw_date,is_current,is_open,draft_result,created_at").order("draw_date", { ascending: false }),
    entryQuery,
    supabase.from("lottery_results").select("id,week_id,result_number,published_by,published_at,lottery_weeks(title,draw_date)").order("published_at", { ascending: false }),
    supabase.rpc("get_community_profiles"),
    supabase.rpc("get_current_number_board"),
    closedQuery,
    supabase.from("dream100_items").select("id,title_mm,title_en,numbers,emoji,short_description,category,is_active").eq("is_active", true).order("created_at"),
    auditQuery,
  ]);
  [profiles, weeks, entries, results, community, board, closed, dream, audit].forEach((result) => must(result.error));

  const appWeeks = (weeks.data || []).map((row: any) => {
    const parts = dateParts(row.draw_date);
    return { id: row.id, title: row.title, date: parts.date, time: parts.time, status: row.is_current ? "current" : row.is_open ? "open" : "closed", isOpen: row.is_open, draft: row.draft_result || null };
  });
  const weekById = new Map(appWeeks.map((week: any) => [week.id, week]));
  const users = (profiles.data || []).map((row: any) => ({
    id: row.generated_name,
    userId: row.id,
    nickname: row.nickname || "No nickname",
    avatar: avatarEmoji(row.avatar_key),
    avatarKey: row.avatar_key,
    joined: String(row.created_at).slice(0, 10),
    role: row.role,
    status: row.is_active ? "Active" : "Inactive",
    isActive: row.is_active,
  }));
  const appEntries = (entries.data || []).map((row: any) => {
    const batch = Array.isArray(row.lottery_batches) ? row.lottery_batches[0] : row.lottery_batches;
    const owner = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    const week = Array.isArray(row.lottery_weeks) ? row.lottery_weeks[0] : row.lottery_weeks;
    return {
      id: row.id,
      batchId: row.batch_id,
      weekId: row.week_id,
      ownerUserId: row.user_id,
      ownerId: owner?.generated_name || "",
      ownerName: owner?.nickname || "EZWin Member",
      ownerAvatar: avatarEmoji(owner?.avatar_key),
      number: row.number,
      amount: Number(row.amount),
      hasR: Boolean(row.has_r),
      drawDate: dateParts(week?.draw_date).date,
      viaAdmin: privileged,
      sequenceNo: batch?.sequence_no,
      workflowStatus: batch?.status || "pending",
      dealerConfirmedAt: batch?.dealer_confirmed_at,
      createdAt: row.created_at,
      source: privileged ? "admin" : "self",
    };
  });
  const previousResults = (results.data || []).map((row: any) => {
    const week = Array.isArray(row.lottery_weeks) ? row.lottery_weeks[0] : row.lottery_weeks;
    const parts = dateParts(week?.draw_date);
    const d = parts.date ? new Date(`${parts.date}T00:00:00Z`) : new Date(row.published_at);
    return { id: row.id, weekId: row.week_id, weekTitle: week?.title || "Lottery draw", date: parts.date || String(row.published_at).slice(0, 10), drawTime: parts.time, number: row.result_number, publishedAt: row.published_at, publishedBy: row.published_by, month: d.toLocaleString("en-US", { month: "long" }), year: d.getUTCFullYear(), note: "" };
  });
  const currentWeek = appWeeks.find((week: any) => week.status === "current") || appWeeks[0];
  const currentResult = previousResults.find((result: any) => result.weekId === currentWeek?.id) || previousResults[0];
  const drawRecord = currentWeek ? {
    draft: currentWeek.draft || currentResult?.number || null,
    published: currentResult?.number || null,
    date: currentWeek.date || currentResult?.date || null,
    weekId: currentWeek.id,
    weekTitle: currentWeek.title,
    publishedAt: currentResult?.publishedAt,
    publishedBy: currentResult?.publishedBy,
  } : { draft: null, published: null, date: null };
  const communityProfiles = (community.data || []).map((row: any) => ({
    id: row.masked_id || row.profile_id,
    userId: row.profile_id,
    nickname: row.nickname || "EZWin Member",
    avatar: avatarEmoji(row.avatar_key),
    joined: String(row.joined_at).slice(0, 10),
    entries: [],
    wins: [],
    activeEntryCount: Number(row.active_entry_count || 0),
    winCount: Number(row.win_count || 0),
  }));
  const closedNumbers = (closed.data || []).filter((row: any) => !currentWeek || row.week_id === currentWeek.id).map((row: any) => row.number);
  const publicClosedNumbers = (board.data || []).filter((row: any) => row.is_closed).map((row: any) => row.number);
  const occupiedNumbers = [...new Set((board.data || []).filter((row: any) => Number(row.entry_count) > 0).flatMap((row: any) => row.has_r ? numberPermutations(row.number) : [row.number]))];
  const dream100 = (dream.data || []).flatMap((row: any) => (row.numbers || []).map((number: string) => ({ id: row.id, number: String(number).padStart(3, "0"), label: row.title_mm || row.title_en || "အိပ်မက်", meaning: row.short_description || "" })));
  const auditLogs = (audit.data || []).map((row: any) => ({ id: String(row.id), action: row.action, detail: row.entity_type || row.entity_id || "", actor: row.actor_id || "system", createdAt: row.created_at }));

  return { users, staff: users.filter((user: any) => user.role === "staff"), entries: appEntries, weeks: appWeeks, previousResults, drawRecord, communityProfiles, closedNumbers: privileged ? closedNumbers : publicClosedNumbers, occupiedNumbers, dream100, auditLogs };
}

export const createManagedCloudUser = (nickname: string) => invoke<{ generated_name: string; one_time_code: string; expires_at: string }>("create-ezwin-user", { nickname: nickname.trim() || null });

export async function saveCloudBatch(input: { batchId?: string | null; weekId: string; userId: string; entries: Array<{ number: string; amount: number; hasR?: boolean }> }) {
  return invoke<{ batch: { id: string } }>(input.batchId ? "update-lottery-batch" : "create-lottery-batch", { batch_id: input.batchId || null, week_id: input.weekId, user_id: input.userId, entries: input.entries });
}

export const confirmCloudDealer = (batchId: string) => invoke("submit-to-dealer", { batch_id: batchId });
export const publishCloudResult = (weekId: string, resultNumber: string) => invoke("publish-result", { week_id: weekId, result_number: resultNumber });
export const saveCloudResultDraft = (weekId: string, resultNumber: string) => invoke("save-result-draft", { week_id: weekId, result_number: resultNumber });
export const manageCloudClosedNumber = (weekId: string, number: string, action: "close" | "reopen") => invoke("manage-closed-number", { week_id: weekId, number, action });
export const createCloudWeek = (title: string, drawDate: string, isCurrent = true) => invoke("manage-lottery-week", { action: "create", title, draw_date: drawDate, is_current: isCurrent });
export const updateCloudWeek = (id: string, input: { title: string; drawDate?: string; isOpen?: boolean; isCurrent?: boolean }) => invoke("manage-lottery-week", { action: "update", id, title: input.title, draw_date: input.drawDate || null, is_open: input.isOpen ?? true, is_current: input.isCurrent ?? false });
export const manageCloudDream = (action: "save" | "delete", input: Record<string, unknown>) => invoke("manage-dream100", { action, ...input });
export const manageCloudUser = (userId: string, action: string, role?: string) => invoke("manage-user", { user_id: userId, action, role });
export const deleteCloudEntry = (entryId: string) => invoke("manage-lottery-entry", { action: "delete", entry_id: entryId });

export function productionSupabaseHost() {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  if (!url) return "not configured";
  try { return new URL(url).host; } catch { return "invalid URL"; }
}

if (import.meta.env.DEV) {
  console.info(`[EZWin] Supabase project: ${productionSupabaseHost()} · mock data: disabled`);
}
