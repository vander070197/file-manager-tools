const { Client, FileType } = require("basic-ftp");
const dns = require("dns").promises;
const net = require("net");

// Joins POSIX-style remote paths, collapsing slashes.
function joinPath(dir, name) {
  if (dir === "/" || dir === "") return "/" + name;
  return dir.replace(/\/+$/, "") + "/" + name;
}

// Control-socket connect timeout. Many shared-hosting FTP daemons are slow to
// answer the initial TCP handshake (rate limiting / connection queuing under
// load), so the previous fixed 20s was too aggressive. Configurable via env
// so it can be tuned per-deployment without a code change.
const CONNECT_TIMEOUT_MS = Number(process.env.FTP_CONNECT_TIMEOUT_MS) || 45000;

// Node resolves hostnames using whatever DNS records exist (A and/or AAAA).
// basic-ftp (like plain net.connect) does not implement Happy-Eyeballs
// fallback: if a host publishes an AAAA record but the outbound IPv6 route
// from this VPS is blackholed/unreachable (extremely common with budget
// VPS providers and most shared-hosting FTP servers, which are IPv4-only
// anyway), the control-socket connection attempt hangs until it hits the
// client timeout, surfacing as "Timeout (control socket)" even though a
// plain IPv4 connection would succeed immediately. Resolving to an IPv4
// address ourselves before handing it to basic-ftp avoids that entirely.
async function resolveIPv4(host) {
  if (net.isIP(host)) return host; // already a literal IP, nothing to resolve
  try {
    const { address } = await dns.lookup(host, { family: 4 });
    return address;
  } catch (e) {
    // DNS lookup itself failed (bad hostname, resolver issue, etc). Let the
    // original hostname flow through so the eventual error from basic-ftp
    // reflects the real problem instead of masking it here.
    return host;
  }
}

// Turns low-level connect failures into messages that actually point at a
// fix, instead of the raw basic-ftp/Node error text.
function translateConnectError(e, host, port) {
  const msg = String(e && e.message || e);
  if (/timeout/i.test(msg) && /control socket/i.test(msg)) {
    return new Error(
      `Could not reach ${host}:${port} (control socket timed out after ${CONNECT_TIMEOUT_MS / 1000}s). ` +
        "This is almost always a network-path issue rather than bad credentials: " +
        "the FTP server never completed the TCP handshake. Check that (1) the host/port are correct, " +
        "(2) your VPS's outbound firewall/security-group allows outbound traffic on this port, " +
        "and (3) the shared-hosting provider hasn't IP-blocked this VPS (some auto-block after failed attempts)."
    );
  }
  if (e && e.code === "ENOTFOUND") {
    return new Error(`Could not resolve host "${host}". Double-check the hostname.`);
  }
  if (e && e.code === "ECONNREFUSED") {
    return new Error(`Connection to ${host}:${port} was refused. The FTP service may be down or the port is wrong.`);
  }
  return e;
}

class FtpAdapter {
  constructor() {
    this.protocol = "FTP";
    this.client = new Client(CONNECT_TIMEOUT_MS);
    this.client.ftp.verbose = false;
  }

  async connect({ host, port, username, password, secure }) {
    const resolvedHost = await resolveIPv4(host);
    const resolvedPort = port ? Number(port) : 21;
    const doAttempt = () =>
      this.client.access({
        host: resolvedHost,
        port: resolvedPort,
        user: username,
        password,
        secure: !!secure, // explicit FTPS (AUTH TLS) when true
        // servername keeps TLS SNI/cert checks pointed at the original
        // hostname even though we connect by resolved IPv4 address.
        secureOptions: secure ? { rejectUnauthorized: false, servername: host } : undefined,
      });

    try {
      await doAttempt();
    } catch (e) {
      const isTimeout = /timeout/i.test(String(e && e.message));
      if (!isTimeout) throw translateConnectError(e, host, resolvedPort);
      // Shared-hosting control connections occasionally fail once under load
      // and succeed immediately after; one quick retry avoids surfacing a
      // spurious error for what is otherwise a working connection.
      try {
        this.client.close();
        this.client = new Client(CONNECT_TIMEOUT_MS);
        this.client.ftp.verbose = false;
        await doAttempt();
      } catch (e2) {
        throw translateConnectError(e2, host, resolvedPort);
      }
    }
  }

  async list(remotePath) {
    const raw = await this.client.list(remotePath || "/");
    return raw
      .filter((f) => f.name !== "." && f.name !== "..")
      .map((f) => ({
        name: f.name,
        type: f.isDirectory ? "folder" : f.isSymbolicLink ? "folder" : "file",
        size: f.isDirectory ? null : f.size,
        modified: f.rawModifiedAt || f.date || null,
        permsOctal: permsToOctal(f.permissions),
        symlink: f.isSymbolicLink || false,
      }));
  }

  async mkdir(remotePath) {
    await this.client.send("MKD " + remotePath, true);
  }

  async deleteFile(remotePath) {
    await this.client.remove(remotePath);
  }

  async deleteDir(remotePath) {
    // basic-ftp's removeDir recursively removes a directory and everything in it.
    await this.client.removeDir(remotePath);
  }

  async rename(fromPath, toPath) {
    await this.client.rename(fromPath, toPath);
  }

  async chmod(remotePath, octal) {
    const res = await this.client.send("SITE CHMOD " + octal + " " + remotePath, true);
    if (res.code >= 400) throw new Error("Server rejected CHMOD (SITE CHMOD may be unsupported): " + res.message);
  }

  async upload(readStream, remotePath) {
    await this.client.uploadFrom(readStream, remotePath);
  }

  async download(remotePath, writeStream) {
    await this.client.downloadTo(writeStream, remotePath);
  }

  async ensureDirRecursive(remotePath) {
    // Creates every missing segment of remotePath. Uses ensureDir which also
    // leaves the client's cwd changed, so we restore cwd afterward.
    const cwd = await this.client.pwd().catch(() => "/");
    await this.client.ensureDir(remotePath);
    await this.client.cd(cwd).catch(() => {});
  }

  close() {
    this.client.close();
  }
}

function permsToOctal(p) {
  if (!p) return "644";
  const bits = (v) => (v || 0) & 7;
  return "" + bits(p.user) + bits(p.group) + bits(p.world);
}

module.exports = { FtpAdapter, joinPath };
