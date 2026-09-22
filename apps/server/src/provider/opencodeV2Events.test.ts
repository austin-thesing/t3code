import { describe, expect, it } from "vite-plus/test";

import {
  makeOpenCodeV2EventTranslator,
  parseOpenCodeV2SseData,
  toOpenCodeV1Events,
} from "./opencodeV2Events.ts";

describe("OpenCode v2 event compatibility", () => {
  it("projects streaming text into the legacy message part lifecycle", () => {
    const started = toOpenCodeV1Events({
      id: "evt_1",
      type: "session.text.started",
      created: 1,
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0 },
    });
    const delta = toOpenCodeV1Events({
      id: "evt_2",
      type: "session.text.delta",
      created: 2,
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "Hello" },
    });

    expect(started[0]).toMatchObject({
      type: "message.part.updated",
      properties: { part: { type: "text", text: "" } },
    });
    expect(delta[0]).toMatchObject({
      type: "message.part.delta",
      properties: { messageID: "msg_1", field: "text", delta: "Hello" },
    });
  });

  it("preserves tool, permission, and form approvals", () => {
    const tool = toOpenCodeV1Events({
      id: "evt_3",
      type: "session.tool.success",
      created: 3,
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        id: "call_1",
        name: "bash",
        input: { command: "pwd" },
        content: [{ type: "text", text: "/tmp" }],
        executed: true,
      },
    });
    const permission = toOpenCodeV1Events({
      id: "evt_4",
      type: "permission.asked",
      created: 4,
      data: { id: "per_1", sessionID: "ses_1", action: "bash", resources: ["pwd"], save: ["pwd"] },
    });
    const form = toOpenCodeV1Events({
      id: "evt_5",
      type: "form.created",
      created: 5,
      data: {
        form: {
          id: "frm_1",
          sessionID: "ses_1",
          fields: [
            {
              key: "choice",
              title: "Choose",
              type: "multiselect",
              options: [{ value: "a", label: "A", description: "first" }],
            },
          ],
        },
      },
    });

    expect(tool[0]).toMatchObject({
      type: "message.part.updated",
      properties: {
        part: { type: "tool", tool: "bash", state: { status: "completed", output: "/tmp" } },
      },
    });
    expect(permission[0]).toMatchObject({
      type: "permission.asked",
      properties: { permission: "bash", patterns: ["pwd"], always: ["pwd"] },
    });
    expect(form[0]).toMatchObject({
      type: "question.asked",
      properties: { id: "frm_1", questions: [{ header: "Choose", multiple: true }] },
    });
  });

  it("links a v2 execution to its admitted user message and records final usage", () => {
    const translator = makeOpenCodeV2EventTranslator();
    const receipt = translator.toOpenCodeV1Events({
      id: "evt_user",
      type: "session.inbox.enqueued",
      created: 1,
      data: { sessionID: "ses_1", inboxID: "msg_user", item: { type: "user" } },
    });
    const started = translator.toOpenCodeV1Events({
      id: "evt_step",
      type: "session.step.started",
      created: 2,
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5" },
      },
    });
    const ended = translator.toOpenCodeV1Events({
      id: "evt_end",
      type: "session.step.ended",
      created: 3,
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        finish: "stop",
        cost: 0.25,
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
      },
    });

    expect(receipt[0]).toMatchObject({
      type: "message.updated",
      properties: { info: { id: "msg_user", role: "user" } },
    });
    expect(started[0]).toMatchObject({
      properties: { info: { parentID: "msg_user", model: { providerID: "openai", id: "gpt-5" } } },
    });
    expect(ended[1]).toMatchObject({
      type: "message.part.updated",
      properties: { part: { type: "step-finish", cost: 0.25, tokens: { output: 20 } } },
    });
  });

  it("unwraps Effect SSE data without throwing on malformed JSON", () => {
    expect(parseOpenCodeV2SseData('{"type":"server.connected"}')).toEqual({
      type: "server.connected",
    });
    expect(parseOpenCodeV2SseData("not-json")).toBeUndefined();
    expect(
      toOpenCodeV1Events({
        event: "message",
        data: '{"id":"evt_1","type":"server.connected","created":1,"data":{}}',
      })[0],
    ).toMatchObject({ type: "server.connected" });
  });
});
