# Cookbook

Copy-paste recipes for common Limn patterns. Each recipe is self-contained and tested against the public surface.

> As of batch 1.7 every recipe below runs end-to-end against Anthropic and OpenAI when the corresponding API key is set.

## Run multiple prompts in parallel

```ts
import { ai } from "limn";

const [summary, sentiment, keywords] = await Promise.all([
  ai.ask("Summarize this:", text),
  ai.ask("What is the sentiment of this text?", text),
  ai.ask("List the top 5 keywords:", text),
]);
```

Each call gets its own trace record. The inspector groups them by parent if you wrap them in an agent.

## Override the model per call

```ts
const draft = await ai.ask("Draft a quick reply:", text, {
  model: "claude-haiku-4-5",
});

const final = await ai.ask("Polish this draft:", draft, {
  model: "claude-opus-4-7",
});
```

## Stream into a file

```ts
import { createWriteStream } from "node:fs";
import { ai } from "limn";

const out = createWriteStream("response.txt");
for await (const chunk of ai.stream("Write a long-form essay on RLHF.")) {
  out.write(chunk);
}
out.end();
```

## Extract with retry on validation failure

```ts
import { ai } from "limn";
import { z } from "zod";

const Invoice = z.object({
  vendor: z.string(),
  total: z.number().positive(),
  currency: z.enum(["USD", "EUR", "GBP"]),
});

const invoice = await ai.extract(Invoice, ocrText, {
  retryOnSchemaFailure: true,
});
```

## Catch a specific error variant

```ts
import { ai, RateLimitError, SchemaValidationError } from "limn";

try {
  await ai.ask("...");
} catch (err) {
  if (err instanceof RateLimitError) {
    // Surface to the user, schedule a retry, etc.
  } else if (err instanceof SchemaValidationError) {
    console.error("Schema mismatch:", err.expectedSchemaName, err.actualPayload);
  } else {
    throw err;
  }
}
```

## More patterns coming

This guide grows alongside the implementation. Open an issue if there's a pattern you want documented.
