import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";

describe("联调凭据加密", () => {
  it("使用信封加密且密文不包含明文", () => {
    process.env.SEAM_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    const secret = "test-api-token-that-must-not-leak";
    const encrypted = encryptSecret(secret);
    expect(JSON.stringify(encrypted)).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
    expect(encryptSecret(secret).ciphertext).not.toBe(encrypted.ciphertext);
  });
});
