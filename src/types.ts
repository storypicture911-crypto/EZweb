export type AppRole = "admin" | "staff" | "user";
export type EntryStatus = "draft" | "pending" | "sent_to_dealer" | "approved" | "rejected" | "cancelled";

export interface Profile {
  id: string;
  generated_name: string;
  masked_generated_name?: string;
  nickname: string | null;
  role: AppRole;
  avatar_key: string;
  is_active: boolean;
  created_at: string;
}

export interface LotteryWeek { id: string; title: string; draw_date: string | null; is_current: boolean; is_open: boolean }
export interface LotteryEntry { id: string; number: string; amount: number; is_closed: boolean }
export interface LotteryBatch {
  id: string; week_id: string; user_id: string; sequence_no: number | null; status: EntryStatus;
  total_amount: number; dealer_confirmed_at: string | null; approved_at: string | null;
  lottery_weeks?: LotteryWeek; lottery_entries?: LotteryEntry[]; profiles?: Profile;
}
export interface Activity {
  id: string; nickname_snapshot: string | null; masked_id_snapshot: string | null;
  avatar_key_snapshot: string | null; activity_type: string; safe_payload: Record<string, string>;
  created_at: string; community_reactions?: { reaction: string }[];
}
export interface DreamItem {
  id: string; title_mm: string; title_en: string | null; keywords: string[];
  numbers: string[]; emoji: string | null; short_description: string | null; category: string | null;
}
