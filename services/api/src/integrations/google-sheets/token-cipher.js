import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

function encryptionKey(value) {
  const key = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "", "base64");
  if (key.length !== 32) {
    throw new Error(
      "Google token encryption key must decode to exactly 32 bytes",
    );
  }
  return key;
}

export function createGoogleTokenCipher({ key }) {
  const resolvedKey = encryptionKey(key);

  return {
    encrypt(value) {
      if (!value) return null;
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, resolvedKey, iv);
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return [
        VERSION,
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
    },

    decrypt(value) {
      if (!value) return null;
      const [version, iv, tag, encrypted] = value.split(".");
      if (version !== VERSION || !iv || !tag || !encrypted) {
        throw new Error("Stored Google token has an unsupported format");
      }
      const decipher = createDecipheriv(
        ALGORITHM,
        resolvedKey,
        Buffer.from(iv, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
