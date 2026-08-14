import { describe, expect, it } from "vitest";
import { classifyLotteryNumber, luckyNumberToday, maskGeneratedName, parseEntryLine, parseEntryText } from "./lottery";

describe("lottery result classification", () => {
  it.each([
    ["312","312","exact"], ["123","312","twd"], ["121","211","twd"],
    ["000","000","exact"], ["999","999","exact"], ["311","312","korea-miss"], ["912","312","korea-miss"], ["456","312","none"],
  ])("classifies %s against %s as %s", (entry,result,type) => expect(classifyLotteryNumber(entry,result)).toBe(type));
  it("does not misclassify repeated digits as a permutation", () => expect(classifyLotteryNumber("112","122")).toBe("korea-miss"));
});

describe("entry parsing", () => {
  it.each(["000-100","001-200","100-300","312-400","999-500"])("supports boundary number %s", (line) => expect(parseEntryLine(line).number).toHaveLength(3));
  it("supports legacy reverse formats", () => { expect(parseEntryLine("145R-5000").reverse).toBe(true); expect(parseEntryLine("145-5000R500").reverseAmount).toBe(500); });
  it("parses a multiline batch and total inputs", () => expect(parseEntryText("455-2000\n555-2000\n422-500")).toHaveLength(3));
  it.each(["12-100","1000-100","123-0","abc-100"])("rejects invalid line %s", (line) => expect(() => parseEntryLine(line)).toThrow());
});

describe("privacy and entertainment helpers", () => {
  it("masks the public generated id", () => expect(maskGeneratedName("@py7K9M2Q")).toBe("@py7***2Q"));
  it("returns a stable three-digit daily number", () => { const date=new Date("2026-08-15T00:00:00Z"); expect(luckyNumberToday(date)).toBe(luckyNumberToday(date)); expect(luckyNumberToday(date)).toMatch(/^\d{3}$/); });
});
