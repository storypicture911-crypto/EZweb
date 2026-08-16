import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
export const PIN_PEPPER = Deno.env.get("PIN_PEPPER")!;
export const INTERNAL_SECRET = Deno.env.get("APP_INTERNAL_SECRET")!;
const allowedOrigins = (Deno.env.get("APP_ALLOWED_ORIGINS") || "").split(",").map((v) => v.trim()).filter(Boolean);

export const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
export const publicClient = () => createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

export function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  const permitted = !allowedOrigins.length || allowedOrigins.includes(origin) ? origin || "*" : allowedOrigins[0];
  return { "Access-Control-Allow-Origin": permitted, "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}
export const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors(req), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
export const genericAuthError = (req: Request, status = 401) => json(req, { error: "ID သို့မဟုတ် PIN မမှန်ပါ။" }, status);

export async function bodyOf(req: Request) {
  if (req.method === "OPTIONS") return null;
  if (req.method !== "POST" || !(req.headers.get("content-type") || "").includes("application/json")) throw new Error("INVALID_REQUEST");
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > 16_384) throw new Error("INVALID_REQUEST");
  return await req.json() as Record<string, unknown>;
}
export const normalizeName = (value: unknown) => String(value || "").trim().toLowerCase();
// Historical managed accounts may contain `O`; retain login access for them
// while generateName() continues to exclude confusing characters for new IDs.
export const validGeneratedName = (value: string) => /^@py[a-hj-nop-z2-9]{6}$/.test(normalizeName(value));
export const validPin = (value: unknown) => /^\d{4}$/.test(String(value || ""));
export const weakPin = (pin: string) => new Set(["0000","1111","2222","3333","4444","5555","6666","7777","8888","9999","1234","4321"]).has(pin);

const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2,"0")).join("");
export async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
export const hashSecurityValue = (value: string) => hmac(value, INTERNAL_SECRET);
export const derivePassword = async (generatedName: string, pin: string, version = 0) => `EzW!${await hmac(`${normalizeName(generatedName)}:${pin}:${version}`, PIN_PEPPER)}`;

const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function randomChars(length: number) {
  const bytes = new Uint8Array(length * 2); crypto.getRandomValues(bytes); let result = "";
  for (const byte of bytes) { if (byte < 224) result += alphabet[byte % alphabet.length]; if (result.length === length) break; }
  return result.length === length ? result : randomChars(length);
}
export const generateName = () => `@py${randomChars(6)}`;
export const generateCode = () => `${randomChars(4)}-${randomChars(4)}`;
export const internalEmail = (userId: string) => `${userId.replaceAll("-","")}@users.ezwin.invalid`;

export async function getActor(req: Request, roles: ("admin"|"staff"|"user")[] = ["admin","staff","user"]) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("UNAUTHORIZED");
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) throw new Error("UNAUTHORIZED");
  const { data: profile } = await admin.from("profiles").select("id,role,is_active,generated_name").eq("id",user.id).single();
  if (!profile?.is_active || !roles.includes(profile.role)) throw new Error("FORBIDDEN");
  return profile as { id:string; role:"admin"|"staff"|"user"; is_active:boolean; generated_name:string };
}
export async function audit(client: SupabaseClient, actorId: string | null, action: string, entityType?: string, entityId?: string, metadata: Record<string, unknown> = {}) {
  const safe = { ...metadata }; for (const key of ["pin","password","activation_code","code_hash","internal_email","pepper"]) delete safe[key];
  await client.from("audit_logs").insert({ actor_id: actorId, action, entity_type: entityType, entity_id: entityId, metadata: safe });
}
export async function securityHashes(req: Request, generatedName: string) {
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown").split(",")[0].trim();
  return { accountHash: await hashSecurityValue(normalizeName(generatedName)), ipHash: await hashSecurityValue(ip) };
}
export async function enforceRateLimit(req: Request, generatedName: string) {
  const { accountHash, ipHash } = await securityHashes(req, generatedName); const since = new Date(Date.now()-15*60_000).toISOString();
  const [{ count: accountFails }, { count: ipFails }] = await Promise.all([
    admin.from("login_security_events").select("id",{count:"exact",head:true}).eq("generated_name_hash",accountHash).in("event_type",["LOGIN_FAILED","ACTIVATION_FAILED"]).gte("created_at",since),
    admin.from("login_security_events").select("id",{count:"exact",head:true}).eq("ip_hash",ipHash).in("event_type",["LOGIN_FAILED","ACTIVATION_FAILED"]).gte("created_at",since),
  ]);
  if ((accountFails||0)>=5 || (ipFails||0)>=20) throw new Error("RATE_LIMITED");
  return { accountHash, ipHash };
}
export async function recordSecurity(accountHash:string,ipHash:string,eventType:string){ await admin.from("login_security_events").insert({generated_name_hash:accountHash,ip_hash:ipHash,event_type:eventType}); }

export async function edgeHandler(req: Request, operation: (body: Record<string, unknown>) => Promise<unknown>, roles: ("admin"|"staff"|"user")[]) {
  if (req.method === "OPTIONS") return new Response(null,{status:204,headers:cors(req)});
  try { const body = await bodyOf(req); if (!body) return json(req,{}); const actor = await getActor(req,roles); return json(req,await operation({...body,__actor:actor})); }
  catch(error){
    const code=error instanceof Error?error.message:"ERROR";
    const duplicate=code.match(/^DUPLICATE_SERIAL:(\d+)$/);
    const status=code==="UNAUTHORIZED"?401:code==="FORBIDDEN"||code==="Forbidden"?403:code==="TRANSACTION_NOT_FOUND"?404:code==="DUPLICATE_SERIAL"||duplicate?409:400;
    const message=duplicate
      ? `အမှတ်စဉ် (${duplicate[1]}) ရှိပြီးသားဖြစ်ပါသည်။ အခြားအမှတ်စဉ်တစ်ခုရွေးပါ။`
      : status===403?"ခွင့်ပြုချက်မရှိပါ။"
      : code==="TRANSACTION_NOT_FOUND"?"Transaction မတွေ့ပါ။"
      : code==="INVALID_SERIAL"?"အမှတ်စဉ်ကို မှန်ကန်စွာထည့်ပါ။"
      : "လုပ်ဆောင်မှု မအောင်မြင်ပါ။";
    return json(req,{error:message},status);
  }
}
