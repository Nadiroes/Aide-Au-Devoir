// AES-256-GCM secret box for API keys.
// Master key: env MASTER_KEY, or auto-generated and persisted in db/master.key.

import crypto from "crypto";
import fs from "fs";
import path from "path";

const MASTER_KEY_FILE = path.join(process.cwd(), "db", "master.key");

function loadMasterKey(): Buffer {
  const fromEnv = process.env.MASTER_KEY;
  if (fromEnv && fromEnv.length >= 16) {
    return crypto.createHash("sha256").update(fromEnv).digest();
  }
  try {
    const stored = fs.readFileSync(MASTER_KEY_FILE, "utf8").trim();
    if (stored) return Buffer.from(stored, "base64");
  } catch {
    // not stored yet
  }
  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(MASTER_KEY_FILE), { recursive: true });
  fs.writeFileSync(MASTER_KEY_FILE, fresh.toString("base64"), { mode: 0o600 });
  return fresh;
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadMasterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(token: string): string {
  const raw = Buffer.from(token, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", loadMasterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function mask(key: string): string {
  const k = key.trim();
  if (k.length <= 10) return k.slice(0, 2) + "••••";
  return `${k.slice(0, 5)}…${k.slice(-4)}`;
}

export const secretbox = { encrypt, decrypt, mask };
