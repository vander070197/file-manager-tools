const { Client, FileType } = require("basic-ftp");

// Joins POSIX-style remote paths, collapsing slashes.
function joinPath(dir, name) {
  if (dir === "/" || dir === "") return "/" + name;
  return dir.replace(/\/+$/, "") + "/" + name;
}

class FtpAdapter {
  constructor() {
    this.protocol = "FTP";
    this.client = new Client(20000); // 20s timeout
    this.client.ftp.verbose = false;
  }

  async connect({ host, port, username, password, secure }) {
    await this.client.access({
      host,
      port: port ? Number(port) : 21,
      user: username,
      password,
      secure: !!secure, // explicit FTPS (AUTH TLS) when true
      secureOptions: secure ? { rejectUnauthorized: false } : undefined,
    });
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
