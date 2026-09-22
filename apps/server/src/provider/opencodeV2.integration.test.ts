/**
 * Optional wire-level probe against a real OpenCode 2.x binary.
 *
 * Enable with:
 *   T3_TEST_OPENCODE_V2_BINARY=/path/to/opencode vp test run opencodeV2.integration
 *
 * The probe starts an isolated server with an empty config, so it does not
 * read the developer's OpenCode settings or make a model request.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { describe } from "vite-plus/test";

import {
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  verifyOpenCodeServerVersion,
} from "./opencodeRuntime.ts";

const binaryPath = process.env.T3_TEST_OPENCODE_V2_BINARY;
const testLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));

describe.runIf(binaryPath !== undefined && binaryPath.length > 0)(
  "OpenCode v2 real-binary probe",
  () => {
    effectIt.live("preserves runtime permissions and model variants through the v2 facade", () =>
      Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-v2-" });
        const workspace = path.join(root, "workspace");
        yield* fs.makeDirectory(workspace);
        const environment = {
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          OPENCODE_CONFIG_CONTENT: "{}",
        };

        yield* Effect.gen(function* () {
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

          const version = yield* verifyOpenCodeServerVersion(client);
          NodeAssert.equal(version.split(".")[0], "2");

          const originalRules: Array<{
            permission: string;
            pattern: string;
            action: "ask" | "allow";
          }> = [
            { permission: "*", pattern: "*", action: "ask" },
            { permission: "read", pattern: "*", action: "allow" },
          ];
          const created = yield* Effect.tryPromise(() =>
            client.session.create({ permission: originalRules }),
          );
          NodeAssert.ok(created.data?.id);

          const sessionID = created.data!.id;
          yield* Effect.tryPromise(() =>
            client.session.update({
              sessionID,
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            }),
          );
          const attemptedPrompt = yield* Effect.tryPromise(() =>
            client.session.promptAsync({
              sessionID,
              model: { providerID: "t3-probe", modelID: "no-network" },
              variant: "high",
              parts: [{ type: "text", text: "" }],
            }),
          ).pipe(Effect.result);
          // This is admission only; no provider response is awaited. Its
          // success proves the v2 switch-model payload was accepted first.
          NodeAssert.equal(attemptedPrompt._tag, "Success");
          const fetched = yield* Effect.tryPromise(() => client.session.get({ sessionID }));
          NodeAssert.deepEqual(fetched.data?.permission, [
            { permission: "*", pattern: "*", action: "allow" },
          ]);
          NodeAssert.deepEqual(fetched.data?.model, {
            providerID: "t3-probe",
            id: "no-network",
            variant: "high",
          });
        }).pipe(Effect.scoped);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  },
);
