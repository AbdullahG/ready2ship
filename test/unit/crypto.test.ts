import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const KEY = Buffer.alloc(32, 1);
const OTHER_KEY = Buffer.alloc(32, 2);

describe("secret encryption", () => {
  it("roundTripsUnicodeAndLongValues", () => {
    for (const plain of ["AIzaSy-test", "ñé 中文 🚢", "x".repeat(10_000)]) {
      expect(decryptSecret(encryptSecret(plain, KEY), KEY)).toBe(plain);
    }
  });

  it("producesADifferentCiphertextEachTimeAndNeverContainsThePlaintext", () => {
    const a = encryptSecret("same-secret", KEY);
    const b = encryptSecret("same-secret", KEY);
    expect(a.ct).not.toBe(b.ct);
    expect(a.iv).not.toBe(b.iv);
    expect(JSON.stringify(a)).not.toContain("same-secret");
    expect(a.v).toBe(1);
  });

  it("rejectsATamperedCiphertext", () => {
    const enc = encryptSecret("secret", KEY);
    const ct = Buffer.from(enc.ct, "base64");
    ct[0] ^= 0xff;
    expect(() => decryptSecret({ ...enc, ct: ct.toString("base64") }, KEY)).toThrow();
  });

  it("rejectsDecryptionWithTheWrongKey", () => {
    expect(() => decryptSecret(encryptSecret("secret", KEY), OTHER_KEY)).toThrow();
  });

  it("rejectsAnUnknownPayloadVersion", () => {
    const enc = encryptSecret("secret", KEY);
    expect(() => decryptSecret({ ...enc, v: 2 as 1 }, KEY)).toThrow(/version/);
  });
});
