import type { ClientOptions } from "../client.ts";

/** Global flags every command receives (same shape as main.ts's GlobalFlags). */
export interface CliGlobals extends ClientOptions {
  json: boolean;
}
