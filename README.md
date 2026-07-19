# Web File Manager (real FTP/SFTP client)

This replaces the earlier browser-only mockup. It's now a real two-part app:

- **Backend** (`server.js` + `lib/` + `routes/`): a Node.js/Express server that
  opens actual FTP sockets (via `basic-ftp`) and SFTP sockets (via
  `ssh2-sftp-client`) and does the real listing/upload/download/delete/chmod
  work. This is the part browsers can't do directly — an FTP/SFTP connection
  has to originate from a server, not from JavaScript running in someone's
  tab. This is what you'll deploy to your VPS.
- **Frontend** (`public/index.html`): the same look and toolbar as before,
  but every action now calls the backend's REST API instead of touching a
  fake in-memory filesystem.

## What's real now

- Site Manager saves connections **server-side**, passwords encrypted at
  rest (AES-256-GCM, keyed from `SESSION_SECRET`) — not just in the browser.
- "Connect" opens a genuine FTP or SFTP session on the VPS and keeps it
  alive for your browser session (closed automatically after 30 minutes
  idle, or when you disconnect/log out).
- Browsing, upload (files and whole folders, preserving structure),
  download-as-ZIP (streamed, not built in the browser), delete (recursive
  for folders), and permissions/chmod (with the same recursive-apply prompt)
  all hit the live remote server.
- A simple login screen gates the whole tool, since it's exposed on your VPS.

## 1. Local setup / first run

```bash
cd filemanager
npm install
cp .env.example .env
```

Generate a session secret and put it in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Generate your login password hash and put it in `.env` as `ADMIN_PASSWORD_HASH`:

```bash
npm run hash-password -- "choose-a-strong-password"
```

Edit `.env`:

```
PORT=3000
SESSION_SECRET=<the random string you generated>
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=<the bcrypt hash you generated>
COOKIE_SECURE=false   # set to true once you're serving over HTTPS
```

Run it:

```bash
npm start
```

Visit `http://localhost:3000`, log in, open **Site Manager**, add your
FTP/SFTP server, and hit **Connect**.

## 2. Deploying to your VPS

### Install Node.js (if not already installed)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # confirm v18+
```

(Different distro? Use your package manager or nvm — any Node 18+ works.)

### Copy the app up and install

```bash
# from your local machine
scp -r filemanager you@your-vps:/opt/filemanager

# on the VPS
cd /opt/filemanager
npm install --omit=dev
cp .env.example .env
# edit .env exactly as in step 1 (new SESSION_SECRET, real ADMIN_PASSWORD_HASH)
```

### Keep it running with PM2

```bash
sudo npm install -g pm2
pm2 start server.js --name filemanager
pm2 save
pm2 startup   # follow the printed instructions so it survives reboots
```

### Put it behind HTTPS (strongly recommended)

The login cookie and any FTP/SFTP passwords typed into the login form
travel over whatever protocol you serve this on — don't run this on plain
HTTP across the open internet. Easiest path is nginx + Let's Encrypt:

```nginx
server {
    listen 80;
    server_name files.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }
    client_max_body_size 2048M;   # raise this if you'll upload large files
}
```

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d files.yourdomain.com
```

Once HTTPS is live, set `COOKIE_SECURE=true` in `.env` and restart
(`pm2 restart filemanager`).

### Firewall

You only need the VPS's inbound port open for the web app itself (80/443,
or 3000 if you're not using a reverse proxy). The FTP/SFTP connections are
**outbound** from your VPS to whatever remote server you're managing, so no
extra inbound ports are needed on the VPS for that.

## Notes and limitations

- **FTP permissions (`SITE CHMOD`)**: not every FTP server implements this
  command. If a remote server rejects it, the Permissions action will report
  a per-item error rather than silently failing.
- **Passive-mode FTP**: `basic-ftp` uses passive mode by default, which
  works through most NATs/firewalls without extra configuration on your end.
- **Sessions are in-memory**: restarting the Node process logs everyone out
  and drops any open FTP/SFTP connections (saved sites in `data/sites.json`
  are unaffected). Fine for a single-VPS deployment; if you ever run more
  than one Node instance behind a load balancer, swap in a shared session
  store (e.g. `connect-redis`).
- **One login covers the whole tool.** It's meant for personal/team use on
  your own VPS, not as a multi-tenant product — everyone who logs in shares
  the same saved Site Manager entries.
- Feature set intentionally matches the original mockup: browse, upload
  (files/folders), download-as-ZIP, delete, and chmod. Things FileZilla has
  that this doesn't (yet): drag-and-drop, transfer queue/progress bars,
  rename-in-place, and resuming interrupted transfers.

## Project layout

```
filemanager/
  server.js              Express app entry point, sessions, routing
  lib/
    ftpAdapter.js         basic-ftp wrapped into a common interface
    sftpAdapter.js         ssh2-sftp-client wrapped the same way
    connectionManager.js  one live socket per logged-in session
    sitesStore.js         encrypted-at-rest saved connections
    crypto.js             AES-256-GCM helpers
  routes/
    auth.js               login/logout/session
    sites.js               Site Manager CRUD
    files.js               list/upload/download/delete/chmod/zip
  public/
    index.html             the frontend (login screen + file manager UI)
  scripts/
    hash-password.js       generates ADMIN_PASSWORD_HASH
  data/
    sites.json              created at runtime, gitignored
```
