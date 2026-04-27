/**
 * Identity helper for `limn.config.ts`. Lets users get full IntelliSense on
 * their config without having to import and annotate the type:
 *
 *   import { defineConfig } from "limn";
 *   export default defineConfig({ defaultModel: "claude-sonnet-4-6" });
 */

import type { LimnConfig } from "./limn_config.js";

export type LimnUserConfig = Partial<LimnConfig>;

export function defineConfig(config: LimnUserConfig): LimnUserConfig {
  return config;
}
