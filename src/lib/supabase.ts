import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

export const isConfigured = Boolean(url && key && !url.includes("YOUR_PROJECT"));
export const supabase = createClient(
  url || "https://placeholder.supabase.co",
  key || "placeholder-public-key",
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

export async function invoke<T>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!isConfigured) throw new Error("SUPABASE_NOT_CONFIGURED");
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let message = error.message || "တစ်ခုခု မှားယွင်းနေပါသည်။";
    try {
      const payload = await (error as unknown as { context?: Response }).context?.clone().json() as { error?: string } | undefined;
      if (payload?.error) message = payload.error;
    } catch {
      // The response body is optional; retain the safe transport message.
    }
    throw new Error(message);
  }
  return data as T;
}

export function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "SUPABASE_NOT_CONFIGURED") return "Supabase ချိတ်ဆက်မှု မသတ်မှတ်ရသေးပါ။";
  return message.includes("FunctionsHttpError") ? "လုပ်ဆောင်မှု မအောင်မြင်ပါ။ နောက်တစ်ကြိမ် စမ်းပါ။" : (message || "တစ်ခုခု မှားယွင်းနေပါသည်။");
}
