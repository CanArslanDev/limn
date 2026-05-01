import { ai, tool } from "traceworks";
import { z } from "zod";

const search = tool({
  name: "search",
  description: "Search the web and return the top 3 results.",
  input: z.object({ query: z.string() }),
  run: async ({ query }) => {
    return [
      { title: `Result 1 for ${query}`, url: "https://example.com/1" },
      { title: `Result 2 for ${query}`, url: "https://example.com/2" },
      { title: `Result 3 for ${query}`, url: "https://example.com/3" },
    ];
  },
});

async function main(): Promise<void> {
  const agent = ai.agent({
    model: "claude-opus-4-7",
    tools: [search],
    onError: { RateLimitError: { retry: "exponential", max: 3 } },
  });

  const result = await agent.run("Research recent advances in RLHF");
  console.log(result.output);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
