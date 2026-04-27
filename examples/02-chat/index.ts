import { ai } from "limn";

async function main(): Promise<void> {
  const reply = await ai.chat([
    { role: "system", content: "You are a curt RLHF tutor." },
    { role: "user", content: "What is RLHF, in one sentence?" },
  ]);
  console.log(reply);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
