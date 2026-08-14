import { describe, expect, it } from "vitest";
import fs from "node:fs";

const migration=fs.readFileSync("supabase/migrations/20260815_ezwin_v4.sql","utf8");
describe("database security contract",()=>{
  it("enables RLS on every sensitive table",()=>["profiles","auth_identities","activation_codes","lottery_batches","lottery_entries","audit_logs"].forEach((table)=>expect(migration).toContain(`alter table public.${table} enable row level security`)));
  it("prevents normal browser batch mutations",()=>expect(migration).toContain("revoke insert,update,delete on public.audit_logs,public.lottery_batches,public.lottery_entries"));
  it("keeps approval admin-only and transactional",()=>{expect(migration).toContain("role='admin'");expect(migration).toContain("for update");expect(migration).toContain("approve_batch_atomic");});
  it("does not grant activation table access to authenticated users",()=>expect(migration).toContain("revoke all on public.auth_identities,public.activation_codes,public.login_security_events from anon,authenticated"));
  it("enforces masked community snapshots",()=>expect(migration).toContain("mask_generated_name(p.generated_name)"));
  it("keeps backend validation aligned with legacy generated IDs",()=>{
    const core=fs.readFileSync("supabase/functions/_shared/core.ts","utf8");
    expect(core).toContain("a-hj-nop-z2-9");
    expect(core).toContain("normalizeName(value)");
  });
});
