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
			ADMIN_TOKEN: bindings.secret(),
		},
	},
});
