/**
 * Canonical test-config factory. Every unit test that needs a `LimnConfig`
 * builds it through this helper so we have a single place to update when
 * defaults shift.
 */

import { DEFAULT_CONFIG, type LimnConfig } from "../../src/config/limn_config.js";

export function testConfig(overrides: Partial<LimnConfig> = {}): LimnConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
