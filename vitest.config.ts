import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: {
          TEST_MIGRATIONS: migrations, ADMIN_TOKEN: "test-token", ALLOW_PASSWORD_LOGIN: "1",
          GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "test-secret",
          GOOGLE_ALLOWED_DOMAINS: "school.test,student.school.test",
        } },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
