import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

type EncryptedSecret = {
  ciphertext: string;
  encryptedDek: string;
  iv: string;
  authTag: string;
};

function masterKey() {
  const value = process.env.SEAM_MASTER_KEY;
  if (!value) throw new Error("未配置 SEAM_MASTER_KEY");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("SEAM_MASTER_KEY 必须是 32 字节 Base64 密钥");
  return key;
}

function encrypt(value: Buffer, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
}

function decrypt(ciphertext: string, iv: string, authTag: string, key: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
}

export function encryptSecret(secret: string): EncryptedSecret {
  const dek = randomBytes(32);
  const encrypted = encrypt(Buffer.from(secret, "utf8"), dek);
  const wrapped = encrypt(dek, masterKey());
  return { ...encrypted, encryptedDek: JSON.stringify(wrapped) };
}

export function decryptSecret(input: EncryptedSecret): string {
  const wrapped = JSON.parse(input.encryptedDek) as { ciphertext: string; iv: string; authTag: string };
  const dek = decrypt(wrapped.ciphertext, wrapped.iv, wrapped.authTag, masterKey());
  return decrypt(input.ciphertext, input.iv, input.authTag, dek).toString("utf8");
}
