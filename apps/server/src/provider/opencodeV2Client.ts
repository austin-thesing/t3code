import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  makeOpenCodeV2EventTranslator,
  parseOpenCodeV2SseData,
  toOpenCodeV1MessageEntry,
  toOpenCodeV1Model,
  toOpenCodeV1PermissionRequest,
  toOpenCodeV1Provider,
  toOpenCodeV1QuestionRequestFromForm,
  toOpenCodeV1Session,
} from "./opencodeV2Events.ts";

/**
 * Compatibility boundary for OpenCode 2's intentionally smaller HTTP API.
 * T3's adapter is still written against the v1 SDK, so keep v2's route and
 * payload differences here instead of spreading version checks through it.
 */
export interface OpenCodeV2ClientOptions {
  readonly baseUrl: string;
  readonly directory: string;
  readonly serverPassword?: string;
  readonly fetch?: typeof globalThis.fetch;
}

type RequestOptions = { readonly signal?: AbortSignal } | undefined;
type Json = Record<string, unknown>;

function location(directory: string): string {
  return `location[directory]=${encodeURIComponent(directory)}`;
}

function modelRef(value: unknown): Json | undefined {
  if (typeof value === "string") {
    const slash = value.indexOf("/");
    if (slash <= 0) return undefined;
    const [id, variant] = value.slice(slash + 1).split("#", 2);
    return { providerID: value.slice(0, slash), id, ...(variant ? { variant } : {}) };
  }
  if (value && typeof value === "object") {
    const candidate = value as Json;
    if (
      typeof candidate.providerID === "string" &&
      (typeof candidate.modelID === "string" || typeof candidate.id === "string")
    ) {
      return {
        providerID: candidate.providerID,
        id: candidate.modelID ?? candidate.id,
        ...(typeof candidate.variant === "string" ? { variant: candidate.variant } : {}),
      };
    }
  }
  return undefined;
}

function withVariant(model: Json | undefined, variant: unknown): Json | undefined {
  return model && typeof variant === "string" && variant.length > 0 ? { ...model, variant } : model;
}

function permissionRules(value: unknown): ReadonlyArray<Json> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((rule) => {
    if (!rule || typeof rule !== "object") return [];
    const value = rule as Json;
    if (
      typeof value.permission !== "string" ||
      typeof value.pattern !== "string" ||
      typeof value.action !== "string"
    )
      return [];
    return [
      {
        action: value.permission === "bash" ? "shell" : value.permission,
        resource: value.pattern,
        effect: value.action,
      },
    ];
  });
}

function filesFromParts(parts: unknown): { text: string; files: ReadonlyArray<Json> } {
  if (!Array.isArray(parts)) return { text: "", files: [] };
  const text: string[] = [];
  const files: Json[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const value = part as Json;
    if (value.type === "text" && typeof value.text === "string") text.push(value.text);
    if (value.type === "file" && typeof value.url === "string") {
      files.push({
        uri: value.url,
        ...(typeof value.filename === "string" ? { name: value.filename } : {}),
      });
    }
  }
  return { text: text.join("\n"), files };
}

function makeHttpError(
  response: Response,
  body: unknown,
): Error & { response: { status: number }; data: unknown } {
  const error = Object.assign(new Error(`OpenCode v2 request failed: ${response.status}`), {
    response: { status: response.status },
    data: body,
  });
  return error;
}

/** Make an object structurally compatible with the v1 SDK client used by T3. */
export function createOpenCodeV2Client(input: OpenCodeV2ClientOptions): OpencodeClient {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(input.serverPassword
      ? {
          Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
        }
      : {}),
  };

  const request = async <T>(
    path: string,
    init: RequestInit = {},
    options?: RequestOptions,
  ): Promise<T> => {
    const response = await fetchImpl(`${baseUrl}/api${path}`, {
      ...init,
      ...(options?.signal ? { signal: options.signal } : {}),
      headers: {
        ...headers,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (response.status === 204) return { data: undefined } as T;
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw makeHttpError(response, body);
    return body as T;
  };
  const json = (value: unknown) => JSON.stringify(value);
  const scoped = (path: string) =>
    `${path}${path.includes("?") ? "&" : "?"}${location(input.directory)}`;
  const setSystemInstruction = (sessionID: string, system: unknown, options?: RequestOptions) =>
    typeof system === "string" && system.length > 0
      ? request(
          `/experimental/session/${sessionID}/instructions/entries/t3-code-runtime`,
          { method: "PUT", body: json({ value: system }) },
          options,
        )
      : Promise.resolve(undefined);
  // v1 replies only carry requestID. V2 nests both permissions and forms under
  // their session, so remember the relation from the corresponding list call.
  const permissionSessions = new Map<string, string>();
  const formSessions = new Map<string, string>();
  const formFields = new Map<string, ReadonlyArray<Json>>();
  const rememberForm = (form: unknown) => {
    if (!form || typeof form !== "object") return;
    const value = form as Json;
    if (typeof value.id !== "string" || typeof value.sessionID !== "string") return;
    formSessions.set(value.id, value.sessionID);
    if (Array.isArray(value.fields))
      formFields.set(
        value.id,
        value.fields.flatMap((field) =>
          field && typeof field === "object" ? [field as Json] : [],
        ),
      );
  };
  const rememberStreamRequest = (raw: unknown) => {
    const decoded = parseOpenCodeV2SseData(raw);
    if (!decoded || typeof decoded !== "object") return;
    const outer = decoded as Json;
    const event = outer.event
      ? typeof outer.data === "string"
        ? parseOpenCodeV2SseData(outer.data)
        : outer.data
      : decoded;
    if (!event || typeof event !== "object") return;
    const payload = (event as Json).data;
    if (!payload || typeof payload !== "object") return;
    const value = payload as Json;
    if (value.form && typeof value.form === "object") rememberForm(value.form);
    if (typeof value.id === "string" && typeof value.sessionID === "string") {
      if (value.id.startsWith("per")) permissionSessions.set(value.id, value.sessionID);
      if (value.id.startsWith("frm")) rememberForm(value);
    }
  };
  const rememberSessionIds = (result: unknown, destination: Map<string, string>) => {
    if (!result || typeof result !== "object") return result;
    const data = (result as Json).data;
    if (!Array.isArray(data)) return result;
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const value = item as Json;
      if (typeof value.id === "string" && typeof value.sessionID === "string")
        destination.set(value.id, value.sessionID);
    }
    return result;
  };
  const optionValue = (field: Json, value: unknown): unknown => {
    if (typeof value !== "string" || !Array.isArray(field.options)) return value;
    const option = field.options.find(
      (entry) => entry && typeof entry === "object" && (entry as Json).label === value,
    );
    return option && typeof option === "object" && "value" in option
      ? (option as Json).value
      : value;
  };
  const formAnswer = (formID: string, answers: unknown): Json => {
    if (!Array.isArray(answers))
      return answers && typeof answers === "object" ? (answers as Json) : {};
    const fields = formFields.get(formID) ?? [];
    const output: Json = {};
    for (const [index, field] of fields.entries()) {
      const key = typeof field.key === "string" ? field.key : String(index);
      const raw = answers[index];
      const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
      if (values.length === 0 && field.required !== true) continue;
      const first = optionValue(field, values[0]);
      switch (field.type) {
        case "multiselect":
          output[key] = values
            .map((value) => optionValue(field, value))
            .filter((value): value is string => typeof value === "string");
          break;
        case "number": {
          const value = typeof first === "number" ? first : Number(first);
          if (Number.isFinite(value)) output[key] = value;
          break;
        }
        case "integer": {
          const value = typeof first === "number" ? first : Number(first);
          if (Number.isInteger(value)) output[key] = value;
          break;
        }
        case "boolean":
          if (typeof first === "boolean") output[key] = first;
          else if (typeof first === "string" && /^(true|false)$/i.test(first))
            output[key] = first.toLowerCase() === "true";
          break;
        default:
          if (typeof first === "string") output[key] = first;
      }
    }
    return output;
  };

  const session = {
    create: async (args: Json = {}, options?: RequestOptions) => {
      const result = await request<{ data: unknown }>(
        "/session",
        {
          method: "POST",
          body: json({
            ...(args.id === undefined ? {} : { id: args.id }),
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(typeof args.agent === "string" ? { agent: args.agent } : {}),
            ...(modelRef(args.model) ? { model: modelRef(args.model) } : {}),
            ...(permissionRules(args.permission ?? args.permissions)
              ? { permissions: permissionRules(args.permission ?? args.permissions) }
              : {}),
            location: { directory: input.directory },
          }),
        },
        options,
      );
      return { data: toOpenCodeV1Session(result.data) };
    },
    get: async (args: Json, options?: RequestOptions) => {
      const result = await request<{ data: unknown }>(
        `/session/${encodeURIComponent(String(args.sessionID))}`,
        {},
        options,
      );
      return { data: toOpenCodeV1Session(result.data) };
    },
    update: (args: Json, options?: RequestOptions) =>
      request(
        `/session/${encodeURIComponent(String(args.sessionID))}`,
        {
          method: "PATCH",
          body: json({
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(permissionRules(args.permission ?? args.permissions)
              ? { permissions: permissionRules(args.permission ?? args.permissions) }
              : {}),
          }),
        },
        options,
      ),
    fork: (args: Json, options?: RequestOptions) =>
      request(
        `/session/${encodeURIComponent(String(args.sessionID))}/fork`,
        {
          method: "POST",
          body: json(args.messageID === undefined ? {} : { before: args.messageID }),
        },
        options,
      ),
    messages: async (args: Json, options?: RequestOptions) => {
      const sessionID = encodeURIComponent(String(args.sessionID));
      const messages: unknown[] = [];
      let cursor: string | null | undefined;
      do {
        const result = await request<{
          data: ReadonlyArray<unknown>;
          cursor?: { next?: string | null };
        }>(
          `/session/${sessionID}/message${cursor ? `?cursor=${encodeURIComponent(cursor)}` : "?order=asc"}`,
          {},
          options,
        );
        messages.push(...result.data);
        cursor = result.cursor?.next;
      } while (cursor);
      return {
        data: messages
          .map((entry) => toOpenCodeV1MessageEntry(entry, String(args.sessionID)))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
      };
    },
    message: async (args: Json, options?: RequestOptions) => {
      const result = await request<{ data: unknown }>(
        `/session/${encodeURIComponent(String(args.sessionID))}/message/${encodeURIComponent(String(args.messageID))}`,
        {},
        options,
      );
      return { data: toOpenCodeV1MessageEntry(result.data, String(args.sessionID)) };
    },
    children: async (args: Json, options?: RequestOptions) => {
      const children: Json[] = [];
      let cursor: string | null | undefined;
      do {
        const result = await request<{
          data: ReadonlyArray<Json>;
          cursor?: { next?: string | null };
        }>(
          scoped(
            `/session?parentID=${encodeURIComponent(String(args.sessionID))}&order=asc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
          {},
          options,
        );
        children.push(...result.data);
        cursor = result.cursor?.next;
      } while (cursor);
      return { data: children };
    },
    status: async (_args?: unknown, options?: RequestOptions) => {
      const result = await request<{ data: Record<string, { type?: string }> }>(
        "/session/active",
        {},
        options,
      );
      return {
        data: Object.fromEntries(
          Object.entries(result.data).map(([sessionID, status]) => [
            sessionID,
            { type: status.type === "running" ? "busy" : "idle" },
          ]),
        ),
      };
    },
    prompt: async (args: Json, options?: RequestOptions) => {
      const sessionID = encodeURIComponent(String(args.sessionID));
      const model = withVariant(modelRef(args.model), args.variant);
      if (model)
        await request(
          `/session/${sessionID}/model`,
          { method: "POST", body: json({ model }) },
          options,
        );
      if (typeof args.agent === "string")
        await request(
          `/session/${sessionID}/agent`,
          { method: "POST", body: json({ agent: args.agent }) },
          options,
        );
      await setSystemInstruction(sessionID, args.system, options);
      const parts = filesFromParts(args.parts);
      await request(
        `/session/${sessionID}/prompt`,
        {
          method: "POST",
          body: json({
            ...(typeof args.messageID === "string" ? { id: args.messageID } : {}),
            text: parts.text,
            ...(parts.files.length ? { files: parts.files } : {}),
          }),
        },
        options,
      );
      await request(`/experimental/session/${sessionID}/wait`, { method: "POST" }, options);
      const result = await request<{ data: ReadonlyArray<unknown> }>(
        `/session/${sessionID}/message?order=desc`,
        {},
        options,
      );
      const assistant = result.data.find(
        (message) =>
          message && typeof message === "object" && (message as Json).type === "assistant",
      );
      const entry = toOpenCodeV1MessageEntry(assistant, String(args.sessionID));
      if (!entry) throw new Error("OpenCode v2 completed the prompt without an assistant message.");
      return { data: entry };
    },
    promptAsync: async (args: Json, options?: RequestOptions) => {
      const sessionID = encodeURIComponent(String(args.sessionID));
      const model = withVariant(modelRef(args.model), args.variant);
      if (model)
        await request(
          `/session/${sessionID}/model`,
          { method: "POST", body: json({ model }) },
          options,
        );
      if (typeof args.agent === "string")
        await request(
          `/session/${sessionID}/agent`,
          { method: "POST", body: json({ agent: args.agent }) },
          options,
        );
      await setSystemInstruction(sessionID, args.system, options);
      const parts = filesFromParts(args.parts);
      return request(
        `/session/${sessionID}/prompt`,
        {
          method: "POST",
          body: json({
            ...(typeof args.messageID === "string" ? { id: args.messageID } : {}),
            text: parts.text,
            ...(parts.files.length ? { files: parts.files } : {}),
          }),
        },
        options,
      );
    },
    command: async (args: Json, options?: RequestOptions) => {
      const sessionID = encodeURIComponent(String(args.sessionID));
      const model = withVariant(modelRef(args.model), args.variant);
      if (model)
        await request(
          `/session/${sessionID}/model`,
          { method: "POST", body: json({ model }) },
          options,
        );
      if (typeof args.agent === "string")
        await request(
          `/session/${sessionID}/agent`,
          { method: "POST", body: json({ agent: args.agent }) },
          options,
        );
      const parts = filesFromParts(args.parts);
      return request(
        `/session/${sessionID}/command`,
        {
          method: "POST",
          body: json({
            name: String(args.command ?? ""),
            text: typeof args.arguments === "string" ? args.arguments : parts.text,
            ...(parts.files.length ? { files: parts.files } : {}),
          }),
        },
        options,
      );
    },
    summarize: (args: Json, options?: RequestOptions) =>
      request(
        `/session/${encodeURIComponent(String(args.sessionID))}/compact`,
        { method: "POST", body: json({}) },
        options,
      ),
    abort: (args: Json, options?: RequestOptions) =>
      request(
        `/session/${encodeURIComponent(String(args.sessionID))}/interrupt`,
        { method: "POST" },
        options,
      ),
  };

  async function* eventStream(options?: RequestOptions): AsyncGenerator<unknown> {
    const response = await fetchImpl(`${baseUrl}/api/event`, {
      headers: { ...headers, Accept: "text/event-stream" },
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok || !response.body)
      throw makeHttpError(response, await response.json().catch(() => undefined));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const translator = makeOpenCodeV2EventTranslator();
    let pending = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        const blocks = pending.split(/\r?\n\r?\n/);
        pending = blocks.pop() ?? "";
        for (const block of blocks) {
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (!data) continue;
          rememberStreamRequest(data);
          for (const event of translator.toOpenCodeV1Events(data)) yield event;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  const client = {
    global: {
      health: async (args?: RequestOptions) => {
        const info = await request<Json>("/info", {}, args);
        return { data: { healthy: true, version: info.version } };
      },
    },
    event: {
      subscribe: (_args?: unknown, options?: RequestOptions) =>
        Promise.resolve({ stream: eventStream(options) }),
    },
    session,
    provider: {
      list: async (_args?: unknown, options?: RequestOptions) => {
        const [providers, models] = await Promise.all([
          request<{ data: ReadonlyArray<unknown> }>(scoped("/provider"), {}, options),
          request<{ data: ReadonlyArray<unknown> }>(scoped("/model"), {}, options),
        ]);
        const convertedModels = models.data
          .filter(
            (model) => !model || typeof model !== "object" || (model as Json).enabled !== false,
          )
          .map(toOpenCodeV1Model)
          .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
        const all = providers.data.flatMap((provider) => {
          const converted = toOpenCodeV1Provider(provider);
          if (!converted) return [];
          const providerID = converted.id;
          const models = Object.fromEntries(
            convertedModels
              .filter((model) => model.providerID === providerID)
              .map((model) => [model.id as string, model]),
          );
          return [{ ...converted, models }];
        });
        return {
          data: {
            all,
            connected: all.flatMap((provider) =>
              Object.keys(provider.models as Json).length > 0 ? [provider.id] : [],
            ),
            default: {},
          },
        };
      },
    },
    model: {
      list: async (_args?: unknown, options?: RequestOptions) => {
        const result = await request<{ data: ReadonlyArray<unknown> }>(
          scoped("/model"),
          {},
          options,
        );
        return {
          data: result.data
            .map(toOpenCodeV1Model)
            .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
        };
      },
    },
    agent: {
      list: (_args?: unknown, options?: RequestOptions) => request(scoped("/agent"), {}, options),
    },
    app: {
      agents: (_args?: unknown, options?: RequestOptions) => request(scoped("/agent"), {}, options),
      skills: async (_args?: unknown, options?: RequestOptions) => {
        const result = await request<{ data: ReadonlyArray<unknown> }>(
          scoped("/skill"),
          {},
          options,
        );
        return {
          data: result.data.map((skill) =>
            skill && typeof skill === "object"
              ? { ...(skill as Json), location: (skill as Json).path }
              : skill,
          ),
        };
      },
    },
    command: {
      list: async (_args?: unknown, options?: RequestOptions) => {
        const result = await request<{ data: ReadonlyArray<unknown> }>(
          scoped("/command"),
          {},
          options,
        );
        return {
          data: result.data.flatMap((command) =>
            command && typeof command === "object" && typeof (command as Json).name === "string"
              ? [{ ...(command as Json), source: "command", hints: [] }]
              : [],
          ),
        };
      },
    },
    mcp: {
      add: (args: Json, options?: RequestOptions) =>
        request(
          scoped(`/experimental/mcp/${encodeURIComponent(String(args.name ?? args.server ?? ""))}`),
          { method: "PUT", body: json({ config: args.config ?? args }) },
          options,
        ),
    },
    permission: {
      list: async (_args?: unknown, options?: RequestOptions) => {
        const result = await request<{ data: ReadonlyArray<unknown> }>(
          scoped("/permission/request"),
          {},
          options,
        );
        return rememberSessionIds(
          {
            data: result.data
              .map(toOpenCodeV1PermissionRequest)
              .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
          },
          permissionSessions,
        );
      },
      reply: (args: Json, options?: RequestOptions) => {
        const sessionID =
          typeof args.sessionID === "string"
            ? args.sessionID
            : permissionSessions.get(String(args.requestID));
        if (!sessionID)
          throw new Error(`OpenCode v2 permission ${String(args.requestID)} has no known session.`);
        return request(
          `/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(String(args.requestID))}/reply`,
          { method: "POST", body: json({ decision: args.reply }) },
          options,
        );
      },
    },
    question: {
      list: async (_args?: unknown, options?: RequestOptions) => {
        const result = await request<{ data: ReadonlyArray<unknown> }>(
          scoped("/form"),
          {},
          options,
        );
        for (const form of result.data) rememberForm(form);
        return rememberSessionIds(
          {
            data: result.data
              .map(toOpenCodeV1QuestionRequestFromForm)
              .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
          },
          formSessions,
        );
      },
      reply: (args: Json, options?: RequestOptions) => {
        const sessionID =
          typeof args.sessionID === "string"
            ? args.sessionID
            : formSessions.get(String(args.requestID));
        if (!sessionID)
          throw new Error(`OpenCode v2 form ${String(args.requestID)} has no known session.`);
        const answer = formAnswer(String(args.requestID), args.answers);
        return request(
          `/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(String(args.requestID))}/reply`,
          { method: "POST", body: json({ answer }) },
          options,
        );
      },
    },
  };
  return client as unknown as OpencodeClient;
}
