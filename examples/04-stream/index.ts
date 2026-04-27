import { ai } from "limn";

async function main(): Promise<void> {
  for await (const chunk of ai.stream("Write a haiku about debugging.")) {
    process.stdout.write(chunk);
  }
  process.stdout.write("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
