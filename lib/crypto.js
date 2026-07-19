const crypto = require("crypto");

function getKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret === "change-me-to-a-long-random-string") {
    throw new Error(
      "SESSION_SECRET is not set to a real value. Set a long random string in .env before storing sites."
    );
  }
  // Derive a fixed-length 32-byte key from whatever secret string was provided.
  return crypto.createHash("sha256").update(secret).digest();
}

// Encrypts a UTF-8 string, returns "iv:authTag:ciphertext" all hex-encoded.
function encrypt(plainText) {
  if (plainText === undefined || plainText === null) plainText = "";
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), ciphertext.toString("hex")].join(":");
}

// Reverses encrypt(). Returns "" if the value is empty/missing/unparseable.
function decrypt(payload) {
  if (!payload) return "";
  try {
    const [ivHex, tagHex, dataHex] = String(payload).split(":");
    if (!ivHex || !tagHex || !dataHex) return "";
    const key = getKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
    return plain.toString("utf8");
  } catch (e) {
    return "";
  }
}

module.exports = { encrypt, decrypt };
