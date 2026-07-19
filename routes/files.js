const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const multer = require("multer");
const archiver = require("archiver");
const { PassThrough } = require("stream");

const cm = require("../lib/connectionManager");
const sitesStore = require("../lib/sitesStore");
const { joinPath } = require("../lib/ftpAdapter");
const progress = require("../lib/progressManager");
const { countingStream } = require("../lib/progressStream");

const router = express.Router();
const upload = multer({ dest: path.join(os.tmpdir(), "webfm-uploads") });

function sid(req) {
  return req.sessionID;
}

function parentPath(remotePath) {
  const parts = String(remotePath || "/").split("/").filter(Boolean);
  parts.pop();
  return parts.length ? "/" + parts.join("/") : "/";
}

// Filesystem/header-safe filename component: strips path separators and
// characters Windows/most filesystems reject, collapses whitespace.
function sanitizeFilenamePart(s) {
  const cleaned = String(s || "")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "download";
}

function timestampTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes());
}

// Decides what to call the downloaded ZIP:
//  - a single selected folder or file -> named after that item
//  - multiple items sharing one parent folder -> named after that folder,
//    tagged with the item count so it's clear it's a partial selection
//  - multiple items from different folders -> a generic but still
//    descriptive "files-N-items-<timestamp>" name
function buildZipFilename(items) {
  if (items.length === 1) {
    const base = sanitizeFilenamePart(items[0].name || (items[0].path || "").split("/").filter(Boolean).pop());
    return base.replace(/\.zip$/i, "") + ".zip";
  }
  const parents = items.map((it) => parentPath(it.path));
  const commonParent = parents.every((p) => p === parents[0]) ? parents[0] : null;
  const parentName =
    commonParent && commonParent !== "/" ? sanitizeFilenamePart(commonParent.split("/").filter(Boolean).pop()) : "files";
  return parentName + "-" + items.length + "-items-" + timestampTag() + ".zip";
}


/* ---------- verified ZIP staging area ----------
   ZIPs are built to a temp file on disk (not streamed straight to the
   client) so the archive can be fully written and verified BEFORE anyone
   is allowed to download it. Once verified, the file + its summary are
   held here under a token (the opId) until the client fetches it via
   GET /download-zip/file/:token, or ZIP_RETENTION_MS elapses, whichever
   comes first — either way the temp file is removed afterward. */
const zipStore = new Map(); // token -> { zipPath, size, createdAt, summary, cleanupTimer }
const ZIP_RETENTION_MS = 10 * 60 * 1000;

function scheduleZipCleanup(token) {
  const entry = zipStore.get(token);
  if (!entry) return;
  clearTimeout(entry.cleanupTimer);
  entry.cleanupTimer = setTimeout(() => {
    const e = zipStore.get(token);
    if (e) {
      fs.unlink(e.zipPath, () => {});
      zipStore.delete(token);
    }
  }, ZIP_RETENTION_MS);
  entry.cleanupTimer.unref?.();
}

function discardZip(token) {
  const entry = zipStore.get(token);
  if (!entry) return;
  clearTimeout(entry.cleanupTimer);
  fs.unlink(entry.zipPath, () => {});
  zipStore.delete(token);
}

function newZipToken() {
  return require("crypto").randomBytes(16).toString("hex");
}

// Reads the End Of Central Directory record to get the number of entries
// the zip's own index says it contains. Used as a second, independent
// check (beyond "did the write stream close cleanly") that the archive on
// disk is actually intact — a truncated/corrupt zip won't have a readable
// EOCD record, or its count won't match what we attempted to add.
function readZipEntryCount(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const maxCommentLen = 65535;
    const readLen = Math.min(size, 22 + maxCommentLen);
    if (readLen < 22) return null;
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        return buf.readUInt16LE(i + 10); // total entries in central directory
      }
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/* ---------- connect / disconnect / status ---------- */

router.post("/connect", async (req, res) => {
  try {
    const body = req.body || {};
    let config;
    if (body.siteId) {
      const site = sitesStore.listSites().find((s) => s.id === body.siteId);
      if (!site) return res.status(404).json({ error: "Saved site not found." });
      config = site;
    } else {
      config = body;
    }
    if (!config.host || !config.username) {
      return res.status(400).json({ error: "Host and username are required." });
    }
    const session = await cm.connect(sid(req), {
      host: config.host,
      port: config.port,
      protocol: config.protocol === "SFTP" ? "SFTP" : "FTP",
      username: config.username,
      password: config.password,
      secure: config.secure,
      siteName: config.name,
    });
    res.json({
      ok: true,
      protocol: session.protocol,
      host: session.host,
      siteName: session.siteName,
      startDir: config.defaultRemoteDir || "/",
    });
  } catch (e) {
    res.status(502).json({ error: "Could not connect: " + e.message });
  }
});

router.post("/disconnect", async (req, res) => {
  await cm.disconnect(sid(req));
  res.json({ ok: true });
});

router.get("/status", (req, res) => {
  const s = cm.getSession(sid(req));
  if (!s) return res.json({ connected: false });
  res.json({ connected: true, protocol: s.protocol, host: s.host, siteName: s.siteName });
});

/* ---------- progress (SSE) ----------
   Any long-running operation below (upload, download, zip, chmod) accepts
   an opId supplied by the client as a query/body param. The client opens
   this stream for that opId to receive live updates: percent, current
   file, processed/total counts, byte counts, ETA, and a final done/error
   status. Kept intentionally protocol-simple (SSE, not WebSocket) since
   it's one-way and Express + a stock nginx/Caddy reverse proxy handle it
   with zero extra setup. */
router.get("/progress/:opId", (req, res) => {
  const { opId } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx proxy buffering
  res.flushHeaders?.();

  const send = (state) => {
    res.write("data: " + JSON.stringify(state) + "\n\n");
  };

  const existing = progress.get(opId);
  send(existing || { opId, status: "pending", phase: "waiting", percent: 0 });

  const unsubscribe = progress.subscribe(opId, send);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/* ---------- listing ---------- */

router.get("/list", async (req, res) => {
  try {
    const adapter = cm.requireAdapter(sid(req));
    const remotePath = req.query.path || "/";
    const entries = await adapter.list(remotePath);
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: remotePath, entries });
  } catch (e) {
    res.status(e.code === "NOT_CONNECTED" ? 409 : 502).json({ error: e.message });
  }
});

/* ---------- mkdir ---------- */

router.post("/mkdir", async (req, res) => {
  try {
    const adapter = cm.requireAdapter(sid(req));
    const { dirPath, name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "Folder name is required." });
    const full = joinPath(dirPath || "/", name.trim());
    await adapter.mkdir(full);
    res.json({ ok: true, path: full });
  } catch (e) {
    res.status(e.code === "NOT_CONNECTED" ? 409 : 502).json({ error: e.message });
  }
});

/* ---------- rename / move ---------- */

router.post("/rename", async (req, res) => {
  try {
    const adapter = cm.requireAdapter(sid(req));
    const { fromPath, toPath } = req.body || {};
    if (!fromPath || !toPath) return res.status(400).json({ error: "fromPath and toPath are required." });
    await adapter.rename(fromPath, toPath);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.code === "NOT_CONNECTED" ? 409 : 502).json({ error: e.message });
  }
});

/* ---------- delete ---------- */

router.post("/delete", async (req, res) => {
  const opId = (req.body && req.body.opId) || null;
  const items = (req.body && req.body.items) || [];
  if (opId) {
    progress.create(opId, { label: "Deleting", kind: "delete", phase: "deleting", total: items.length, processed: 0 });
  }
  try {
    const adapter = cm.requireAdapter(sid(req));
    const results = [];
    let processed = 0;
    for (const item of items) {
      if (opId) progress.update(opId, { currentFile: item.path, processed });
      try {
        if (item.type === "folder") await adapter.deleteDir(item.path);
        else await adapter.deleteFile(item.path);
        results.push({ path: item.path, ok: true });
      } catch (e) {
        results.push({ path: item.path, ok: false, error: e.message });
      }
      processed++;
      if (opId) progress.update(opId, { processed });
    }
    const failCount = results.filter((r) => !r.ok).length;
    if (opId) {
      progress.finish(opId, {
        label: failCount
          ? "Deleted " + (results.length - failCount) + " of " + results.length + " item(s), " + failCount + " error(s)"
          : "Deleted " + results.length + " item(s)",
      });
    }
    res.json({ results });
  } catch (e) {
    if (opId) progress.fail(opId, e.message);
    res.status(e.code === "NOT_CONNECTED" ? 409 : 502).json({ error: e.message });
  }
});

/* ---------- chmod (with optional recursion) ---------- */

// Walks the tree under rootPath and appends every descendant via addTarget
// (which also de-dupes). Listing failures on a subfolder are recorded in
// listErrors and DO NOT abort the rest of the walk — a single unreadable
// directory must never cause siblings, or items already found elsewhere,
// to be skipped or mislabeled.
async function collectRecursive(adapter, rootPath, addTarget, listErrors) {
  let entries;
  try {
    entries = await adapter.list(rootPath);
  } catch (e) {
    listErrors.push({ path: rootPath, ok: false, error: "Could not list contents: " + e.message });
    return;
  }
  for (const e of entries) {
    const full = joinPath(rootPath, e.name);
    addTarget(full, e.type);
    if (e.type === "folder") {
      await collectRecursive(adapter, full, addTarget, listErrors);
    }
  }
}

router.post("/chmod", async (req, res) => {
  const { items, octal, recursive, opId } = req.body || {};
  if (opId) progress.create(opId, { label: "Applying permissions", kind: "chmod", phase: "scanning" });
  try {
    const adapter = cm.requireAdapter(sid(req));
    if (!/^[0-7]{3}$/.test(String(octal || ""))) {
      if (opId) progress.fail(opId, "Permissions must be a 3-digit octal value, e.g. 644.");
      return res.status(400).json({ error: "Permissions must be a 3-digit octal value, e.g. 644." });
    }

    // Phase 1: discover every target path up front (parents + all
    // descendants when recursive). Doing this before any chmod call means
    // a permission change on a parent can never block listing (and thus
    // updating) of its children, and a listing failure deep in the tree
    // can't lose track of items already found elsewhere. Total item count
    // isn't known until this walk finishes, so progress here just reports
    // how many have been found so far rather than a percentage.
    const targets = [];
    const seen = new Set();
    const listErrors = [];
    const addTarget = (p, type) => {
      if (seen.has(p)) return;
      seen.add(p);
      targets.push({ path: p, type });
      if (opId) progress.update(opId, { phase: "scanning", currentFile: p, foundCount: targets.length });
    };

    for (const item of items || []) {
      addTarget(item.path, item.type);
      if (item.type === "folder" && recursive) {
        await collectRecursive(adapter, item.path, addTarget, listErrors);
      }
    }

    // Phase 2: apply chmod to every discovered target independently. Each
    // attempt is isolated so one failure never skips the rest, and every
    // item (file or folder, top-level or nested) is verified and reported.
    if (opId) progress.update(opId, { phase: "applying", total: targets.length, processed: 0, currentFile: null });
    const results = [];
    let processed = 0;
    for (const target of targets) {
      if (opId) progress.update(opId, { currentFile: target.path, processed });
      try {
        await adapter.chmod(target.path, octal);
        results.push({ path: target.path, ok: true });
      } catch (e) {
        results.push({ path: target.path, ok: false, error: e.message });
      }
      processed++;
      if (opId) progress.update(opId, { processed });
    }
    // Folders we couldn't even list are reported too, instead of silently
    // dropping whatever was underneath them.
    for (const le of listErrors) results.push(le);

    const failCount = results.filter((r) => !r.ok).length;
    if (opId) {
      progress.finish(opId, {
        label: failCount ? "Completed with " + failCount + " error(s)" : "Permissions applied",
      });
    }
    res.json({ results });
  } catch (e) {
    if (opId) progress.fail(opId, e.message);
    res.status(e.code === "NOT_CONNECTED" ? 409 : 502).json({ error: e.message });
  }
});

/* ---------- upload ---------- */

// Tracks bytes arriving from the browser (phase "receiving"), before multer
// has even finished writing them to temp disk. Registered as its own
// middleware (ahead of multer) so it sees every chunk of the raw request.
function trackReceiveProgress(req, res, next) {
  const opId = req.query.opId;
  if (!opId) return next();
  const bytesTotal = Number(req.headers["content-length"] || 0);
  progress.create(opId, { label: "Uploading", kind: "upload", phase: "receiving", bytesTotal });
  let received = 0;
  req.on("data", (chunk) => {
    received += chunk.length;
    // Receiving from the browser is the first half of the overall bar;
    // the second half is the actual transfer to the remote FTP/SFTP
    // server below — percent is explicit here so switching phases can't
    // make the bar jump backward.
    const pct = bytesTotal ? Math.min(50, Math.round((received / bytesTotal) * 50)) : 0;
    progress.update(opId, { percent: pct });
  });
  next();
}

router.post("/upload", trackReceiveProgress, upload.array("files", 500), async (req, res) => {
  const opId = req.query.opId;
  const cleanup = () => {
    for (const f of req.files || []) {
      fs.unlink(f.path, () => {});
    }
  };
  try {
    const adapter = cm.requireAdapter(sid(req));
    const targetDir = req.body.targetDir || "/";
    let relPaths = [];
    try {
      relPaths = JSON.parse(req.body.relPaths || "[]");
    } catch (e) {
      relPaths = [];
    }
    const madeDirs = new Set();
    const results = [];
    const files = req.files || [];
    const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
    const pctForTransfer = (bytesDone) =>
      totalBytes ? 50 + Math.min(50, Math.round((bytesDone / totalBytes) * 50)) : 50;

    // Per-file tracking for the progress panel's Completed/Remaining lists —
    // same shape as the ZIP route uses, so the click-to-open panel works
    // for uploads (including drag-and-drop) without any client-side changes.
    const relPathList = files.map((f, i) => (relPaths[i] || f.originalname).replace(/^\/+/, ""));
    const trackedItems = relPathList.map((rel) => ({ path: rel, name: rel.split("/").pop() || rel, type: "file", status: "pending" }));
    function publishItems(extra) {
      if (!opId) return;
      progress.update(opId, Object.assign({ items: trackedItems }, extra || {}));
    }

    if (opId) {
      progress.update(opId, {
        phase: "transferring",
        total: files.length,
        processed: 0,
        bytesTotal: totalBytes,
        bytesProcessed: 0,
        percent: pctForTransfer(0),
      });
      publishItems();
    }

    let bytesDoneSoFar = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const rel = relPathList[i];
      const remotePath = joinPath(targetDir, rel);
      const remoteDir = remotePath.substring(0, remotePath.lastIndexOf("/")) || "/";
      trackedItems[i].status = "processing";
      publishItems({ currentFile: rel, processed: i, percent: pctForTransfer(bytesDoneSoFar) });
      try {
        if (remoteDir !== targetDir && !madeDirs.has(remoteDir)) {
          await adapter.ensureDirRecursive(remoteDir);
          madeDirs.add(remoteDir);
        }
        const stream = fs.createReadStream(file.path);
        const tracked = opId
          ? stream.pipe(
              countingStream((bytesThisFile) => {
                progress.update(opId, {
                  bytesProcessed: bytesDoneSoFar + bytesThisFile,
                  percent: pctForTransfer(bytesDoneSoFar + bytesThisFile),
                });
              })
            )
          : stream;
        await adapter.upload(tracked, remotePath);
        bytesDoneSoFar += file.size || 0;
        results.push({ name: rel, ok: true });
        trackedItems[i].status = "success";
      } catch (e) {
        bytesDoneSoFar += file.size || 0;
        results.push({ name: rel, ok: false, error: e.message });
        trackedItems[i].status = "failed";
        trackedItems[i].reason = e.message;
      }
      publishItems({ processed: i + 1, bytesProcessed: bytesDoneSoFar, percent: pctForTransfer(bytesDoneSoFar) });
    }
    cleanup();
    const failCount = results.filter((r) => !r.ok).length;
    if (opId) {
      progress.finish(opId, { label: failCount ? "Completed with " + failCount + " error(s)" : "Upload complete" });
    }
    res.json({ results });
  } catch (e) {
    cleanup();
    if (opId) progress.fail(opId, e.message);
    res.status(e.code === "NOT_CONNECTED" ? 409 : 502).json({ error: e.message });
  }
});

/* ---------- download single file ---------- */

router.get("/download", async (req, res) => {
  const opId = req.query.opId;
  const name0 = (req.query.path || "").split("/").filter(Boolean).pop() || "download";
  // The client already has this file's size from the directory listing, so
  // it's passed as a hint (?size=) — without it we can still report bytes
  // transferred, just not a percentage.
  const sizeHint = Number(req.query.size || 0);
  if (opId) {
    progress.create(opId, {
      label: "Downloading",
      kind: "download",
      phase: "transferring",
      currentFile: name0,
      bytesTotal: sizeHint,
    });
  }
  try {
    const adapter = cm.requireAdapter(sid(req));
    const remotePath = req.query.path;
    if (!remotePath) return res.status(400).json({ error: "path is required." });
    const name = remotePath.split("/").filter(Boolean).pop() || "download";
    res.setHeader("Content-Disposition", 'attachment; filename="' + name.replace(/"/g, "") + '"');
    res.setHeader("Content-Type", "application/octet-stream");
    const dest = opId ? countingStream((bytes) => progress.update(opId, { bytesProcessed: bytes })) : null;
    if (dest) {
      dest.pipe(res);
      await adapter.download(remotePath, dest);
    } else {
      await adapter.download(remotePath, res);
    }
    if (opId) progress.finish(opId, { label: "Download complete" });
  } catch (e) {
    if (opId) progress.fail(opId, e.message);
    if (!res.headersSent) {
      res.status(e.code === "NOT_CONNECTED" ? 409 : 502).json({ error: e.message });
    } else {
      res.end();
    }
  }
});

/* ---------- download selection as ZIP ----------
   This is a two-step, verify-before-download flow:
     1. POST here builds the ZIP to a temp file on disk (never straight to
        the response), verifies it's complete and intact, and returns a
        JSON summary plus a one-time download URL. Nothing is downloadable
        yet if verification fails.
     2. GET /download-zip/file/:token streams the already-verified file
        and deletes the temp copy afterward. */

router.post("/download-zip", async (req, res) => {
  const opId = (req.body && req.body.opId) || null;
  const token = opId || newZipToken();
  if (opId) progress.create(opId, { label: "Preparing ZIP", kind: "zip", phase: "verifying" });

  // Per-item tracking for the ZIP progress panel: every folder/file we know
  // about gets one entry here (keyed by remote path) with a live status —
  // pending -> processing -> success/skipped/failed. The panel derives its
  // "completed" and "remaining" lists by filtering this single array, so we
  // just push the whole snapshot to progress on every change.
  const trackedItems = new Map(); // remotePath -> { path, name, type, status, reason }
  function trackItem(remotePath, name, type, status, reason) {
    trackedItems.set(remotePath, { path: remotePath, name, type, status, reason: reason || null });
  }
  function setItemStatus(remotePath, status, reason) {
    const it = trackedItems.get(remotePath);
    if (it) {
      it.status = status;
      if (reason) it.reason = reason;
    }
  }
  function publishItems(extra) {
    if (!opId) return;
    progress.update(opId, Object.assign({ items: Array.from(trackedItems.values()) }, extra || {}));
  }
  function baseName(p) {
    return String(p || "").split("/").filter(Boolean).pop() || p;
  }

  try {
    const adapter = cm.requireAdapter(sid(req));
    const items = (req.body && req.body.items) || [];
    if (!items.length) {
      if (opId) progress.fail(opId, "No items selected.");
      return res.status(400).json({ error: "No items selected." });
    }
    const zipFilename = buildZipFilename(items);

    // Phase 0: verify every top-level selected item still exists on the
    // server before doing any work. Catches items deleted/renamed after
    // the client's listing was rendered, so we never silently produce a
    // ZIP that's missing something the user explicitly selected.
    const failed = []; // { path, type, reason } — accumulates through every phase
    const verifiedItems = [];
    for (const item of items) {
      if (item.type === "folder") {
        try {
          await adapter.list(item.path);
          verifiedItems.push(item);
        } catch (e) {
          const reason = "Not found or inaccessible: " + e.message;
          failed.push({ path: item.path, type: "folder", reason });
          trackItem(item.path, item.name || baseName(item.path), "folder", "skipped", reason);
        }
      } else {
        try {
          const siblings = await adapter.list(parentPath(item.path));
          const name = item.path.split("/").filter(Boolean).pop();
          const found = siblings.find((s) => s.name === name && s.type !== "folder");
          if (!found) {
            const reason = "File no longer exists on the server.";
            failed.push({ path: item.path, type: "file", reason });
            trackItem(item.path, item.name || baseName(item.path), "file", "skipped", reason);
          } else {
            verifiedItems.push({ ...item, size: found.size != null ? found.size : item.size });
          }
        } catch (e) {
          const reason = "Could not verify: " + e.message;
          failed.push({ path: item.path, type: "file", reason });
          trackItem(item.path, item.name || baseName(item.path), "file", "skipped", reason);
        }
      }
      if (opId) progress.update(opId, { phase: "verifying", currentFile: item.path, foundCount: verifiedItems.length });
    }
    publishItems();

    // Phase 1: walk every verified folder so we know the full file list,
    // folder list, and byte count before writing a single byte of the zip.
    // A listing failure on one subfolder is recorded (that folder's
    // contents will be incomplete) but never aborts the rest of the scan.
    // Every folder/file discovered here is immediately tracked as "pending"
    // so the progress panel's remaining-items list fills in live as the
    // scan goes, well before any bytes are actually zipped.
    const manifest = []; // { remotePath, entryName, size }
    const folderList = []; // { remotePath, entryName } — every folder, top-level + nested
    async function scanFolder(remotePath, entryName) {
      folderList.push({ remotePath, entryName: entryName.replace(/\/?$/, "/") });
      trackItem(remotePath, baseName(remotePath), "folder", "pending");
      publishItems({ phase: "scanning", foundCount: manifest.length + folderList.length, currentFile: remotePath });
      let entries;
      try {
        entries = await adapter.list(remotePath);
      } catch (e) {
        const reason = "Could not list contents: " + e.message;
        failed.push({ path: remotePath, type: "folder", reason });
        setItemStatus(remotePath, "failed", reason);
        publishItems();
        return;
      }
      for (const e of entries) {
        const childRemote = joinPath(remotePath, e.name);
        const childEntryName = entryName.replace(/\/$/, "") + "/" + e.name;
        if (e.type === "folder") {
          await scanFolder(childRemote, childEntryName);
        } else {
          manifest.push({ remotePath: childRemote, entryName: childEntryName, size: e.size || 0 });
          trackItem(childRemote, e.name, "file", "pending");
          publishItems({ phase: "scanning", foundCount: manifest.length + folderList.length, currentFile: childRemote });
        }
      }
    }
    for (const item of verifiedItems) {
      if (item.type === "folder") {
        await scanFolder(item.path, item.name);
      } else {
        manifest.push({ remotePath: item.path, entryName: item.name, size: item.size || 0 });
        trackItem(item.path, item.name, "file", "pending");
        publishItems({ phase: "scanning", foundCount: manifest.length + folderList.length, currentFile: item.path });
      }
    }

    const totalBytes = manifest.reduce((sum, m) => sum + (m.size || 0), 0);
    if (opId) {
      progress.update(opId, {
        phase: "zipping",
        total: manifest.length,
        processed: 0,
        bytesTotal: totalBytes,
        bytesProcessed: 0,
        currentFile: null,
      });
    }

    // Phase 2: build the archive to a private temp file. A running log of
    // every file and folder processed (added or failed, with reason) is
    // kept in processLog and printed to the server console for auditing.
    const zipDir = path.join(os.tmpdir(), "webfm-zips");
    fs.mkdirSync(zipDir, { recursive: true });
    const zipPath = path.join(zipDir, token + ".zip");

    const archive = archiver("zip", { zlib: { level: 6 } });
    const out = fs.createWriteStream(zipPath);
    let archiveStreamError = null;
    archive.on("warning", (err) => console.warn("[zip] warning:", err.message));
    archive.on("error", (err) => {
      archiveStreamError = err;
    });
    archive.pipe(out);

    const processLog = [];
    for (const folder of folderList) {
      archive.append(null, { name: folder.entryName });
      processLog.push({ path: folder.remotePath, type: "folder", status: "added" });
      setItemStatus(folder.remotePath, "success");
      console.log("[zip " + token + "] added folder:", folder.remotePath);
    }
    publishItems();

    let bytesDoneSoFar = 0;
    let processed = 0;
    for (const entry of manifest) {
      setItemStatus(entry.remotePath, "processing");
      publishItems({ currentFile: entry.remotePath, processed });
      const result = await addFileToArchive(
        adapter,
        archive,
        entry.remotePath,
        entry.entryName,
        opId ? (bytes) => progress.update(opId, { bytesProcessed: bytesDoneSoFar + bytes }) : null
      );
      if (result.success) {
        processLog.push({ path: entry.remotePath, type: "file", status: "added" });
        setItemStatus(entry.remotePath, "success");
        console.log("[zip " + token + "] added file:", entry.remotePath);
      } else {
        processLog.push({ path: entry.remotePath, type: "file", status: "failed", reason: result.reason });
        failed.push({ path: entry.remotePath, type: "file", reason: result.reason });
        setItemStatus(entry.remotePath, "failed", result.reason);
        console.warn("[zip " + token + "] failed file:", entry.remotePath, "-", result.reason);
      }
      bytesDoneSoFar += entry.size || 0;
      processed++;
      publishItems({ processed, bytesProcessed: bytesDoneSoFar });
    }

    if (opId) progress.update(opId, { phase: "verifying-archive", currentFile: null });

    await archive.finalize();
    await new Promise((resolve, reject) => {
      out.on("close", resolve);
      out.on("error", reject);
    });
    if (archiveStreamError) throw archiveStreamError;

    // Phase 3: verify the archive on disk before anyone is allowed to
    // download it. Two independent checks: the byte count archiver
    // reports having written must match the file's actual size on disk
    // (catches truncation), and the zip's own central directory entry
    // count must match how many folders/files we successfully added
    // (catches a corrupt/incomplete index).
    const filesAdded = processLog.filter((p) => p.type === "file" && p.status === "added").length;
    const foldersAdded = folderList.length;
    const expectedEntries = filesAdded + foldersAdded;

    let verified = true;
    const verifyNotes = [];
    let stat;
    try {
      stat = fs.statSync(zipPath);
    } catch (e) {
      verified = false;
      verifyNotes.push("Archive file was not found on disk after creation.");
    }
    if (stat) {
      const expectedBytes = archive.pointer();
      if (stat.size <= 0 || stat.size !== expectedBytes) {
        verified = false;
        verifyNotes.push("Archive size on disk (" + stat.size + " bytes) does not match bytes written (" + expectedBytes + ").");
      }
    }
    if (verified) {
      const entryCount = readZipEntryCount(zipPath);
      if (entryCount === null) {
        verifyNotes.push("Could not read archive index to confirm entry count.");
      } else if (entryCount !== expectedEntries) {
        verified = false;
        verifyNotes.push("Archive index has " + entryCount + " entr(y/ies), expected " + expectedEntries + ".");
      }
    }

    const summary = {
      totalFilesFound: manifest.length,
      totalFoldersFound: folderList.length,
      filesAdded,
      foldersAdded,
      itemsSucceeded: filesAdded + foldersAdded,
      itemsFailed: failed.length,
      failed,
      verified,
    };

    if (!verified) {
      console.error("[zip " + token + "] verification FAILED:", verifyNotes.join(" "));
      fs.unlink(zipPath, () => {});
      if (opId) progress.fail(opId, "ZIP verification failed: " + verifyNotes.join(" "));
      return res.status(500).json({ error: "ZIP verification failed: " + verifyNotes.join(" "), summary });
    }

    zipStore.set(token, { zipPath, size: stat.size, filename: zipFilename, createdAt: Date.now(), summary });
    scheduleZipCleanup(token);

    if (opId) {
      progress.finish(opId, {
        label: failed.length ? "ZIP ready with " + failed.length + " issue(s)" : "ZIP ready",
        summary,
      });
    }

    res.json({ ok: true, token, summary, filename: zipFilename, downloadUrl: "/api/files/download-zip/file/" + token });
  } catch (e) {
    discardZip(token);
    if (opId) progress.fail(opId, e.message);
    res.status(e.code === "NOT_CONNECTED" ? 409 : 502).json({ error: e.message });
  }
});

// Serves an already-built, already-verified ZIP and removes the temp copy
// once the download finishes (or fails partway). Re-checks the file is
// still on disk and its size hasn't changed since verification, so a
// download can never start against a file that isn't known-good.
router.get("/download-zip/file/:token", (req, res) => {
  const token = req.params.token;
  const entry = zipStore.get(token);
  if (!entry) {
    return res.status(404).json({ error: "This ZIP is no longer available. Please generate it again." });
  }
  let stat;
  try {
    stat = fs.statSync(entry.zipPath);
  } catch (e) {
    zipStore.delete(token);
    return res.status(410).json({ error: "This ZIP is no longer available. Please generate it again." });
  }
  if (stat.size !== entry.size) {
    discardZip(token);
    return res.status(500).json({ error: "ZIP failed final verification. Please generate it again." });
  }

  const safeName = (entry.filename || "download.zip").replace(/"/g, "");
  res.setHeader("Content-Disposition", 'attachment; filename="' + safeName + '"');
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Length", String(stat.size));

  const rs = fs.createReadStream(entry.zipPath);
  rs.on("error", () => {
    if (!res.headersSent) res.status(500);
    res.end();
  });
  const cleanup = () => discardZip(token);
  rs.on("close", cleanup);
  res.on("close", cleanup);
  rs.pipe(res);
});

async function addFileToArchive(adapter, archive, remotePath, entryName, onBytes) {
  const pass = new PassThrough();
  archive.append(pass, { name: entryName });
  const dest = onBytes ? countingStream(onBytes) : pass;
  if (onBytes) dest.pipe(pass);
  try {
    await adapter.download(remotePath, dest);
    return { success: true };
  } catch (e) {
    try {
      dest.end();
    } catch (e2) {
      /* stream already closed */
    }
    return { success: false, reason: e.message };
  }
}

module.exports = router;
