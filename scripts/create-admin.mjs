// Create (or reset) an admin login. Prints JSON: the SQL to run against D1, and a one-time temporary password
// that must be changed at first sign-in. The password is never written to disk by this script.
//   node scripts/create-admin.mjs <username> "<Display name>"
// Same hash format as src/auth.ts: pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>.
import { pbkdf2Sync, randomBytes, randomInt } from "node:crypto";

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
const q = (s) => `'${s.replace(/'/g, "''")}'`;
const now = Date.now();
const sql =
  `INSERT INTO admin_users (username, display_name, password_hash, must_change, created_at) VALUES (${q(username)}, ${q(displayName)}, ${q(hash)}, 1, ${now}) ` +
  `ON CONFLICT (username) DO UPDATE SET display_name = excluded.display_name, password_hash = excluded.password_hash, must_change = 1, ` +
  `failed_count = 0, locked_until = NULL, disabled = 0; ` +
  `DELETE FROM admin_sessions WHERE user_id = (SELECT id FROM admin_users WHERE username = ${q(username)});`;
console.log(JSON.stringify({ username, temporaryPassword: password, sql }));
