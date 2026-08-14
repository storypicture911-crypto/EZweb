import { describe, expect, it } from "vitest";
import { isValidGeneratedId, normalizeGeneratedId } from "./generated-id";

describe("Generated ID validation", () => {
  it("accepts the existing Admin ID used by activation and PIN login", () => {
    expect(isValidGeneratedId("@pyGQN7O2")).toBe(true);
  });

  it("handles the prefix and surrounding whitespace case-insensitively", () => {
    expect(normalizeGeneratedId("  @PYgqn7o2  ")).toBe("@pygqn7o2");
    expect(isValidGeneratedId("  @PYgqn7o2  ")).toBe(true);
  });

  it.each(["pyGQN7O2", "@pxGQN7O2", "@pyGQN7O", "@pyGQN7O22", "@pyGQ N7O2", "@pyGQN701"]) 
  ("rejects malformed ID %s", (value) => expect(isValidGeneratedId(value)).toBe(false));
});
