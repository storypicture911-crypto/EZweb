import { invoke, isConfigured, supabase } from "../lib/supabase";

export { isConfigured as cloudEnabled };

type SessionPayload = {
  session: { access_token: string; refresh_token: string };
};

export type CloudProfile = {
  id: string;
  generated_name: string;
  nickname: string | null;
  role: "admin" | "staff" | "user";
  avatar_key: string;
  created_at: string;
  recovery_email?: string;
};

export async function getCloudProfile(): Promise<CloudProfile | null> {
  if (!isConfigured) return null;
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user.id) return null;
  const [{ data: profile, error }, { data: privateProfile }] = await Promise.all([
    supabase.from("profiles").select("id,generated_name,nickname,role,avatar_key,created_at").eq("id", session.user.id).single(),
    supabase.from("profile_private").select("recovery_email").eq("user_id", session.user.id).maybeSingle(),
  ]);
  if (error) throw error;
  return { ...(profile as CloudProfile), recovery_email: privateProfile?.recovery_email || "" };
}

export async function loginCloud(generatedName: string, pin: string) {
  const result = await invoke<SessionPayload>("login-ezwin-user", { generated_name: generatedName, pin });
  const { error } = await supabase.auth.setSession(result.session);
  if (error) throw error;
  return getCloudProfile();
}

export async function activateCloud(input: { generatedName: string; activationCode: string; nickname: string; pin: string }) {
  const result = await invoke<SessionPayload>("activate-ezwin-user", {
    generated_name: input.generatedName,
    one_time_code: input.activationCode,
    nickname: input.nickname,
    pin: input.pin,
  });
  const { error } = await supabase.auth.setSession(result.session);
  if (error) throw error;
  return getCloudProfile();
}

export async function registerCloud(input: { nickname: string; recoveryEmail: string; pin: string }) {
  const result = await invoke<SessionPayload & { generated_name: string }>("register-ezwin-user", {
    nickname: input.nickname,
    recovery_email: input.recoveryEmail,
    pin: input.pin,
  });
  const { error } = await supabase.auth.setSession(result.session);
  if (error) throw error;
  return getCloudProfile();
}

export async function updateCloudProfile(nickname: string, avatarKey: string) {
  const { error } = await supabase.rpc("update_my_profile", { p_nickname: nickname, p_avatar_key: avatarKey });
  if (error) throw error;
}

export async function requestCloudRecovery(generatedName: string) {
  return invoke<{ ok: boolean; request_id?: string; masked_email?: string }>("request-password-recovery", { generated_name: generatedName });
}

export async function verifyCloudRecovery(requestId: string, code: string, newPin: string) {
  return invoke<{ ok: boolean }>("verify-password-recovery", { request_id: requestId, code, new_pin: newPin });
}

export const signOutCloud = () => supabase.auth.signOut();
