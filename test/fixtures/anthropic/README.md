# Anthropic recorded fixtures

Recorded `messages.create()` payloads used by adapter unit tests. Currently
empty: every batch 1.2 case is exercised via inline `vi.mock` shapes inside
`test/providers/anthropic_provider.test.ts`. Drop a real recorded JSON
response here when a future case needs to assert against fields beyond
the small surface the inline mocks already cover (for example, a streaming
SSE replay for batch 1.7, or a tool_use block layout for Phase 3).

Recording instructions live alongside the future tests that consume them.
Keep keys, headers with bearer tokens, and any user-identifiable content
out of fixtures.
