import { describe, expect, it } from "vitest";
import { safeReturnTo } from "@/lib/auth/return-to";

describe("safeReturnTo", () => {
  it("keepsRelativePathsWithQuery", () => {
    expect(safeReturnTo("/api/github/setup?installation_id=1")).toBe("/api/github/setup?installation_id=1");
  });

  it.each([null, "", "https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"])(
    "fallsBackToRootFor %j",
    (v) => expect(safeReturnTo(v)).toBe("/")
  );
});
