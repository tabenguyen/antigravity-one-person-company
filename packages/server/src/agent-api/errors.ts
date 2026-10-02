// Consistent error -> ApiEnvelope mapping for every MCP tool / hook handler.

import type { Context } from "hono";
import { ZodError } from "zod";
import { ConflictError, NotFoundError, TaskTransitionError } from "@agyhq/db";
import { ValidationError } from "../util.ts";
import { err } from "./envelope.ts";

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

/**
 * Maps a thrown error (or a zod SafeParseReturnType failure) to the right
 * ApiEnvelope error response. Unexpected errors are logged to stderr with
 * full detail and reported to the agent with a generic message only —
 * never leak internals to the model.
 */
export function handleError(c: Context, error: unknown): Response {
  if (error instanceof ZodError) {
    return err(c, "invalid_request", formatZodError(error));
  }
  if (error instanceof NotFoundError) {
    return err(c, "not_found", error.message);
  }
  if (error instanceof TaskTransitionError || error instanceof ConflictError) {
    return err(c, "conflict", error.message);
  }
  if (error instanceof ValidationError) {
    return err(c, "invalid_request", error.message);
  }
  if (error instanceof HttpError) {
    return err(c, error.code, error.message);
  }
  // eslint-disable-next-line no-console
  console.error("[agent-api] unexpected error:", error);
  return err(c, "internal", "internal error");
}

/** Throwable error for handlers that need to signal a specific ApiErrorCode (not_found/conflict/invalid_request/...). */
export class HttpError extends Error {
  readonly code: "unauthorized" | "forbidden" | "not_found" | "invalid_request" | "conflict";
  constructor(code: "unauthorized" | "forbidden" | "not_found" | "invalid_request" | "conflict", message: string) {
    super(message);
    this.name = "HttpError";
    this.code = code;
  }
}
