import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
	worker: {
		name: "sk-duty-notify",
		compatibilityDate: "2026-10-01",
		entrypoint: "src/index.ts",
		triggers: [
			triggers.scheduled({
				schedule: "* * * * *",
			}),
		],
		env: {
			DB: bindings.d1({
				name: "sk-duty-notify",
				id: "00000000-0000-0000-0000-000000000000",
			}),
			// Same limiter as wrangler.jsonc: per-IP on /api/*, before any LINE call.
			IP_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: 120, period: 60 } }),
			ADMIN_TOKEN: bindings.secret(),
			// Messaging API channel (the OA): webhook signature + pushes.
			LINE_CHANNEL_SECRET: bindings.secret(),
			LINE_CHANNEL_ACCESS_TOKEN: bindings.secret(),
			// LINE Login channel holding the LIFF app (same provider): ID token audience.
			LINE_LOGIN_CHANNEL_ID: bindings.secret(),
			LIFF_ID: bindings.secret(),
		},
	},
});
