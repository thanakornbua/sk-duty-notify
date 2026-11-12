// Create a management account. Prints JSON with the SQL to run against the database.
//
//   node scripts/create-admin.mjs --google <email> "<Display name>"
//     Google sign-in account (normal case). Self-hosted servers can use INITIAL_ADMIN_EMAILS instead.
//
//   node scripts/create-admin.mjs <username> "<Display name>"
//     Break-glass username + password account (only usable with ALLOW_PASSWORD_LOGIN=1). Prints a one-time
//     temporary password that must be changed at first sign-in; it is never written to disk by this script.
//     Same hash format as src/auth.ts: pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>.
//
// Run the SQL with:  wrangler d1 execute <db> --remote --command "<sql>"   (Workers)
// Self-hosted: prefer INITIAL_ADMIN_EMAILS. Otherwise, inside the container:
//   node -e 'new (require("node:sqlite").DatabaseSync)("/data/sk-duty-notify.sqlite").exec(process.argv[1])' "<sql>"
import { pbkdf2Sync, randomBytes, randomInt } from "node:crypto";

const q = (s) => `'${s.replace(/'/g, "''")}'`;
if (process.argv[2] === "--google") {
  const [, email, name] = process.argv.slice(2);
  const mail = (email ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(mail) || !name) {
    console.error('usage: node scripts/create-admin.mjs --google <email> "<Display name>"');
    process.exit(1);
  }
  const sql = `INSERT INTO admin_users (username, email, display_name, password_hash, must_change, created_at) ` +
    `VALUES (${q(mail)}, ${q(mail)}, ${q(name)}, '', 0, ${Date.now()}) ON CONFLICT DO NOTHING;`;
  console.log(JSON.stringify({ email: mail, sql }));
  process.exit(0);
}

const [username, displayName] = process.argv.slice(2);
if (!username || !displayName || !/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
  console.error('usage: node scripts/create-admin.mjs <username: 3-64 of A-Za-z0-9._-> "<Display name>"');
  process.exit(1);
}
const ITERATIONS = 20_000; // keep in step with config.auth.pbkdf2Iterations
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const password = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
const salt = randomBytes(16);
const hash = `pbkdf2-sha256$${ITERATIONS}$${salt.toString("base64")}$${pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256").toString("base64")}`;
const now = Date.now();
const sql =
  `INSERT INTO admin_users (username, display_name, password_hash, must_change, created_at) VALUES (${q(username)}, ${q(displayName)}, ${q(hash)}, 1, ${now}) ` +
  `ON CONFLICT (username) DO UPDATE SET display_name = excluded.display_name, password_hash = excluded.password_hash, must_change = 1, ` +
  `failed_count = 0, locked_until = NULL, disabled = 0; ` +
  `DELETE FROM admin_sessions WHERE user_id = (SELECT id FROM admin_users WHERE username = ${q(username)});`;
console.log(JSON.stringify({ username, temporaryPassword: password, sql }));
