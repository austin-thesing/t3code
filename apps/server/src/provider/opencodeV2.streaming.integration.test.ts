// @effect-diagnostics nodeBuiltinImport:off - this wire fixture serves the model protocol over a real loopback HTTP socket.
/**
 * Opt-in wire test for OpenCode v2. It drives a real binary against a local
 * OpenAI-compatible fixture only; no account credentials or external model
 * calls are involved.
 *
 * T3_TEST_OPENCODE_V2_BINARY=/path/to/opencode vp test run opencodeV2.streaming
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const binaryPath = process.env.T3_TEST_OPENCODE_V2_BINARY;
const testLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));
const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

async function fakeOpenAi(mode: "text" | "tool" = "text") {
  const server = NodeHttp.createServer((request, response) => {
    if (request.url !== "/chat/completions") {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: ReadonlyArray<{ role?: string }>;
      };
      const hasToolResponse = body.messages?.some((message) => message.role === "tool") === true;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (mode === "tool" && !hasToolResponse) {
        response.write(
          'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"shell","arguments":"{\\"command\\":\\"printf fixture\\"}"}}]},"finish_reason":null}]}\n\n',
        );
        response.write(
          'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        );
      } else {
        const content = mode === "tool" ? "tool fixture reply" : "fixture reply";
        response.write(
          `data: ${JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
        );
        response.write(
          'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        );
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve())),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server did not expose a TCP port.");
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe.runIf(binaryPath !== undefined && binaryPath.length > 0)(
  "OpenCode v2 streamed chat",
  () => {
    effectIt.live("projects real streamed events through the v1 adapter facade", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-v2-stream-" });
        const fixture = yield* Effect.acquireRelease(
          Effect.promise(() => fakeOpenAi()),
          (fixture) => Effect.promise(fixture.close),
        );
        const workspace = path.join(root, "workspace");
        yield* fs.makeDirectory(workspace);
        {
          yield* Effect.gen(function* () {
            const runtime = yield* OpenCodeRuntime;
            const config = yield* encodeConfig({
              update: "disable",
              providers: {
                fixture: {
                  package: "@opencode/ai/providers/openai-compatible",
                  settings: { apiKey: "fixture-key", baseURL: fixture.baseURL },
                  models: {
                    chat: {
                      capabilities: { tools: true, input: ["text"], output: ["text"] },
                      cost: { input: 0, output: 0 },
                      limit: { context: 1_000_000, output: 4_000 },
                    },
                  },
                },
              },
            });
            const environment = {
              XDG_CONFIG_HOME: path.join(root, "config"),
              XDG_DATA_HOME: path.join(root, "data"),
              XDG_CACHE_HOME: path.join(root, "cache"),
              OPENCODE_CONFIG_CONTENT: config,
            };
            const server = yield* runtime.connectToOpenCodeServer({
              binaryPath: binaryPath!,
              directory: workspace,
              environment,
            });
            const client = runtime.createOpenCodeSdkClient({
              baseUrl: server.url,
              directory: workspace,
              version: server.version,
              ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
            });
            const signal = AbortSignal.timeout(15_000);
            const stream = (yield* Effect.promise(() =>
              client.event.subscribe(undefined, { signal }),
            )).stream[Symbol.asyncIterator]();
            const connected = yield* Effect.promise(() => stream.next());
            NodeAssert.equal(connected.value?.type, "server.connected");
            const created = yield* Effect.promise(() =>
              client.session.create({ model: { providerID: "fixture", id: "chat" } }),
            );
            const sessionID = created.data?.id;
            NodeAssert.ok(sessionID);
            const messageID = "msg_t3_fixture";
            yield* Effect.promise(() =>
              client.session.promptAsync({
                sessionID,
                messageID,
                model: { providerID: "fixture", modelID: "chat" },
                parts: [{ type: "text", text: "Say fixture reply" }],
              }),
            );
            const events: Array<{
              readonly type?: string;
              readonly properties?: Record<string, unknown>;
            }> = [];
            while (events.length < 40) {
              const next = yield* Effect.promise(() => stream.next());
              if (next.done) break;
              if (next.value.type === "session.error")
                throw new Error(String(next.value.properties.error));
              events.push(
                next.value as {
                  readonly type?: string;
                  readonly properties?: Record<string, unknown>;
                },
              );
              if (
                next.value.type === "session.status" &&
                next.value.properties?.status &&
                (next.value.properties.status as { type?: string }).type === "idle"
              )
                break;
            }
            NodeAssert.ok(
              events.some(
                (event) =>
                  event.type === "message.updated" &&
                  event.properties?.info &&
                  (event.properties.info as { id?: string; role?: string }).id === messageID &&
                  (event.properties.info as { role?: string }).role === "user",
              ),
            );
            NodeAssert.ok(
              events.some(
                (event) =>
                  event.type === "message.part.delta" &&
                  event.properties?.delta === "fixture reply",
              ),
            );
            NodeAssert.ok(
              events.some(
                (event) =>
                  event.type === "session.status" &&
                  (event.properties?.status as { type?: string } | undefined)?.type === "idle",
              ),
            );
            const replay = yield* Effect.promise(() => client.session.messages({ sessionID }));
            NodeAssert.ok(
              replay.data?.some(
                (entry) => entry.info.role === "user" && entry.info.id === messageID,
              ),
            );
            const completed = yield* Effect.promise(() =>
              client.session.prompt({
                sessionID,
                model: { providerID: "fixture", modelID: "chat" },
                parts: [{ type: "text", text: "Return the synchronous fixture reply" }],
              }),
            );
            NodeAssert.equal(
              (completed.data?.parts[0] as { text?: string } | undefined)?.text,
              "fixture reply",
            );
          }).pipe(Effect.scoped);
        }
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );

    effectIt.live("replies to a real shell permission and resumes the streamed tool turn", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-v2-tool-" });
        const fixture = yield* Effect.acquireRelease(
          Effect.promise(() => fakeOpenAi("tool")),
          (fixture) => Effect.promise(fixture.close),
        );
        const workspace = path.join(root, "workspace");
        yield* fs.makeDirectory(workspace);
        yield* Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const config = yield* encodeConfig({
            update: "disable",
            providers: {
              fixture: {
                package: "@opencode/ai/providers/openai-compatible",
                settings: { apiKey: "fixture-key", baseURL: fixture.baseURL },
                models: {
                  chat: {
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    cost: { input: 0, output: 0 },
                    limit: { context: 1_000_000, output: 4_000 },
                  },
                },
              },
            },
          });
          const server = yield* runtime.connectToOpenCodeServer({
            binaryPath: binaryPath!,
            directory: workspace,
            environment: {
              XDG_CONFIG_HOME: path.join(root, "config"),
              XDG_DATA_HOME: path.join(root, "data"),
              XDG_CACHE_HOME: path.join(root, "cache"),
              OPENCODE_CONFIG_CONTENT: config,
            },
          });
          const client = runtime.createOpenCodeSdkClient({
            baseUrl: server.url,
            directory: workspace,
            version: server.version,
            ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
          });
          const signal = AbortSignal.timeout(15_000);
          const stream = (yield* Effect.promise(() =>
            client.event.subscribe(undefined, { signal }),
          )).stream[Symbol.asyncIterator]();
          yield* Effect.promise(() => stream.next());
          const created = yield* Effect.promise(() =>
            client.session.create({
              model: { providerID: "fixture", id: "chat" },
              permission: [{ permission: "bash", pattern: "*", action: "ask" }],
            }),
          );
          const sessionID = created.data?.id;
          NodeAssert.ok(sessionID);
          yield* Effect.promise(() =>
            client.session.promptAsync({
              sessionID,
              messageID: "msg_t3_tool_fixture",
              model: { providerID: "fixture", modelID: "chat" },
              parts: [{ type: "text", text: "Run the fixture command" }],
            }),
          );
          const events: Array<{
            readonly type?: string;
            readonly properties?: Record<string, unknown>;
          }> = [];
          let replied = false;
          while (events.length < 60) {
            const next = yield* Effect.promise(() => stream.next());
            if (next.done) break;
            const event = next.value as {
              readonly type?: string;
              readonly properties?: Record<string, unknown>;
            };
            if (event.type === "session.error") throw new Error(String(event.properties?.error));
            events.push(event);
            if (event.type === "permission.asked" && !replied) {
              const permissionRequestID = event.properties?.id;
              if (typeof permissionRequestID !== "string")
                throw new Error("OpenCode v2 emitted a permission without an ID.");
              yield* Effect.promise(() =>
                client.permission.reply({ requestID: permissionRequestID, reply: "once" }),
              );
              replied = true;
            }
            if (
              event.type === "session.status" &&
              (event.properties?.status as { type?: string } | undefined)?.type === "idle"
            )
              break;
          }
          NodeAssert.ok(replied, "the v2 shell permission was emitted and replied to");
          NodeAssert.ok(
            events.some((event) => {
              const part = event.properties?.part as
                | { type?: string; tool?: string; state?: { status?: string } }
                | undefined;
              return (
                event.type === "message.part.updated" &&
                part?.type === "tool" &&
                part.tool === "shell" &&
                part.state?.status === "completed"
              );
            }),
          );
          NodeAssert.ok(
            events.some(
              (event) =>
                event.type === "message.part.delta" &&
                event.properties?.delta === "tool fixture reply",
            ),
          );
          NodeAssert.ok(
            events.some(
              (event) =>
                event.type === "session.status" &&
                (event.properties?.status as { type?: string } | undefined)?.type === "idle",
            ),
          );
        }).pipe(Effect.scoped);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  },
);
