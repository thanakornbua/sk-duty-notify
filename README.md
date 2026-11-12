# sk-duty-notify

Duty-roster reminders on **LINE** and **email**, with **GPS-verified check-in**. Built for a school duty team of about 150 people.

- Each member gets their own LINE messages: a **reminder** the day before, a **prompt** at the start of each duty,
  and one **missed** nudge if they haven't checked in after 30 minutes. After checking in they get an
  **email receipt**. Email copies of the notices can be switched on in Settings (for everyone, or only for members
  not linked to LINE).
- **Member page** (`/me`): members sign in with their school Google account to see their upcoming duties, history
  and attendance, and can check in from the browser without LINE.
- **Check-in** happens on a LIFF page inside LINE. The server verifies the member's LINE identity, the time window,
  a one-time nonce, GPS accuracy, and a multi-point geofence. Every attempt is stored, and suspicious patterns are
  flagged for review.
- Members **link their LINE account by signing in with their school Google account**. Admins sign in with Google too.
- **Admin web UI** (IBM Carbon Design System, Thai/English): duty dashboard, a **Roster** page (members only:
  add, bulk import, sign-up flyer) and a separate **Duty sheet** (duties only: tick grid or CSV/Excel import),
  geofence map editor, overrides, CSV export, email settings with a test button.

It runs either on **Cloudflare Workers + D1**, or **self-hosted** as a Docker image (Node.js + SQLite) behind a
Cloudflare Tunnel, with Kubernetes manifests included. Both run the same code in `src/`.

## Quick start (self-hosted)

On the Ubuntu/Debian computer, from this folder:

```bash
sudo ./install.sh --domain duty.example.ac.th   # installs Docker, asks for the settings, builds, starts app + tunnel
sudo ./install.sh --k3s --domain duty.example.ac.th   # the same on single-node Kubernetes (k3s)
```

Add `--no-sleep` to keep a laptop/desktop awake. The domain must be on your Cloudflare account; see
[Choosing the domain](docs/self-hosting.md#choosing-the-domain). By hand instead: `cp .env.example .env`, fill it in,
`docker compose up -d --build`.

Full guide, including the LINE, Google and Cloudflare console steps, k3s, backups and upgrades:
**[docs/self-hosting.md](docs/self-hosting.md)**.

## Develop

```bash
npm install
npm test              # vitest inside the Workers runtime (workerd + D1)
npm run typecheck
npm run smoke         # builds the Node server and runs an end-to-end check against it
cp .dev.vars.example .dev.vars && npm run dev   # local Worker with a fake LINE client
```

Docs:
- [docs/architecture.md](docs/architecture.md): how it works (architecture, data model, scheduler, check-in pipeline, security)
- [PLAN.md](PLAN.md): decisions and assumptions
- [CLAUDE.md](CLAUDE.md): project rules for contributors and coding agents

## Layout

```
src/        the application (a Cloudflare Worker: fetch + scheduled)
server/     Node.js runtime for self-hosting: D1-compatible SQLite adapter, static files, cron, backups
public/     admin pages and LIFF pages (plain HTML/JS, Carbon CSS)
migrations/ SQL schema, applied in order on both runtimes
test/       vitest suites
k8s/        Kubernetes (k3s) manifests: app, storage, cloudflared
deploy/     Cloudflare Workers deploy config
```

## Configuration

Self-hosted: environment variables, see [.env.example](.env.example). Workers: secrets, see
[deploy/cloudflare.config.ts](deploy/cloudflare.config.ts). Message copy, time windows and other tunables:
[src/config.ts](src/config.ts). The scheduling subset is also editable on the Settings page.

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately.

## Credits

Developed by **Thanakorn Buathongtanakarn** ([thanakorn.site](https://thanakorn.site)). The in-app credits page is `/credits`.

## License

[MIT](LICENSE). Bundled third-party files keep their own licenses: IBM Carbon styles (Apache-2.0),
SheetJS Community Edition (Apache-2.0), qrcode-generator (MIT); Nodemailer (MIT) is bundled into the server.
The school emblem (`public/brand/emblem-*.png`) is the property of its school and is **not** covered by the MIT
license; replace it for other deployments. The app icon (`public/brand/logo*`, `public/favicon.ico`) and the
developer wordmark (`public/brand/thanakorn-wordmark.svg`, thanakorn. design system) are set in IBM Plex Mono and
Geist (SIL OFL 1.1).
