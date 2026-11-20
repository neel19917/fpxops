// Encrypts the support-mailbox app's client secret at rest
// (fpx_mailbox_connections.secret_enc).
//
// AES-256-GCM, stored as "v1:<iv b64>:<tag b64>:<ciphertext b64>".
// Key: sha256(MAILBOX_SECRET_KEY) when that env var is set; otherwise
// HKDF-SHA256 of SUPABASE_SERVICE_ROLE_KEY (the key server/lib/supabase.js
// uses) with info "fpx-mailbox-v1". Rotating whichever key is in use makes
// the stored secret unreadable — reconnect the mailbox to save it again.
import crypto from "node:crypto";

const VERSION = "v1";
const HKDF_INFO = "fpx-mailbox-v1";

// Read on every call (not at import) so tests and late-loaded env work.
export function mailboxKey() {
  const explicit = process.env.MAILBOX_SECRET_KEY;
  if (explicit) return crypto.createHash("sha256").update(explicit, "utf8").digest();
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (service) {
    return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(service, "utf8"), Buffer.alloc(0), Buffer.from(HKDF_INFO, "utf8"), 32));
  }
  throw new Error("Mailbox secret encryption key missing: set MAILBOX_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) on the server");
}

export function encryptSecret(plain) {
  if (typeof plain !== "string" || !plain) throw new Error("encryptSecret: secret must be a non-empty string");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", mailboxKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(enc) {
  const parts = typeof enc === "string" ? enc.split(":") : [];
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("decryptSecret: not a v1 encrypted secret");
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", mailboxKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch (e) {
    if (/key missing/.test(e?.message || "")) throw e;
    throw new Error("decryptSecret: the stored mailbox secret could not be decrypted (encryption key changed?) — reconnect the mailbox");
  }
}
