import { ai } from "limn";
import { z } from "zod";

const Person = z.object({
  name: z.string(),
  email: z.string().email(),
  yearsOfExperience: z.number().int().nonnegative(),
});

async function main(): Promise<void> {
  const resume = `
    Jane Doe
    jane@example.com
    7 years working on distributed systems.
  `;

  const person = await ai.extract(Person, resume, { retryOnSchemaFailure: true });
  console.log(person);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
