import { admin, audit, bodyOf, cors, derivePassword, enforceRateLimit, generateName, json, normalizeName, publicClient, validGeneratedName, validPin, weakPin } from "./core.ts";

const validEmail = (value: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()) && String(value).length <= 254;
const maskedEmail = (email: string) => { const [name, domain] = email.split("@"); return `${name.slice(0, Math.min(2, name.length))}***@${domain}`; };

export async function registerUser(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  try {
    const body = await bodyOf(req); if (!body) throw new Error("INVALID");
    const nickname = String(body.nickname || "").trim(); const email = String(body.recovery_email || "").trim().toLowerCase(); const pin = String(body.pin || "");
    if (nickname.length < 1 || nickname.length > 30 || !validEmail(email) || !validPin(pin) || weakPin(pin)) throw new Error("INVALID");
    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    const { count } = await admin.from("profile_private").select("user_id", { count: "exact", head: true }).eq("recovery_email", email).gte("created_at", since);
    if ((count || 0) > 2) throw new Error("RATE_LIMITED");
    let generatedName = "";
    for (let i = 0; i < 10; i++) { const candidate = generateName(); const { data } = await admin.from("profiles").select("id").ilike("generated_name", candidate).maybeSingle(); if (!data) { generatedName = candidate; break; } }
    if (!generatedName) throw new Error("CREATE_FAILED");
    const userId = crypto.randomUUID(); const password = await derivePassword(generatedName, pin);
    const { data: created, error } = await admin.auth.admin.createUser({ id: userId, email, password, email_confirm: true, user_metadata: { ezwin_generated_id: generatedName } });
    if (error || !created.user) throw new Error("CREATE_FAILED");
    try {
      const { error: profileError } = await admin.from("profiles").insert({ id: userId, generated_name: generatedName, nickname, role: "user", avatar_key: "lucky-clover-01", activated_at: new Date().toISOString() }); if (profileError) throw profileError;
      await admin.from("auth_identities").insert({ user_id: userId, internal_email: email });
      await admin.from("profile_private").insert({ user_id: userId, recovery_email: email, recovery_email_verified_at: new Date().toISOString() });
      await admin.from("user_roles").upsert({ user_id: userId, role: "user" }, { onConflict: "user_id" });
      await audit(admin, userId, "SELF_REGISTERED", "profile", userId);
      const { data: signed, error: signError } = await publicClient().auth.signInWithPassword({ email, password }); if (signError || !signed.session) throw signError;
      return json(req, { generated_name: generatedName, session: { access_token: signed.session.access_token, refresh_token: signed.session.refresh_token } });
    } catch (reason) { await admin.auth.admin.deleteUser(userId); throw reason; }
  } catch (error) {
    const status = error instanceof Error && error.message === "RATE_LIMITED" ? 429 : 400;
    return json(req, { error: status === 429 ? "အကောင့်ဖန်တီးမှု များလွန်းပါသည်။ ခဏနားပြီး ပြန်စမ်းပါ။" : "အကောင့်ဖန်တီးမှု မအောင်မြင်ပါ။ Email အသုံးပြုပြီးသား ဖြစ်နိုင်ပါသည်။" }, status);
  }
}

export async function requestRecovery(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  try {
    const body = await bodyOf(req); if (!body) throw new Error("INVALID"); const name = normalizeName(body.generated_name);
    if (!validGeneratedName(name)) throw new Error("INVALID"); await enforceRateLimit(req, name);
    const { data: profile } = await admin.from("profiles").select("id,is_active").ilike("generated_name", name).maybeSingle();
    if (!profile?.is_active) return json(req, { ok: true });
    const since = new Date(Date.now() - 15 * 60_000).toISOString(); const { count } = await admin.from("recovery_codes").select("id", { count: "exact", head: true }).eq("user_id", profile.id).gte("created_at", since);
    if ((count || 0) >= 3) throw new Error("RATE_LIMITED");
    const { data: privateRow } = await admin.from("profile_private").select("recovery_email").eq("user_id", profile.id).single(); if (!privateRow?.recovery_email) return json(req, { ok: true });
    const requestId = crypto.randomUUID(); const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await admin.from("recovery_codes").insert({ id: requestId, user_id: profile.id, expires_at: expiresAt });
    const { error } = await publicClient().auth.signInWithOtp({ email: privateRow.recovery_email, options: { shouldCreateUser: false } }); if (error) throw error;
    return json(req, { ok: true, request_id: requestId, masked_email: maskedEmail(privateRow.recovery_email), expires_at: expiresAt });
  } catch (error) { return json(req, { error: error instanceof Error && error.message === "RATE_LIMITED" ? "ခဏနားပြီး ပြန်စမ်းပါ။" : "Recovery request မအောင်မြင်ပါ။" }, 400); }
}

export async function verifyRecovery(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  try {
    const body = await bodyOf(req); if (!body) throw new Error("INVALID"); const id = String(body.request_id || ""); const token = String(body.code || "").trim(); const pin = String(body.new_pin || "");
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d{6,8}$/.test(token) || !validPin(pin) || weakPin(pin)) throw new Error("INVALID");
    const { data: request } = await admin.from("recovery_codes").select("*").eq("id", id).is("used_at", null).single();
    if (!request || new Date(request.expires_at) <= new Date() || request.failed_attempts >= 5 || request.locked_until && new Date(request.locked_until) > new Date()) throw new Error("INVALID");
    const [{ data: profile }, { data: privateRow }, { data: identity }] = await Promise.all([
      admin.from("profiles").select("generated_name").eq("id", request.user_id).single(), admin.from("profile_private").select("recovery_email").eq("user_id", request.user_id).single(), admin.from("auth_identities").select("pin_version").eq("user_id", request.user_id).single(),
    ]);
    const { error: verifyError } = await publicClient().auth.verifyOtp({ email: privateRow.recovery_email, token, type: "email" });
    if (verifyError) { const attempts = request.failed_attempts + 1; await admin.from("recovery_codes").update({ failed_attempts: attempts, locked_until: attempts >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null }).eq("id", id); throw new Error("INVALID"); }
    const version = Number(identity.pin_version) + 1; const password = await derivePassword(profile.generated_name, pin, version);
    const { error } = await admin.auth.admin.updateUserById(request.user_id, { password }); if (error) throw error;
    await admin.from("auth_identities").update({ pin_version: version, updated_at: new Date().toISOString() }).eq("user_id", request.user_id);
    await admin.from("recovery_codes").update({ used_at: new Date().toISOString() }).eq("id", id).is("used_at", null);
    await audit(admin, request.user_id, "PIN_RECOVERED", "profile", request.user_id); return json(req, { ok: true });
  } catch { return json(req, { error: "Code မမှန်ပါ သို့မဟုတ် သက်တမ်းကုန်သွားပါပြီ။" }, 400); }
}
