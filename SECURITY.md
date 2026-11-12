# Security policy

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private vulnerability reporting
(**Security → Report a vulnerability** on the repository), or contact the maintainers privately.
Include steps to reproduce and the affected version or commit. We aim to reply within a week.

## Scope and design notes

- Member identity comes only from LINE ID tokens verified with LINE, never from a user id sent by the page.
- LINE accounts are linked to members through Google sign-in (OIDC, authorization code + PKCE, single-use state).
  Only Workspace accounts on `GOOGLE_ALLOWED_DOMAINS` are accepted (email domain **and** `hd` claim).
- Admin sessions: random 256-bit tokens, stored hashed, in `__Host-` HttpOnly Secure SameSite=Strict cookies.
  Every state-changing admin request must carry a same-origin `Origin`.
- Member page (`/me`) sessions: Google sign-in with the roster email, random 256-bit tokens stored hashed, in a
  `__Host-` HttpOnly Secure SameSite=Lax cookie (30 days, 14 days idle). The sign-in state is bound to the browser
  with its own cookie; every POST must carry a same-origin `Origin`. A member sees only their own records, never raw
  coordinates. Browser check-in runs the same checks as LIFF (assignment, window, single-use nonce, accuracy, geofence).
- Email goes out over SMTP with TLS (implicit or required STARTTLS; `SMTP_REQUIRE_TLS=0` only for a trusted local relay).
- LINE webhooks are verified (HMAC-SHA256 of the raw body) before parsing.
- Location data is read only at check-in, visible only to admins, and the raw coordinates are deleted after
  90 days (`config.locationRetentionDays`).
- Self-hosted: the app container is not exposed on the network. Only `cloudflared` reaches it. It runs as a non-root
  user with a read-only root filesystem. Requests are trusted to carry the visitor IP in `Cf-Connecting-Ip`,
  which holds only behind the tunnel.

Never commit secrets: `.env`, `.dev.vars`, `k8s/app.env` and `k8s/tunnel.env` are gitignored.
