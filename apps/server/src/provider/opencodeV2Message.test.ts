import { describe, expect, it } from "vite-plus/test";

import { toOpenCodeV1MessageEntry } from "./opencodeV2Events.ts";

describe("OpenCode v2 persisted-message projection", () => {
  it("keeps a user message and its native attachment as a rollback boundary", () => {
    const entry = toOpenCodeV1MessageEntry(
      {
        id: "msg_user",
        type: "user",
        text: "Review this image",
        time: { created: 10 },
        files: [
          {
            data: "aGVsbG8=",
            mime: "text/plain",
            source: { type: "inline" },
            name: "notes.txt",
          },
        ],
      },
      "ses_1",
    );

    expect(entry).toMatchObject({
      info: { id: "msg_user", sessionID: "ses_1", role: "user", time: { created: 10 } },
      parts: [
        { type: "text", text: "Review this image" },
        { type: "file", filename: "notes.txt", url: "data:text/plain;base64,aGVsbG8=" },
      ],
    });
  });

  it("keeps assistant replay fields, tool output, and tool-file attachments", () => {
    const entry = toOpenCodeV1MessageEntry(
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5", variant: "high" },
        finish: "tool-calls",
        cost: 0.25,
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
        time: { created: 11, completed: 12 },
        content: [
          { type: "reasoning", text: "Plan" },
          { type: "text", text: "Done" },
          {
            type: "tool",
            id: "call_1",
            name: "bash",
            state: {
              status: "completed",
              input: { command: "pwd" },
              content: [
                { type: "text", text: "/workspace" },
                {
                  type: "file",
                  uri: "file:///workspace/result.txt",
                  mime: "text/plain",
                  name: "result.txt",
                },
              ],
              metadata: { exitCode: 0 },
            },
            time: { created: 11, completed: 12 },
          },
        ],
      },
      "ses_1",
    );

    expect(entry).toMatchObject({
      info: {
        id: "msg_assistant",
        role: "assistant",
        modelID: "gpt-5",
        providerID: "openai",
        variant: "high",
        agent: "build",
        finish: "tool-calls",
        tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
      },
      parts: [
        { type: "reasoning", text: "Plan" },
        { type: "text", text: "Done" },
        {
          type: "tool",
          callID: "call_1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "pwd" },
            output: "/workspace",
            attachments: [
              { type: "file", filename: "result.txt", url: "file:///workspace/result.txt" },
            ],
          },
        },
      ],
    });
  });

  it("retains user and assistant ordering needed to fork at the last user boundary", () => {
    const entries = [
      toOpenCodeV1MessageEntry(
        { id: "msg_user_1", type: "user", text: "First", time: { created: 1 } },
        "ses_1",
      ),
      toOpenCodeV1MessageEntry(
        { id: "msg_assistant_1", type: "assistant", content: [], time: { created: 2 } },
        "ses_1",
      ),
      toOpenCodeV1MessageEntry(
        { id: "msg_user_2", type: "user", text: "Second", time: { created: 3 } },
        "ses_1",
      ),
      toOpenCodeV1MessageEntry(
        { id: "msg_assistant_2", type: "assistant", content: [], time: { created: 4 } },
        "ses_1",
      ),
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

    const assistant = entries.find((entry) => entry.info.id === "msg_assistant_2");
    const assistantIndex = entries.indexOf(assistant!);
    const boundary = entries
      .slice(0, assistantIndex + 1)
      .findLast((entry) => entry.info.role === "user");
    expect(boundary?.info.id).toBe("msg_user_2");
  });
});
