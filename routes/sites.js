const express = require("express");
const crypto = require("crypto");
const store = require("../lib/sitesStore");
const router = express.Router();

router.get("/", (req, res) => {
  try {
    res.json(store.listSites());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", (req, res) => {
  try {
    const body = req.body || {};
    const site = {
      id: body.id || "s" + crypto.randomBytes(8).toString("hex"),
      name: (body.name || "Unnamed site").trim(),
      host: (body.host || "").trim(),
      port: (body.port || "").trim(),
      protocol: body.protocol === "SFTP" ? "SFTP" : "FTP",
      username: (body.username || "").trim(),
      password: body.password || "",
      defaultRemoteDir: (body.defaultRemoteDir || "/").trim() || "/",
      secure: !!body.secure, // FTPS toggle, ignored for SFTP
    };
    const saved = store.saveSite(site);
    res.json(saved);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", (req, res) => {
  try {
    store.deleteSite(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
