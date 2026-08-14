import type { EntryStatus } from "../types";
const labels: Record<EntryStatus, string> = { draft: "Draft", pending: "စောင့်ဆိုင်းဆဲ", sent_to_dealer: "ဒိုင်သို့ပို့ပြီး", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled" };
export function StatusPill({ status }: { status: EntryStatus }) { return <span className={`status ${status}`}>{labels[status]}</span>; }
