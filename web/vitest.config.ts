import { playwright } from "@vitest/browser-playwright";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { defineConfig, mergeConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import viteConfig from "./vite.config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [{
        extends: true,
        plugins: [
          storybookTest({
            configDir: path.join(dirname, ".storybook"),
            storybookScript: "npm run storybook -- --no-open",
          }),
        ],
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            provider: playwright(process.env.PW_WS
              ? { connectOptions: { wsEndpoint: process.env.PW_WS } }
              : {}),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      }],
    },
  }),
);
