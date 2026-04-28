/**
 * Barrel for the test-only mock provider. Lives alongside the real adapters
 * but is never registered automatically; tests import and register it
 * explicitly.
 */
export { MockProvider } from "./mock_provider.js";
