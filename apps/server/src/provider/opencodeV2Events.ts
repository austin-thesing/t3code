/**
 * Compatibility projection for OpenCode 2.x's durable-event stream. The
 * OpenCode adapter consumes the pre-2.0 SDK event vocabulary; keep that
 * adapter stable while the transport chooses the appropriate protocol.
 */
import type { Event as OpenCodeEvent, Model, Provider } from "@opencode-ai/sdk/v2";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function array(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

/** Parse the JSON payload carried by a v2 SSE `data:` field. */
export function parseOpenCodeV2SseData(input: unknown): unknown | undefined {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

function eventPayload(input: unknown): RecordValue | undefined {
  const parsed = parseOpenCodeV2SseData(input);
  const outer = record(parsed);
  if (!outer) return undefined;
  // Effect's SSE envelope is { id, event, data }, while an OpenCode event is
  // { id, type, data }. Only unwrap the former.
  if (typeof outer.event === "string") return record(parseOpenCodeV2SseData(outer.data));
  return outer;
}

function sessionInfo(data: RecordValue): RecordValue {
  const location = record(data.location);
  return {
    id: text(data.sessionID),
    parentID: typeof data.parentID === "string" ? data.parentID : undefined,
    title: text(data.title, "New session"),
    directory: text(location?.directory),
    time: { created: number(data.created), updated: number(data.created) },
  };
}

function toolContent(value: unknown): string {
  return array(value)
    .map((item) => {
      const content = record(item);
      if (!content) return "";
      return content.type === "text" ? text(content.text) : text(content.uri);
    })
    .filter(Boolean)
    .join("\n");
}

function toolTextContent(value: unknown): string {
  return array(value)
    .map((item) => {
      const content = record(item);
      return content?.type === "text" ? text(content.text) : "";
    })
    .filter(Boolean)
    .join("\n");
}

function legacyFileParts(files: unknown, sessionID: string, messageID: string): Array<RecordValue> {
  return array(files).flatMap((file, index) => {
    const value = record(file);
    if (!value || typeof value.mime !== "string") return [];
    const source = record(value.source);
    const uri =
      typeof source?.uri === "string"
        ? source.uri
        : typeof value.data === "string"
          ? `data:${value.mime};base64,${value.data}`
          : undefined;
    if (!uri) return [];
    return [
      {
        id: `${messageID}:file:${index}`,
        sessionID,
        messageID,
        type: "file",
        mime: value.mime,
        ...(typeof value.name === "string" ? { filename: value.name } : {}),
        url: uri,
      },
    ];
  });
}

function legacyToolAttachments(
  content: unknown,
  sessionID: string,
  messageID: string,
  callID: string,
): Array<RecordValue> {
  return array(content).flatMap((item, index) => {
    const value = record(item);
    if (
      !value ||
      value.type !== "file" ||
      typeof value.uri !== "string" ||
      typeof value.mime !== "string"
    ) {
      return [];
    }
    return [
      {
        id: `${callID}:file:${index}`,
        sessionID,
        messageID,
        type: "file",
        mime: value.mime,
        ...(typeof value.name === "string" ? { filename: value.name } : {}),
        url: value.uri,
      },
    ];
  });
}

function formQuestions(form: RecordValue): ReadonlyArray<RecordValue> {
  return array(form.fields).map((field) => {
    const value = record(field) ?? {};
    return {
      header: text(value.title, text(value.key, "Question")),
      question: text(value.description, text(value.title, text(value.key, "Question"))),
      options: array(value.options).map((option) => {
        const item = record(option) ?? {};
        return { label: text(item.label, text(item.value)), description: text(item.description) };
      }),
      ...(value.type === "multiselect" ? { multiple: true } : {}),
      ...(value.custom === true ? { custom: true } : {}),
    };
  });
}

/** Project a released v2 session record into the legacy SDK session shape. */
export function toOpenCodeV1Session(input: unknown): RecordValue | undefined {
  const value = record(input);
  if (!value || typeof value.id !== "string") return undefined;
  const location = record(value.location);
  const time = record(value.time);
  const model = record(value.model);
  return {
    id: value.id,
    slug: text(value.slug, value.id),
    projectID: text(value.projectID),
    directory: text(location?.directory),
    parentID: typeof value.parentID === "string" ? value.parentID : undefined,
    title: text(value.title, "New session"),
    agent: typeof value.agent === "string" ? value.agent : undefined,
    model: model
      ? {
          id: text(model.id),
          providerID: text(model.providerID),
          ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
        }
      : undefined,
    metadata: record(value.metadata),
    permission: array(value.permissions).map((rule) => {
      const entry = record(rule) ?? {};
      return {
        permission: text(entry.action),
        pattern: text(entry.resource),
        action: entry.effect,
      };
    }),
    cost: number(value.cost, 0),
    tokens: record(value.tokens) ?? {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: number(time?.created), updated: number(time?.updated) },
  };
}

/** Project a released v2 provider record into the old provider inventory entry. */
export function toOpenCodeV1Provider(
  input: unknown,
): (Provider & { disabled: boolean }) | undefined {
  const value = record(input);
  if (!value || typeof value.id !== "string") return undefined;
  return {
    id: value.id,
    name: text(value.name, value.id),
    disabled: value.activation === "disabled",
    source: "config",
    env: [],
    options: {},
    models: {},
  };
}

/** Project a released v2 model record into the old provider-model shape. */
export function toOpenCodeV1Model(input: unknown): (Model & { enabled: boolean }) | undefined {
  const value = record(input);
  if (!value || typeof value.id !== "string" || typeof value.providerID !== "string")
    return undefined;
  const capabilities = record(value.capabilities) ?? {};
  const limit = record(value.limit) ?? {};
  const cost = record(array(value.cost).find((item) => !record(item)?.tier)) ?? {};
  const cache = record(cost.cache) ?? {};
  const modalities = (value: unknown) => ({
    text: array(value).includes("text"),
    image: array(value).includes("image"),
    audio: array(value).includes("audio"),
    video: array(value).includes("video"),
    pdf: array(value).includes("pdf"),
  });
  return {
    id: value.id,
    providerID: value.providerID,
    ...(typeof value.family === "string" ? { family: value.family } : {}),
    name: text(value.name, value.id),
    api: { id: text(value.modelID, value.id), url: "", npm: "" },
    capabilities: {
      temperature: false,
      attachment: array(capabilities.input).some((item) => item !== "text"),
      reasoning: array(value.variants).length > 0,
      toolcall: capabilities.tools === true,
      input: modalities(capabilities.input),
      output: modalities(capabilities.output),
      interleaved: false,
    },
    variants: Object.fromEntries(
      array(value.variants).flatMap((variant) => {
        const item = record(variant);
        return typeof item?.id === "string" ? [[item.id, record(item.settings) ?? {}]] : [];
      }),
    ),
    cost: {
      input: number(cost.input, 0),
      output: number(cost.output, 0),
      cache: {
        read: number(cache.read, 0),
        write: number(cache.write, 0),
      },
    },
    status:
      value.status === "alpha" || value.status === "beta" || value.status === "deprecated"
        ? value.status
        : "active",
    enabled: value.enabled !== false,
    limit: {
      context: number(limit.context, 0),
      ...(typeof limit.input === "number" ? { input: limit.input } : {}),
      output: number(limit.output, 0),
    },
    options: {},
    headers: {},
    release_date: "",
  };
}

/** Project a v2 permission request into the legacy approval request schema. */
export function toOpenCodeV1PermissionRequest(input: unknown): RecordValue | undefined {
  const value = record(input);
  if (!value || typeof value.id !== "string" || typeof value.sessionID !== "string")
    return undefined;
  const source = record(value.source);
  return {
    id: value.id,
    sessionID: value.sessionID,
    permission: text(value.action),
    patterns: array(value.resources).filter((item): item is string => typeof item === "string"),
    always: array(value.save).filter((item): item is string => typeof item === "string"),
    metadata: record(value.metadata) ?? {},
    ...(source?.type === "tool"
      ? { tool: { messageID: text(source.messageID), callID: text(source.id) } }
      : {}),
  };
}

/** Project a v2 form into the legacy question request schema. */
export function toOpenCodeV1QuestionRequestFromForm(input: unknown): RecordValue | undefined {
  const form = record(input);
  if (!form || typeof form.id !== "string" || typeof form.sessionID !== "string") return undefined;
  return { id: form.id, sessionID: form.sessionID, questions: formQuestions(form) };
}

/** Project a persisted v2 message into the old `{ info, parts }` entry used on resume/fork. */
export function toOpenCodeV1MessageEntry(
  input: unknown,
  fallbackSessionID?: string,
): { readonly info: RecordValue; readonly parts: Array<RecordValue> } | undefined {
  const value = record(input);
  if (!value || typeof value.id !== "string" || typeof value.type !== "string") return undefined;
  const sessionID = text(value.sessionID, fallbackSessionID);
  if (value.type === "user") {
    const time = record(value.time);
    return {
      info: {
        id: value.id,
        sessionID,
        role: "user",
        time: { created: number(time?.created) },
        ...(typeof value.agent === "string" ? { agent: value.agent } : {}),
      },
      parts: [
        {
          id: `${value.id}:text`,
          sessionID,
          messageID: value.id,
          type: "text",
          text: text(value.text),
          time: { start: number(time?.created) },
        },
        ...legacyFileParts(value.files, sessionID, value.id),
      ],
    };
  }
  if (value.type !== "assistant") return undefined;
  const messageID = value.id;
  const messageTime = record(value.time);
  const model = record(value.model);
  const tokens = record(value.tokens) ?? {};
  const parts = array(value.content).flatMap<RecordValue>((content, index) => {
    const item = record(content) ?? {};
    const id = `${value.id}:${index}`;
    if (item.type === "text" || item.type === "reasoning")
      return [
        {
          id,
          sessionID,
          messageID: value.id,
          type: item.type,
          text: text(item.text),
          time: { start: number(record(value.time)?.created) },
        },
      ];
    if (item.type !== "tool") return [];
    const state = record(item.state) ?? {};
    const status = text(state.status, "running");
    return [
      {
        id: text(item.id, id),
        sessionID,
        messageID: value.id,
        type: "tool",
        callID: text(item.id, id),
        tool: text(item.name, "tool"),
        state:
          status === "completed"
            ? {
                status,
                input: record(state.input) ?? {},
                output: toolTextContent(state.content),
                title: text(item.name, "tool"),
                metadata: record(state.metadata) ?? {},
                time: {
                  start: number(messageTime?.created),
                  end: number(messageTime?.completed),
                },
                attachments: legacyToolAttachments(
                  state.content,
                  sessionID,
                  messageID,
                  text(item.id, id),
                ),
              }
            : status === "error"
              ? {
                  status,
                  input: record(state.input) ?? {},
                  error: text(record(state.error)?.message, "Tool failed"),
                  metadata: record(state.metadata),
                  time: {
                    start: number(messageTime?.created),
                    end: number(messageTime?.completed),
                  },
                }
              : {
                  status: "running",
                  input: record(state.input) ?? {},
                  time: { start: number(messageTime?.created) },
                },
      },
    ];
  });
  return {
    info: {
      id: value.id,
      sessionID,
      role: "assistant",
      time: {
        created: number(messageTime?.created),
        ...(typeof messageTime?.completed === "number" ? { completed: messageTime.completed } : {}),
      },
      ...(typeof value.parentID === "string" ? { parentID: value.parentID } : {}),
      ...(typeof model?.id === "string" ? { modelID: model.id } : {}),
      ...(typeof model?.providerID === "string" ? { providerID: model.providerID } : {}),
      ...(typeof model?.variant === "string" ? { variant: model.variant } : {}),
      ...(typeof value.agent === "string" ? { agent: value.agent } : {}),
      ...(typeof value.finish === "string" ? { finish: value.finish } : {}),
      cost: number(value.cost),
      tokens: {
        input: number(tokens.input),
        output: number(tokens.output),
        reasoning: number(tokens.reasoning),
        cache: record(tokens.cache) ?? { read: 0, write: 0 },
      },
    },
    parts,
  };
}

/**
 * Project one released OpenCode v2 SSE event into the legacy SDK event(s)
 * consumed by `OpenCodeAdapter`. One v2 lifecycle event can require both a
 * synthetic assistant message and a legacy part update.
 */
type ToolMetadata = { readonly name: string; input: RecordValue };
type StepMetadata = {
  readonly parentID?: string;
  readonly agent?: string;
  readonly model?: RecordValue;
};
type StreamState = {
  readonly tools: Map<string, ToolMetadata>;
  readonly latestUserMessageBySession: Map<string, string>;
  readonly steps: Map<string, StepMetadata>;
};

function toolKey(sessionID: string, messageID: string, id: string) {
  return `${sessionID}:${messageID}:${id}`;
}

function convertOpenCodeV2Events(input: unknown, state: StreamState): ReadonlyArray<OpenCodeEvent> {
  const event = eventPayload(input);
  if (!event) return [];
  const type = text(event.type);
  // Several legacy events can represent one v2 lifecycle event. Preserve the
  // upstream id on each projection so diagnostics remain correlated.
  const legacy = (legacyType: string, properties: RecordValue): OpenCodeEvent =>
    ({ id: text(event.id, `v2:${legacyType}`), type: legacyType, properties }) as OpenCodeEvent;
  const data = record(event.data) ?? {};
  const sessionID = text(data.sessionID);
  const created = number(event.created);

  switch (type) {
    case "server.connected":
      return [legacy("server.connected", {})];
    case "session.status":
      return [legacy(type, { sessionID, status: data.status })];
    case "session.idle":
      return [legacy(type, { sessionID })];
    case "session.created":
      return [legacy(type, { sessionID, info: sessionInfo(data) })];
    case "session.renamed":
      return [
        legacy("session.updated", { sessionID, info: { id: sessionID, title: text(data.title) } }),
      ];
    case "session.deleted":
      return [legacy(type, { sessionID, info: { id: sessionID } })];
    case "session.execution.failed":
      return [legacy("session.error", { sessionID, error: { data: record(data.error) ?? {} } })];
    case "session.execution.started":
      return [legacy("session.status", { sessionID, status: { type: "busy" } })];
    case "session.execution.succeeded":
    case "session.execution.interrupted":
      return [legacy("session.status", { sessionID, status: { type: "idle" } })];
    case "session.compaction.ended":
      return [legacy("session.compacted", { sessionID })];
    case "session.retry.scheduled":
      return [
        legacy("session.status", {
          sessionID,
          status: {
            type: "retry",
            attempt: number(data.attempt, 0),
            message: text(record(data.error)?.message),
            next: number(data.at, created),
          },
        }),
      ];
    case "session.step.started": {
      const messageID = text(data.assistantMessageID);
      const model = record(data.model);
      const parentID = state.latestUserMessageBySession.get(sessionID);
      const step: StepMetadata = {
        ...(parentID ? { parentID } : {}),
        ...(typeof data.agent === "string" ? { agent: data.agent } : {}),
        ...(model ? { model } : {}),
      };
      state.steps.set(toolKey(sessionID, messageID, "step"), step);
      return [
        legacy("message.updated", {
          sessionID,
          info: { id: messageID, role: "assistant", ...step },
        }),
        legacy("message.part.updated", {
          sessionID,
          time: created,
          part: { id: `step:${messageID}`, sessionID, messageID, type: "step-start" },
        }),
      ];
    }
    case "session.step.ended":
    case "session.step.failed": {
      const messageID = text(data.assistantMessageID);
      const step = state.steps.get(toolKey(sessionID, messageID, "step"));
      const tokens = record(data.tokens) ?? {};
      state.steps.delete(toolKey(sessionID, messageID, "step"));
      return [
        legacy("message.updated", {
          sessionID,
          info: { id: messageID, role: "assistant", ...step },
        }),
        legacy("message.part.updated", {
          sessionID,
          time: created,
          part: {
            id: `step:${messageID}`,
            sessionID,
            messageID,
            type: "step-finish",
            reason: type.endsWith("failed") ? "error" : text(data.finish),
            cost: number(data.cost, 0),
            tokens: {
              input: number(tokens.input, 0),
              output: number(tokens.output, 0),
              reasoning: number(tokens.reasoning, 0),
              cache: record(tokens.cache) ?? { read: 0, write: 0 },
            },
          },
        }),
      ];
    }
    case "session.text.started":
    case "session.reasoning.started": {
      const messageID = text(data.assistantMessageID);
      const partID = `${type}:${messageID}:${number(data.ordinal, 0)}`;
      return [
        legacy("message.part.updated", {
          sessionID,
          time: created,
          part: {
            id: partID,
            sessionID,
            messageID,
            type: type.includes("reasoning") ? "reasoning" : "text",
            text: "",
            time: { start: created },
          },
        }),
      ];
    }
    case "session.text.delta":
    case "session.reasoning.delta": {
      const messageID = text(data.assistantMessageID);
      return [
        legacy("message.part.delta", {
          sessionID,
          messageID,
          partID: `${type.replace(".delta", ".started")}:${messageID}:${number(data.ordinal, 0)}`,
          field: "text",
          delta: text(data.delta),
        }),
      ];
    }
    case "session.text.ended":
    case "session.reasoning.ended": {
      const messageID = text(data.assistantMessageID);
      return [
        legacy("message.part.updated", {
          sessionID,
          time: created,
          part: {
            id: `${type.replace(".ended", ".started")}:${messageID}:${number(data.ordinal, 0)}`,
            sessionID,
            messageID,
            type: type.includes("reasoning") ? "reasoning" : "text",
            text: text(data.text),
            time: { start: created, end: created },
          },
        }),
      ];
    }
    case "session.tool.input.started": {
      const messageID = text(data.assistantMessageID);
      const id = text(data.id);
      state.tools.set(toolKey(sessionID, messageID, id), { name: text(data.name, id), input: {} });
      return [
        legacy("message.part.updated", {
          sessionID,
          time: created,
          part: {
            id,
            sessionID,
            messageID,
            type: "tool",
            callID: id,
            tool: text(data.name, id),
            state: { status: "pending", input: {}, raw: "" },
          },
        }),
      ];
    }
    case "session.tool.input.delta":
      return [];
    case "session.tool.input.ended": {
      const messageID = text(data.assistantMessageID);
      const id = text(data.id);
      const key = toolKey(sessionID, messageID, id);
      const prior = state.tools.get(key) ?? { name: id, input: {} };
      try {
        const parsed = JSON.parse(text(data.text)) as unknown;
        prior.input = record(parsed) ?? {};
      } catch {
        // The legacy adapter can still show a running tool when a provider's
        // raw tool input is not JSON.
      }
      state.tools.set(key, prior);
      return [];
    }
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed": {
      const messageID = text(data.assistantMessageID);
      const id = text(data.id);
      const key = toolKey(sessionID, messageID, id);
      const prior = state.tools.get(key) ?? { name: id, input: {} };
      const input = record(data.input) ?? prior.input;
      const name = text(data.name, prior.name);
      state.tools.set(key, { name, input });
      const status = type.endsWith("success")
        ? "completed"
        : type.endsWith("failed")
          ? "error"
          : "running";
      const toolState =
        status === "completed"
          ? {
              status,
              input,
              output: toolContent(data.content),
              title: name,
              metadata: record(data.metadata) ?? {},
              time: { start: created, end: created },
            }
          : status === "error"
            ? {
                status,
                input,
                error: text(record(data.error)?.message, "Tool failed"),
                metadata: record(data.metadata),
                time: { start: created, end: created },
              }
            : {
                status,
                input,
                title: name,
                metadata: record(data.metadata),
                time: { start: created },
              };
      if (status !== "running") state.tools.delete(key);
      return [
        legacy("message.part.updated", {
          sessionID,
          time: created,
          part: {
            id,
            sessionID,
            messageID,
            type: "tool",
            callID: id,
            tool: name,
            state: toolState,
          },
        }),
      ];
    }
    case "permission.asked":
      return [
        legacy(type, {
          id: text(data.id),
          sessionID,
          permission: text(data.action),
          patterns: array(data.resources).filter(
            (value): value is string => typeof value === "string",
          ),
          always: array(data.save).filter((value): value is string => typeof value === "string"),
          metadata: record(data.metadata) ?? {},
          ...(record(data.source)?.type === "tool"
            ? {
                tool: {
                  messageID: text(record(data.source)?.messageID),
                  callID: text(record(data.source)?.id),
                },
              }
            : {}),
        }),
      ];
    case "permission.replied":
      return [legacy(type, { sessionID, requestID: text(data.requestID), reply: data.reply })];
    case "session.inbox.enqueued":
    case "session.inbox.delivered": {
      const messageID = text(data.inboxID);
      const item = record(data.item);
      if (item?.type !== "user") return [];
      state.latestUserMessageBySession.set(sessionID, messageID);
      return [legacy("message.updated", { sessionID, info: { id: messageID, role: "user" } })];
    }
    case "form.created": {
      const form = record(data.form) ?? {};
      return [
        legacy("question.asked", {
          id: text(form.id),
          sessionID: text(form.sessionID),
          questions: formQuestions(form),
        }),
      ];
    }
    case "form.replied":
      return [
        legacy("question.replied", {
          sessionID,
          requestID: text(data.id),
          answers: Object.values(record(data.answer) ?? {}).map((value) =>
            Array.isArray(value)
              ? value.filter((entry): entry is string => typeof entry === "string")
              : [String(value)],
          ),
        }),
      ];
    case "form.cancelled":
      return [legacy("question.rejected", { sessionID, requestID: text(data.id) })];
    default:
      return [];
  }
}

export interface OpenCodeV2EventTranslator {
  readonly toOpenCodeV1Events: (input: unknown) => ReadonlyArray<OpenCodeEvent>;
}

/** Keep tool metadata across v2's split input/called/terminal events. */
export function makeOpenCodeV2EventTranslator(): OpenCodeV2EventTranslator {
  const state: StreamState = {
    tools: new Map(),
    latestUserMessageBySession: new Map(),
    steps: new Map(),
  };
  return { toOpenCodeV1Events: (input) => convertOpenCodeV2Events(input, state) };
}

/** Stateless convenience for tests and one-off event conversion. Use the factory for an SSE stream. */
export function toOpenCodeV1Events(input: unknown): ReadonlyArray<OpenCodeEvent> {
  return convertOpenCodeV2Events(input, {
    tools: new Map(),
    latestUserMessageBySession: new Map(),
    steps: new Map(),
  });
}
