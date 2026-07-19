const { FtpAdapter, joinPath } = require("./ftpAdapter");
const { SftpAdapter } = require("./sftpAdapter");

// sessionId -> { adapter, protocol, host, connectedAt, lastUsed, siteName }
const sessions = new Map();

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // auto-drop sockets idle 30+ minutes

function touch(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.lastUsed = Date.now();
}

async function connect(sessionId, config) {
  await disconnect(sessionId); // close any prior connection for this session first

  const adapter = config.protocol === "SFTP" ? new SftpAdapter() : new FtpAdapter();
  await adapter.connect(config);

  sessions.set(sessionId, {
    adapter,
    protocol: adapter.protocol,
    host: config.host,
    siteName: config.siteName || config.host,
    connectedAt: Date.now(),
    lastUsed: Date.now(),
  });
  return sessions.get(sessionId);
}

function getSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) touch(sessionId);
  return s;
}

function requireAdapter(sessionId) {
  const s = getSession(sessionId);
  if (!s) {
    const err = new Error("Not connected to a server. Connect via Site Manager first.");
    err.code = "NOT_CONNECTED";
    throw err;
  }
  return s.adapter;
}

async function disconnect(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    s.adapter.close();
  } catch (e) {
    /* ignore close errors */
  }
  sessions.delete(sessionId);
}

// Periodically drop connections nobody has used in a while so the VPS
// doesn't accumulate zombie FTP/SFTP sockets.
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, s] of sessions.entries()) {
    if (now - s.lastUsed > IDLE_TIMEOUT_MS) {
      disconnect(sessionId);
    }
  }
}, 60 * 1000).unref();

module.exports = { connect, disconnect, getSession, requireAdapter, joinPath };
