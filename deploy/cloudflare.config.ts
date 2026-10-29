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
			CHECKIN_IP_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: 120, period: 60 } }),
			ADMIN_TOKEN: bindings.secret(),
		},
	},
});
