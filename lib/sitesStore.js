const fs = require("fs");
const path = require("path");
const { encrypt, decrypt } = require("./crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "sites.json");

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "[]", "utf8");
}

function readRaw() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

function writeRaw(list) {
  ensureFile();
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), "utf8");
}

// Returns sites with passwords decrypted (only for use server-side when connecting,
// or when sending to the already-authenticated owner's browser).
function listSites() {
  return readRaw().map((s) => ({ ...s, password: decrypt(s.password) }));
}

function saveSite(site) {
  const list = readRaw();
  const encrypted = { ...site, password: encrypt(site.password || "") };
  const idx = list.findIndex((s) => s.id === site.id);
  if (idx === -1) list.push(encrypted);
  else list[idx] = encrypted;
  writeRaw(list);
  return { ...encrypted, password: site.password || "" };
}

function deleteSite(id) {
  const list = readRaw().filter((s) => s.id !== id);
  writeRaw(list);
}

module.exports = { listSites, saveSite, deleteSite };
