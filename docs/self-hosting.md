# Self-hosting on your own computer (Docker / Kubernetes + Cloudflare Tunnel)

The same code that runs on Cloudflare Workers also runs as a Node.js container with a local SQLite database.
A Cloudflare Tunnel publishes it: the computer only makes **outbound** connections, so it needs no public IP,
no open router ports, and no TLS certificates.

```
 phones / admins ──HTTPS──▶ Cloudflare edge ──tunnel──▶ cloudflared ──HTTP──▶ sk-duty-notify (Node + SQLite)
                                                       (on your computer)        /data: database + daily backups
```

Two ways to run it. Pick one:

| | Docker Compose | Kubernetes (k3s) |
|---|---|---|
| Setup | `docker compose up -d` | install k3s, `kubectl apply -k k8s/` |
| Restarts after crash / reboot | yes (`restart: unless-stopped`) | yes, plus health probes |
| Rolling config changes, more services later | manual | built in |
| Best for | one machine, least to learn | more services later, or move to another machine with the same manifests |

Either way the app runs as **one** instance. SQLite has one writer and the scheduler must run once a minute,
so do not scale it to more replicas.

## 0. Requirements

- Any 64-bit computer that stays on: 2 GB RAM is plenty (the app uses about 100 MB), and a few GB of disk.
- Linux (Ubuntu Server 24.04 LTS or Debian 12 recommended). Disable sleep/suspend.
- A domain on Cloudflare (free plan is fine), e.g. `duty.example.ac.th`.
- Accounts: LINE Developers, Google Cloud (school Workspace admin can help), Cloudflare.

## Fastest path: the install script

On a fresh Ubuntu Server 24.04 / Debian 12 computer:

```bash
sudo apt-get install -y git
git clone <your repo url> sk-duty-notify && cd sk-duty-notify
sudo ./install.sh --no-sleep          # Docker Compose
# or: sudo ./install.sh --k3s --no-sleep
```

It installs Docker (from Docker's own apt repository; k3s v1.33.5+k3s1 with `--k3s`), asks for every setting
below and writes `.env` (readable by you only), builds the image, starts the app and the tunnel, waits until the app
is healthy and prints the URLs to paste into the Cloudflare, Google and LINE consoles. Run it again any time: it keeps
`.env`, rebuilds from the current code and restarts (`--reconfigure` asks the settings again). To update:
`git pull && sudo ./install.sh`.

You still need the console steps in sections 2–4 (they need your accounts). The sections below are the manual way.

## 1. Build the image

On the computer (or anywhere with Docker, then copy the image over):

```bash
git clone <your repo url> sk-duty-notify && cd sk-duty-notify
docker build -t sk-duty-notify:1.1.0 .
```

## 2. Cloudflare Tunnel

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → type *Cloudflared*.
2. Name it (e.g. `sk-duty`). On the install page, copy the **token** (the long string after `--token`). Do not run their install command; the container does that.
3. **Public Hostname** tab → add:
   - Subdomain + domain: `duty` . `example.ac.th`
   - Service: **HTTP**, URL:
     - Docker Compose: `app:8787`
     - Kubernetes: `sk-duty-notify.sk-duty-notify.svc.cluster.local:80`

Cloudflare now serves `https://duty.example.ac.th` with its own certificate. **Do not** put Cloudflare Access in
front of it: members must reach the LIFF pages and Google must reach `/auth/google/callback`.

## 3. LINE

In the [LINE Developers console](https://developers.line.biz/console/), same provider as before:

| Where | Setting |
|---|---|
| Messaging API channel → Messaging API | Webhook URL `https://duty.example.ac.th/webhook/line`, **Use webhook** on, then **Verify** |
| LINE Official Account Manager → Response settings | Greeting message and Auto-response **off** (the app replies itself) |
| LINE Login channel → LIFF | Endpoint URL `https://duty.example.ac.th/liff`, size Full, scope `openid` + `profile`, **Add friend option: On (Aggressive)** so linking also adds the OA |
| LINE Login channel | Status **Published** (while "Developing", only testers can open the LIFF pages) |

The LIFF ID does not change when the endpoint moves, so printed flyers stay valid if you change servers later.

## 4. Google sign-in

In [Google Cloud console](https://console.cloud.google.com/) (a project owned by the school's Workspace):

1. **APIs & Services → OAuth consent screen**:
   - If every allowed domain belongs to the **same** Workspace organisation, choose **Internal**.
   - If students are on a **separate** Workspace (e.g. `student.example.ac.th` is its own organisation), choose
     **External** and **Publish** the app. The scopes used (`openid`, `email`, `profile`) need no Google verification.
     The app itself still refuses any account outside `GOOGLE_ALLOWED_DOMAINS`.
2. **Credentials → Create credentials → OAuth client ID** → *Web application*.
   - Authorized redirect URI: `https://duty.example.ac.th/auth/google/callback`
3. Copy the client ID and secret.

Accounts must be Google Workspace accounts on an allowed domain. The app checks both the email domain and Google's
`hd` (hosted domain) claim, so a personal Google account registered with a school address is refused.

## 4b. Email (check-in receipts)

Each successful check-in sends the member an **email receipt** (to their roster email). Settings → *Email notices* can
also send email copies of the reminders. Any SMTP server works; with Google Workspace:

- **Gmail SMTP**: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=` a sending account (e.g. a duty mailbox),
  `SMTP_PASS=` an [App Password](https://myaccount.google.com/apppasswords) of that account (needs 2-Step Verification).
  Limit: about 2,000 messages a day per account, plenty for 150 members.
- **Workspace SMTP relay** (Admin console → Apps → Gmail → Routing → SMTP relay service): `smtp-relay.gmail.com`, port
  587, allowed by the tunnel computer's public IP or with SMTP auth.

`SMTP_FROM` is the sender members see, e.g. `SK Duty <duty@example.ac.th>`. After starting, use Settings →
*Send me a test email*.

## 5a. Run with Docker Compose

```bash
cp .env.example .env
nano .env        # PUBLIC_URL, LINE_*, LIFF_ID, GOOGLE_*, GOOGLE_ALLOWED_DOMAINS, INITIAL_ADMIN_EMAILS, SMTP_*, TUNNEL_TOKEN
docker compose up -d
docker compose logs -f app
```

## 5b. Run on Kubernetes (k3s)

```bash
# Install k3s (single node). Traefik is not needed: the tunnel is the only entrance.
curl -sfL https://get.k3s.io | sudo INSTALL_K3S_EXEC="--disable traefik" sh -
sudo k3s kubectl get nodes

# Make the image available to k3s without a registry
docker save sk-duty-notify:1.1.0 | sudo k3s ctr images import -

# Configure
cd k8s
nano config.env                     # PUBLIC_URL, GOOGLE_ALLOWED_DOMAINS, INITIAL_ADMIN_EMAILS
cp app.env.example app.env && nano app.env        # LINE + Google secrets
cp tunnel.env.example tunnel.env && nano tunnel.env  # TUNNEL_TOKEN
cd ..

sudo k3s kubectl apply -k k8s/
sudo k3s kubectl -n sk-duty-notify get pods
sudo k3s kubectl -n sk-duty-notify logs deploy/sk-duty-notify
```

Changing `config.env` or the secrets: edit, then `kubectl apply -k k8s/` again. The generated names change, so the
pods restart with the new values.

## 6. First sign-in

- Put your Google email in `INITIAL_ADMIN_EMAILS` (step 5). Open `https://duty.example.ac.th/login` → **Sign in with Google**.
- Add other coordinators on **Accounts** by their school email.

## 7. Members and the printed flyer

1. **Roster → Import members**: CSV/Excel with `staff_code, name, email, group` (template on the page).
   The email is the member's school Google account (sign-in, receipts).
2. **Locations**: set each duty location's geofence on the map.
3. **Print sign-up flyer** (Roster page): QR code → LINE → *Continue with Google* → linked.
   The member list shows who has linked.
4. Plan duties on the **Duty sheet**: tick the grid, or import a CSV/Excel file at the bottom of the page.
5. Members open `https://duty.example.ac.th/me` (sign in with Google) to see their duties, history and attendance,
   and can check in there too, without LINE.

## Backups

The server writes a consistent copy of the database every day to `/data/backups/` (14 kept; `BACKUP_KEEP`).
They are still on the same disk, so **copy them off the machine** too, for example to Google Drive or another computer:

```bash
# Docker Compose
docker compose cp app:/data/backups ./backups-$(date +%F)
# Kubernetes
POD=$(sudo k3s kubectl -n sk-duty-notify get pod -l app=sk-duty-notify -o name)
sudo k3s kubectl -n sk-duty-notify cp ${POD#pod/}:/data/backups ./backups-$(date +%F)
```

Restore: stop the app, replace `/data/sk-duty-notify.sqlite` with a backup file (and delete the `-wal`/`-shm` files), start it.

## Upgrading

```bash
git pull
docker build -t sk-duty-notify:1.0.1 .
# Compose: set image tag in compose.yaml, then
docker compose up -d
# k3s:
docker save sk-duty-notify:1.0.1 | sudo k3s ctr images import -
# set images[0].newTag: 1.0.1 in k8s/kustomization.yaml, then
sudo k3s kubectl apply -k k8s/
```

Database migrations run automatically at start.

## Check it works

```bash
curl https://duty.example.ac.th/healthz          # {"ok":true}
```

The dashboard warns if the scheduler has not run in the last 3 minutes. If it does, check the app logs.

## Moving from Cloudflare Workers

The Workers deployment and the self-hosted one use the same schema. To carry data over, export D1
(`wrangler d1 export <db> --remote --output dump.sql`), stop the app, load the dump into a fresh
`/data/sk-duty-notify.sqlite`, and start it. Then point the LINE webhook and LIFF endpoint at the new hostname (step 3).
