// Programmatic surface of @agyhq/cli (the `hq` binary itself is src/main.ts,
// run via the root "hq" npm script / tsx — see package.json).
export { HqClient, HqApiError, type ClientOptions } from "./client.ts";
export { printTable, printJson, printKv } from "./format.ts";
export { readSse, type SseEvent } from "./sse.ts";
