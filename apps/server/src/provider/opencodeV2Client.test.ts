import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { createOpenCodeV2Client } from "./opencodeV2Client.ts";

function clientFor(respond: (request: Request) => Response | Promise<Response>) {
  return createOpenCodeV2Client({
    baseUrl: "http://opencode.test/",
    directory: "/workspace/project",
    serverPassword: "secret",
    fetch: async (input, init) =>
      respond(input instanceof Request ? new Request(input, init) : new Request(input, init)),
  });
}

describe("OpenCode v2 HTTP compatibility client", () => {
  it("uses the v2 info endpoint and basic server authentication for health", async () => {
    const client = clientFor((request) => {
      NodeAssert.equal(request.url, "http://opencode.test/api/info");
      NodeAssert.equal(request.headers.get("authorization"), "Basic b3BlbmNvZGU6c2VjcmV0");
      return Response.json({ version: "2.0.12", pid: 1, urls: [], paths: { tmp: "/tmp" } });
    });

    const result = await client.global.health({});
    NodeAssert.deepEqual(result.data, { healthy: true, version: "2.0.12" });
  });

  it("waits for a v2 prompt result while asynchronous prompts return after admission", async () => {
    const requests: Request[] = [];
    const client = clientFor(async (request) => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/message"))
        return Response.json({
          data: [
            {
              id: "msg_assistant",
              sessionID: "ses_1",
              type: "assistant",
              time: { created: 0 },
              content: [{ type: "text", text: "generated" }],
            },
          ],
        });
      return Response.json({ data: { id: "msg_1" } });
    });

    const generated = await client.session.prompt({
      sessionID: "ses_1",
      parts: [{ type: "text", text: "write a title" }],
    });
    await client.session.promptAsync({
      sessionID: "ses_1",
      parts: [{ type: "text", text: "start a turn" }],
    });

    NodeAssert.equal(new URL(requests[0]!.url).pathname, "/api/session/ses_1/prompt");
    NodeAssert.equal(new URL(requests[1]!.url).pathname, "/api/experimental/session/ses_1/wait");
    NodeAssert.equal(new URL(requests[2]!.url).pathname, "/api/session/ses_1/message");
    NodeAssert.equal(new URL(requests[3]!.url).pathname, "/api/session/ses_1/prompt");
    NodeAssert.equal(
      (generated.data?.parts[0] as { text?: string } | undefined)?.text,
      "generated",
    );
  });

  it("translates v1 model and permission rule shapes before creating a v2 session", async () => {
    const client = clientFor(async (request) => {
      NodeAssert.equal(new URL(request.url).pathname, "/api/session");
      NodeAssert.deepEqual(await request.json(), {
        model: { providerID: "openai", id: "gpt-5", variant: "high" },
        permissions: [{ action: "shell", resource: "*", effect: "ask" }],
        location: { directory: "/workspace/project" },
      });
      return Response.json({
        data: {
          id: "ses_1",
          projectID: "project",
          cost: 0,
          tokens: {},
          time: { created: 0, updated: 0 },
          location: { directory: "/workspace/project" },
        },
      });
    });

    await client.session.create({
      model: { providerID: "openai", id: "gpt-5", variant: "high" },
      permission: [{ permission: "bash", pattern: "*", action: "ask" }],
    });
  });

  it("rebuilds the v1 provider inventory from v2 providers and models", async () => {
    const client = clientFor((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/provider") {
        return Response.json({
          location: {},
          data: [
            { id: "openai", name: "OpenAI", activation: "enabled", package: "@ai-sdk/openai" },
          ],
        });
      }
      NodeAssert.equal(path, "/api/model");
      return Response.json({
        location: {},
        data: [
          {
            id: "gpt-5",
            providerID: "openai",
            name: "GPT-5",
            capabilities: { input: ["text"], tools: true },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 1, output: 1 },
          },
        ],
      });
    });

    const inventory = await client.provider.list();
    NodeAssert.deepEqual(inventory.data?.connected, ["openai"]);
    NodeAssert.equal(inventory.data?.all[0]?.models["gpt-5"]?.name, "GPT-5");
  });

  it("remembers v2 nested request sessions before replying through the v1 API", async () => {
    const requests: Request[] = [];
    const client = clientFor(async (request) => {
      requests.push(request);
      if (new URL(request.url).pathname === "/api/permission/request") {
        return Response.json({
          location: { directory: "/workspace/project" },
          data: [{ id: "per_1", sessionID: "ses_1", action: "bash", resources: [] }],
        });
      }
      return new Response(null, { status: 204 });
    });

    await client.permission.list();
    await client.permission.reply({ requestID: "per_1", reply: "once" });

    NodeAssert.equal(
      new URL(requests[1]!.url).pathname,
      "/api/session/ses_1/permission/per_1/reply",
    );
    NodeAssert.equal(await requests[1]!.text(), '{"decision":"once"}');
  });

  it("converts legacy form answer arrays to v2 field values", async () => {
    const requests: Request[] = [];
    const client = clientFor(async (request) => {
      requests.push(request);
      if (new URL(request.url).pathname === "/api/form") {
        return Response.json({
          location: {},
          data: [
            {
              id: "frm_1",
              sessionID: "ses_1",
              title: "Settings",
              fields: [
                {
                  key: "style",
                  type: "string",
                  options: [{ label: "Friendly", value: "friendly" }],
                },
                {
                  key: "tags",
                  type: "multiselect",
                  options: [
                    { label: "First choice", value: "one" },
                    { label: "Second choice", value: "two" },
                  ],
                },
                { key: "enabled", type: "boolean" },
                { key: "count", type: "integer" },
                { key: "optional", type: "string" },
              ],
            },
          ],
        });
      }
      return new Response(null, { status: 204 });
    });

    await client.question.list();
    await client.question.reply({
      requestID: "frm_1",
      answers: [["Friendly"], ["First choice", "Second choice"], ["true"], ["4"], []],
    } as never);

    NodeAssert.equal(new URL(requests[1]!.url).pathname, "/api/session/ses_1/form/frm_1/reply");
    NodeAssert.deepEqual(await requests[1]!.json(), {
      answer: { style: "friendly", tags: ["one", "two"], enabled: true, count: 4 },
    });
  });

  it("lists all direct children through v2 parent filtering and pagination", async () => {
    const requests: Request[] = [];
    const client = clientFor((request) => {
      requests.push(request);
      const cursor = new URL(request.url).searchParams.get("cursor");
      return Response.json(
        cursor === "next-page"
          ? { data: [{ id: "ses_child_2", parentID: "ses_parent" }], cursor: {} }
          : {
              data: [{ id: "ses_child_1", parentID: "ses_parent" }],
              cursor: { next: "next-page" },
            },
      );
    });

    const result = await client.session.children({ sessionID: "ses_parent" });

    NodeAssert.deepEqual(
      result.data?.map((entry) => entry.id),
      ["ses_child_1", "ses_child_2"],
    );
    NodeAssert.equal(new URL(requests[0]!.url).searchParams.get("parentID"), "ses_parent");
    NodeAssert.equal(new URL(requests[1]!.url).searchParams.get("cursor"), "next-page");
  });

  it("answers a form discovered only through the v2 event stream", async () => {
    const requests: Request[] = [];
    const encoder = new TextEncoder();
    const client = clientFor(async (request) => {
      requests.push(request);
      if (new URL(request.url).pathname === "/api/event") {
        const event = JSON.stringify({
          type: "form.created",
          data: {
            form: {
              id: "frm_stream",
              sessionID: "ses_stream",
              title: "Pick",
              fields: [
                {
                  key: "choice",
                  type: "string",
                  options: [{ label: "Visible", value: "stored" }],
                },
              ],
            },
          },
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${event}\n\n`));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(null, { status: 204 });
    });

    const subscription = await client.event.subscribe();
    await subscription.stream[Symbol.asyncIterator]().next();
    await client.question.reply({ requestID: "frm_stream", answers: [["Visible"]] } as never);

    NodeAssert.equal(
      new URL(requests[1]!.url).pathname,
      "/api/session/ses_stream/form/frm_stream/reply",
    );
    NodeAssert.deepEqual(await requests[1]!.json(), { answer: { choice: "stored" } });
  });
});
