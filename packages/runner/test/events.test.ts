import { describe, it, expect } from "vitest";
import { parseAgyLine, getConversationId } from "../src/events.ts";
import type { AgyInitEvent, AgyResultEvent, AgyStepUpdateEvent, AgyParseErrorEvent } from "../src/events.ts";

describe("parseAgyLine", () => {
  it("returns null for blank lines", () => {
    expect(parseAgyLine("")).toBeNull();
    expect(parseAgyLine("   \t  ")).toBeNull();
  });

  it("parses a real init event (captured shape)", () => {
    const raw =
      '{"event":"init","conversation_id":"abc-123","init":{"model":"gemini-3.8-flash-low","cwd":"/tmp","tools":["view_file"],"permission_mode":"always-proceed"}}';
    const ev = parseAgyLine(raw) as AgyInitEvent;
    expect(ev.event).toBe("init");
    expect(ev.conversation_id).toBe("abc-123");
    expect(ev.init.model).toBe("gemini-3.8-flash-low");
    expect(ev.init.tools).toEqual(["view_file"]);
  });

  it("parses a real result event with denied_actions (captured shape)", () => {
    const raw =
      '{"event":"result","result":{"conversation_id":"b8e3da26","status":"SUCCESS","response":"","duration_seconds":3.46,"num_turns":1,"usage":{"input_tokens":1,"output_tokens":2,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":3},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}';
    const ev = parseAgyLine(raw) as AgyResultEvent;
    expect(ev.event).toBe("result");
    expect(ev.result.status).toBe("SUCCESS");
    expect(ev.result.denied_actions).toEqual([{ action: "command", display_name: "RunCommand" }]);
  });

  it("never throws on invalid JSON, and reports it as a parse_error event", () => {
    const ev = parseAgyLine("Error: invalid --json-schema: schema is not valid JSON: bad");
    expect(ev).not.toBeNull();
    expect(ev!.event).toBe("parse_error");
    const checked = ev as AgyParseErrorEvent;
    expect(checked.raw).toContain("invalid --json-schema");
    expect(checked.error.length).toBeGreaterThan(0);
  });

  it("reports valid JSON with no 'event' field as a parse_error, not a crash", () => {
    const ev = parseAgyLine('{"foo":"bar"}');
    expect(ev!.event).toBe("parse_error");
  });

  it("reports a JSON array (valid JSON, not an object) as a parse_error", () => {
    const ev = parseAgyLine("[1,2,3]");
    expect(ev!.event).toBe("parse_error");
  });

  it("preserves an unrecognized event kind rather than dropping it", () => {
    const ev = parseAgyLine('{"event":"future_event","conversation_id":"xyz","payload":{"a":1}}');
    expect(ev).toEqual({ event: "future_event", conversation_id: "xyz", payload: { a: 1 } });
  });
});

describe("getConversationId", () => {
  it("reads the top-level id on init events", () => {
    const ev: AgyInitEvent = {
      event: "init",
      conversation_id: "conv-1",
      init: { model: "m", cwd: "/", tools: [], permission_mode: "always-proceed" },
    };
    expect(getConversationId(ev)).toBe("conv-1");
  });

  it("reads the nested id on step_update events", () => {
    const ev: AgyStepUpdateEvent = {
      event: "step_update",
      step_update: { conversation_id: "conv-2", step_index: 0, state: "DONE", step_type: "user_input" },
    };
    expect(getConversationId(ev)).toBe("conv-2");
  });

  it("reads the nested id on result events", () => {
    const ev: AgyResultEvent = {
      event: "result",
      result: {
        conversation_id: "conv-3",
        status: "SUCCESS",
        response: "",
        duration_seconds: 0,
        num_turns: 1,
        usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
      },
    };
    expect(getConversationId(ev)).toBe("conv-3");
  });

  it("returns null for a parse_error event", () => {
    const ev = parseAgyLine("not json")!;
    expect(getConversationId(ev)).toBeNull();
  });

  it("falls back to a string conversation_id field on an unknown event, else null", () => {
    expect(getConversationId({ event: "future_event", conversation_id: "conv-4" })).toBe("conv-4");
    expect(getConversationId({ event: "future_event" })).toBeNull();
  });
});
