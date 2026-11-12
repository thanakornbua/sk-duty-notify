#!/usr/bin/env bash
# SK Duty installer for the self-hosted computer (Ubuntu 22.04+/Debian 12+, x86-64 or arm64).
#
#   sudo ./install.sh                 Docker Compose (simplest; recommended for one machine)
#   sudo ./install.sh --k3s           single-node Kubernetes (k3s) with the manifests in k8s/
#   options:
#     --reconfigure   ask the settings again even if .env exists
#     --no-sleep      keep the computer awake (no suspend; closing a laptop lid does nothing)
#     --yes           do not ask before installing Docker / k3s
#
# Run it from the repository folder. Running it again is safe: it keeps .env, rebuilds the image from the current
# code and restarts the app (that is also how you update: git pull, then sudo ./install.sh).
# Settings live in .env (chmod 600, never committed). See docs/self-hosting.md for the LINE / Google / Cloudflare side.
set -euo pipefail

K3S_VERSION="v1.33.5+k3s1"
MODE=compose RECONFIGURE=0 NO_SLEEP=0 YES=0
for a in "$@"; do
  case "$a" in
    --k3s) MODE=k3s ;;
    --compose) MODE=compose ;;
    --reconfigure) RECONFIGURE=1 ;;
    --no-sleep) NO_SLEEP=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$(readlink -f "$0")")"
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mxx %s\033[0m\n' "$*" >&2; exit 1; }
confirm() { [ "$YES" = 1 ] && return 0; read -r -p "$1 [Y/n] " r; [[ -z "$r" || "$r" =~ ^[Yy] ]]; }

[ "$(id -u)" = 0 ] || die "Run with sudo: sudo ./install.sh $*"
[ -f Dockerfile ] && [ -f compose.yaml ] || die "Run this from the sk-duty-notify folder."
. /etc/os-release
[[ "${ID:-} ${ID_LIKE:-}" =~ (debian|ubuntu) ]] || die "This script supports Ubuntu and Debian. Other systems: follow docs/self-hosting.md."
VERSION=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)
IMAGE="sk-duty-notify:${VERSION:?no version in package.json}"
OWNER="${SUDO_USER:-root}"

# ------------------------------------------------------------------- packages
say "Checking base packages"
need=()
for p in ca-certificates curl gnupg openssl; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
if [ ${#need[@]} -gt 0 ]; then apt-get update -q && apt-get install -yq "${need[@]}"; fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  say "Installing Docker Engine + Compose from Docker's apt repository"
  confirm "Install Docker now?" || die "Docker is required."
  install -m 0755 -d /etc/apt/keyrings
  DIST="$ID"; [ "$ID" = ubuntu ] || [ "$ID" = debian ] || DIST=$([[ "${ID_LIKE:-}" =~ ubuntu ]] && echo ubuntu || echo debian)
  CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:?cannot tell the release codename}}"
  curl -fsSL "https://download.docker.com/linux/${DIST}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DIST} ${CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker >/dev/null

# --------------------------------------------------------------------- config
# set_kv KEY VALUE: replace "KEY=..." (or "# KEY=...") in .env, or append it. No quotes; "$" is written as "$$"
# because Docker Compose expands variables in .env (the k8s files get it back as "$").
set_kv() {
  local key="$1" val="${2//\$/\$\$}" tmp
  tmp=$(mktemp)
  # ENVIRON, not awk -v: -v would turn backslashes in a password into escapes.
  K="$key" V="$val" awk 'BEGIN{done=0; k=ENVIRON["K"]; v=ENVIRON["V"]}
    $0 ~ "^#? ?"k"=" && !done {print k"="v; done=1; next} {print}
    END{if(!done) print k"="v}' .env > "$tmp"
  cat "$tmp" > .env && rm -f "$tmp"
}
get_kv() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n1; }

# ask KEY "Question" [secret] : shows the current value (secrets masked); Enter keeps it.
ask() {
  local key="$1" q="$2" secret="${3:-}" cur val shown
  cur=$(get_kv "$key")
  if [ -n "$secret" ]; then shown=$([ -n "$cur" ] && echo "(set, Enter keeps it)" || echo "")
  else shown=$([ -n "$cur" ] && echo "[$cur]" || echo ""); fi
  if [ -n "$secret" ]; then read -r -s -p "$q $shown: " val; echo; else read -r -p "$q $shown: " val; fi
  [ -n "$val" ] && set_kv "$key" "$val" || true
}

if [ ! -f .env ] || [ "$RECONFIGURE" = 1 ]; then
  [ -f .env ] || cp .env.example .env
  chmod 600 .env; chown "$OWNER" .env
  say "Settings (Enter keeps the value in brackets; secrets are not shown)"
  echo "Public address members will use, e.g. https://duty.example.ac.th"
  ask PUBLIC_URL "PUBLIC_URL"
  echo; echo "Google sign-in (Google Cloud console > Credentials > OAuth client, type Web application)"
  ask GOOGLE_ALLOWED_DOMAINS "School Google domains, comma-separated (e.g. example.ac.th,student.example.ac.th)"
  ask INITIAL_ADMIN_EMAILS "Your Google email (first admin; comma-separated for more)"
  ask GOOGLE_CLIENT_ID "Google OAuth client ID"
  ask GOOGLE_CLIENT_SECRET "Google OAuth client secret" secret
  echo; echo "LINE (LINE Developers console)"
  ask LINE_CHANNEL_SECRET "Messaging API channel secret" secret
  ask LINE_CHANNEL_ACCESS_TOKEN "Messaging API channel access token" secret
  ask LINE_LOGIN_CHANNEL_ID "LINE Login channel ID"
  ask LIFF_ID "LIFF ID"
  echo; echo "Email for check-in receipts (optional; Enter to skip). Gmail: smtp.gmail.com, port 465, an App Password."
  ask SMTP_HOST "SMTP host"
  if [ -n "$(get_kv SMTP_HOST)" ]; then
    ask SMTP_PORT "SMTP port"
    ask SMTP_USER "SMTP user (sending account)"
    ask SMTP_PASS "SMTP password / App Password" secret
    ask SMTP_FROM "From, e.g. SK Duty <duty@example.ac.th>"
  fi
  echo; echo "Cloudflare Tunnel (Zero Trust > Networks > Tunnels > Create > copy the token after --token)"
  ask TUNNEL_TOKEN "Tunnel token" secret
fi

# Checks that would make the app unusable.
url=$(get_kv PUBLIC_URL)
[[ "$url" =~ ^https://[^/]+$ ]] || die "PUBLIC_URL must look like https://duty.example.ac.th (no trailing slash). Fix .env or run with --reconfigure."
[ -n "$(get_kv TUNNEL_TOKEN)" ] || die "TUNNEL_TOKEN is empty. Fix .env or run with --reconfigure."
[ -n "$(get_kv GOOGLE_CLIENT_ID)" ] && [ -n "$(get_kv GOOGLE_CLIENT_SECRET)" ] || warn "Google sign-in is not configured yet: nobody can sign in until GOOGLE_CLIENT_ID/SECRET are set."
[ -n "$(get_kv GOOGLE_ALLOWED_DOMAINS)" ] || warn "GOOGLE_ALLOWED_DOMAINS is empty: ANY Google Workspace account could sign in to the member page. Set your school domains."
[ -n "$(get_kv INITIAL_ADMIN_EMAILS)" ] || warn "INITIAL_ADMIN_EMAILS is empty: there will be no admin account."
[ -n "$(get_kv LINE_CHANNEL_ACCESS_TOKEN)" ] || warn "LINE is not configured yet: no LINE notices, LIFF pages answer 503."
[ -n "$(get_kv SMTP_HOST)" ] || warn "Email is not configured: no check-in receipts."

# ----------------------------------------------------------------- keep awake
if [ "$NO_SLEEP" = 1 ]; then
  say "Keeping the computer awake"
  systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
  mkdir -p /etc/systemd/logind.conf.d
  printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\nIdleAction=ignore\n' \
    > /etc/systemd/logind.conf.d/sk-duty-awake.conf
  systemctl kill -s HUP systemd-logind || true
fi

# ---------------------------------------------------------------------- build
say "Building $IMAGE (a few minutes the first time)"
docker build -t "$IMAGE" .

health_cmd='fetch("http://127.0.0.1:8787/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

if [ "$MODE" = compose ]; then
  say "Starting with Docker Compose"
  docker compose up -d --remove-orphans
  for i in $(seq 1 60); do
    if docker compose exec -T app node -e "$health_cmd" 2>/dev/null; then break; fi
    [ "$i" = 60 ] && { docker compose logs --tail 50 app; die "The app did not become healthy."; }
    sleep 2
  done
  TUNNEL_TARGET="http://app:8787"
  LOGS="docker compose logs -f app"
else
  if ! command -v k3s >/dev/null 2>&1; then
    say "Installing k3s $K3S_VERSION (single node, no Traefik: the tunnel is the only entrance)"
    confirm "Install k3s now?" || die "k3s is required for --k3s."
    curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" INSTALL_K3S_EXEC="--disable traefik" sh -
  fi
  say "Importing $IMAGE into k3s"
  docker save "$IMAGE" | k3s ctr images import -
  # All settings go into the gitignored Secret files (Secret values override the ConfigMap defaults in config.env).
  umask 077
  grep -E '^[A-Z_]+=' .env | grep -v '^TUNNEL_TOKEN=' | sed 's/\$\$/$/g' > k8s/app.env
  grep -E '^TUNNEL_TOKEN=' .env | sed 's/\$\$/$/g' > k8s/tunnel.env
  chown "$OWNER" k8s/app.env k8s/tunnel.env
  say "Applying k8s/"
  k3s kubectl apply -k k8s/
  k3s kubectl -n sk-duty-notify rollout restart deploy/sk-duty-notify >/dev/null
  k3s kubectl -n sk-duty-notify rollout status deploy/sk-duty-notify --timeout=180s
  TUNNEL_TARGET="http://sk-duty-notify.sk-duty-notify.svc.cluster.local:80"
  LOGS="sudo k3s kubectl -n sk-duty-notify logs -f deploy/sk-duty-notify"
fi

# ----------------------------------------------------------------- next steps
cat <<EOF

$(printf '\033[32m')SK Duty $VERSION is running.$(printf '\033[0m')

Finish the setup outside this computer (details: docs/self-hosting.md):
  1. Cloudflare tunnel > Public Hostname: ${url#https://}  ->  Service ${TUNNEL_TARGET}
  2. Google OAuth client > Authorized redirect URI:  ${url}/auth/google/callback
  3. LINE Messaging API > Webhook URL:  ${url}/webhook/line   (Use webhook: on, then Verify)
     LINE Login > LIFF > Endpoint URL:  ${url}/liff
  4. Open ${url}/login and sign in with $(get_kv INITIAL_ADMIN_EMAILS | cut -d, -f1)
  5. Settings > Email notices > "Send me a test email" to check SMTP.

Logs:     $LOGS
Data:     database + daily backups in the app's /data volume (copy backups off this machine regularly)
Update:   git pull && sudo ./install.sh$([ "$MODE" = k3s ] && echo " --k3s")
EOF
