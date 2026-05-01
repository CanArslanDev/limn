/**
 * The smallest possible Traceworks program. Phase 1 placeholder; the call works
 * once the Anthropic provider lands.
 */

import { ai } from "traceworks";

async function main(): Promise<void> {
  const summary = await ai.ask(
    "Summarize this in one sentence:",
    "Traceworks is a TypeScript-first library that makes building, debugging, " +
      "and operating LLM applications dramatically simpler.",
  );
  console.log(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
