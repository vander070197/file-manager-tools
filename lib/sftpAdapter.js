const SftpClient = require("ssh2-sftp-client");

class SftpAdapter {
  constructor() {
    this.protocol = "SFTP";
    this.client = new SftpClient();
  }

  async connect({ host, port, username, password, privateKey, passphrase }) {
    const opts = {
      host,
      port: port ? Number(port) : 22,
      username,
      readyTimeout: 20000,
    };
    if (privateKey) {
      opts.privateKey = privateKey;
      if (passphrase) opts.passphrase = passphrase;
    } else {
      opts.password = password;
    }
    await this.client.connect(opts);
  }

  async list(remotePath) {
    const raw = await this.client.list(remotePath || "/");
    return raw.map((f) => ({
      name: f.name,
      type: f.type === "d" ? "folder" : "file",
      size: f.type === "d" ? null : f.size,
      modified: f.modifyTime ? new Date(f.modifyTime).toISOString() : null,
      permsOctal: rightsToOctal(f.rights),
      symlink: f.type === "l",
    }));
  }

  async mkdir(remotePath) {
    await this.client.mkdir(remotePath, false);
  }

  async deleteFile(remotePath) {
    await this.client.delete(remotePath);
  }

  async deleteDir(remotePath) {
    await this.client.rmdir(remotePath, true); // recursive
  }

  async rename(fromPath, toPath) {
    await this.client.rename(fromPath, toPath);
  }

  async chmod(remotePath, octal) {
    await this.client.chmod(remotePath, parseInt(String(octal), 8));
  }

  async upload(readStream, remotePath) {
    await this.client.put(readStream, remotePath);
  }

  async download(remotePath, writeStream) {
    await this.client.get(remotePath, writeStream);
  }

  async ensureDirRecursive(remotePath) {
    await this.client.mkdir(remotePath, true); // recursive=true creates parents
  }

  close() {
    return this.client.end().catch(() => {});
  }
}

function rightsToOctal(rights) {
  if (!rights) return "644";
  const digit = (s) => {
    if (!s) return 0;
    let n = 0;
    if (s.indexOf("r") !== -1) n += 4;
    if (s.indexOf("w") !== -1) n += 2;
    if (s.indexOf("x") !== -1) n += 1;
    return n;
  };
  return "" + digit(rights.user) + digit(rights.group) + digit(rights.other);
}

module.exports = { SftpAdapter };
