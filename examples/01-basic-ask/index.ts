/**
 * The smallest possible Limn program. Phase 1 placeholder; the call works
 * once the Anthropic provider lands.
 */

import { ai } from "limn";

async function main(): Promise<void> {
  const summary = await ai.ask(
    "Summarize this in one sentence:",
    "Limn is a TypeScript-first library that makes building, debugging, " +
      "and operating LLM applications dramatically simpler.",
  );
  console.log(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
