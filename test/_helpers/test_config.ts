/**
 * Canonical test-config factory. Every unit test that needs a `TraceworksConfig`
 * builds it through this helper so we have a single place to update when
 * defaults shift.
 */

import { DEFAULT_CONFIG, type TraceworksConfig } from "../../src/config/traceworks_config.js";

export function testConfig(overrides: Partial<TraceworksConfig> = {}): TraceworksConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
