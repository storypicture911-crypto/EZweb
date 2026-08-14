export type MatchType = "exact" | "twd" | "korea-miss" | "none";
export interface ParsedLine { number: string; amount: number; reverse?: boolean; reverseAmount?: number }

const countDigits = (value: string) => [...value].reduce<Record<string, number>>((map, digit) => {
  map[digit] = (map[digit] || 0) + 1; return map;
}, {});

export function classifyLotteryNumber(entry: string, result: string): MatchType {
  if (!/^\d{3}$/.test(entry) || !/^\d{3}$/.test(result)) throw new Error("Numbers must contain exactly three digits");
  if (entry === result) return "exact";
  const a = countDigits(entry); const b = countDigits(result);
  if (Object.keys({ ...a, ...b }).every((digit) => a[digit] === b[digit])) return "twd";
  const matches = [...entry].reduce((total, digit, index) => total + (digit === result[index] ? 1 : 0), 0);
  return matches === 2 ? "korea-miss" : "none";
}

export function parseEntryLine(raw: string): ParsedLine {
  const line = raw.trim().replace(/,/g, "");
  const before = line.match(/^(\d{3})(R)?-(\d+(?:\.\d+)?)$/i);
  const after = line.match(/^(\d{3})-(\d+(?:\.\d+)?)(?:R(\d+(?:\.\d+)?))?$/i);
  const match = before || after;
  if (!match) throw new Error(`“${raw}” ပုံစံ မမှန်ပါ။ ဥပမာ 455-2000`);
  const amount = Number(match[3] || match[2]);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount သည် 0 ထက်ကြီးရပါမည်။");
  return { number: match[1], amount, reverse: Boolean(before?.[2] || after?.[3]), reverseAmount: after?.[3] ? Number(after[3]) : undefined };
}

export function parseEntryText(value: string) {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("ဂဏန်းအနည်းဆုံး တစ်ကြောင်း ထည့်ပါ။");
  return lines.map(parseEntryLine);
}

export function luckyNumberToday(date = new Date()) {
  const key = Number(`${date.getFullYear()}${date.getMonth() + 1}${date.getDate()}`);
  return String((key * 9301 + 49297) % 1000).padStart(3, "0");
}

export function maskGeneratedName(value: string) {
  return value.length <= 6 ? `${value.slice(0, 3)}***` : `${value.slice(0, 4)}***${value.slice(-2)}`;
}
