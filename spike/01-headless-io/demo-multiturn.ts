import { runAgy } from "./agy-events";

async function main() {
  const handle = runAgy({
    cwd: process.cwd(),
    inputTurns: [
      "Remember the secret word is WRAPPER_TEST_42. Reply with just OK.",
      "What is the secret word?",
    ],
    model: "gemini-3.8-flash-low",
    dangerouslySkipPermissions: true,
    printTimeout: "60s",
    killAfterMs: 90_000,
  });
  for await (const ev of handle.events) {
    if (ev.event === "result") {
      console.log("[result]", ev.result.response.trim(), "| num_turns=", ev.result.num_turns);
    }
  }
  console.log("exit:", await handle.exitCode);
}
main();
