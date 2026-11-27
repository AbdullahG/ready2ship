import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { config } from "@/lib/config";

// AES-256-GCM envelope for secrets stored in MongoDB (workspace AI keys, user
// GitHub tokens). `v` identifies the key generation so a future rotation can
// re-encrypt old payloads.
export interface EncryptedSecret {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

export function encryptSecret(plain: string, key: Buffer = config().encryptionKey): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function decryptSecret(secret: EncryptedSecret, key: Buffer = config().encryptionKey): string {
  if (secret.v !== 1) throw new Error(`Unsupported secret version: ${secret.v}`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv, "base64"));
  decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ct, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
