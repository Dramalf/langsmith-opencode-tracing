/**
 * Core tracer: owns the translation from opencode events to LangSmith
 * runs. Called from the plugin dispatcher in `index.ts`.
 */

import { RunTree, uuid7 } from "langsmith";
import type { Config } from "./config.js";
import type {
  AssistantMessageInfo,
  CompactionPart,
  MessageInfo,
  Part,
  ReasoningPart,
  StepFinishPart,
  TextPart,
  ToolPart,
  UserMessageInfo,
} from "./types.js";
import {
  getClient,
  getReplicas,
  generateDottedOrderSegment,
  parseDottedOrder,
  toIso,
  flushPendingTraces,
} from "./langsmith.js";
import {
  getOrCreateSession,
  getSession,
  type AssistantRunState,
  type SessionState,
  type ToolRunState,
  type TurnState,
} from "./state.js";
import {
  ASSISTANT_RUN_NAME,
  COMPACTION_RUN_NAME,
  LS_INTEGRATION,
  USER_PROMPT_TURN_NAME,
} from "./constants.js";
import * as logger from "./logger.js";

let config: Config | undefined;

export function setConfig(c: Config): void {
  config = c;
}

function getConfig(): Config {
  if (!config) throw new Error("Tracer not initialised — call setConfig first");
  return config;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function newRunTree(cfg: ConstructorParameters<typeof RunTree>[0]): RunTree {
  return new RunTree({
    client: getClient(),
    replicas: getReplicas(),
    ...cfg,
  });
}

function baseMetadata(sessionID: string): Record<string, unknown> {
  return {
    thread_id: sessionID,
    ls_integration: LS_INTEGRATION,
    ...(getConfig().customMetadata ?? {}),
  };
}

function buildUsageMetadata(a: AssistantRunState): Record<string, unknown> | undefined {
  const input_tokens = a.tokens.input + a.tokens.cacheRead + a.tokens.cacheWrite;
  const output_tokens = a.tokens.output;
  const total_tokens = input_tokens + output_tokens;
  if (total_tokens === 0) return undefined;
  return {
    input_tokens,
    output_tokens,
    total_tokens,
    input_token_details: {
      cache_read: a.tokens.cacheRead,
      cache_creation: a.tokens.cacheWrite,
    },
    ...(a.tokens.reasoning > 0
      ? { output_token_details: { reasoning: a.tokens.reasoning } }
      : {}),
  };
}

function accumulatedTextContent(a: AssistantRunState): string {
  return Array.from(a.textParts.values()).join("");
}

function accumulatedReasoning(a: AssistantRunState): string {
  return Array.from(a.reasoningParts.values()).join("");
}

function buildAssistantOutput(
  a: AssistantRunState,
  turn: TurnState,
): { messages: Array<Record<string, unknown>> } {
  const content: Array<Record<string, unknown>> = [];
  const reasoning = accumulatedReasoning(a);
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  const text = accumulatedTextContent(a);
  if (text) content.push({ type: "text", text });
  for (const callId of a.toolCallIds) {
    const tool = turn.tools.get(callId);
    if (!tool) continue;
    content.push({
      type: "tool_call",
      id: tool.callID,
      name: tool.toolName,
      args: tool.input,
    });
  }
  return { messages: [{ role: "assistant", content }] };
}

// ─── Turn lifecycle ─────────────────────────────────────────────────────────

interface InitialUserPayload {
  content: string;
  files: Array<{ mime: string; url: string; filename?: string }>;
}

/**
 * Extract text and file parts from a Part[] delivered by `chat.message`.
 * Used so the Turn's inputs are populated at post-time, without waiting
 * for streaming `message.part.updated` events (which may never fire for
 * a CLI-submitted prompt).
 */
function extractInitialUserPayload(parts: readonly Part[]): InitialUserPayload {
  const textFragments: string[] = [];
  const files: InitialUserPayload["files"] = [];
  for (const part of parts) {
    if (part.type === "text") {
      const tp = part as TextPart;
      if (tp.synthetic || tp.ignored) continue;
      if (tp.text) textFragments.push(tp.text);
    } else if (part.type === "file") {
      const fp = part as unknown as {
        mime: string;
        url: string;
        filename?: string;
      };
      files.push({ mime: fp.mime, url: fp.url, filename: fp.filename });
    }
  }
  return { content: textFragments.join(""), files };
}

/** Called when a new user message is observed — creates a Turn chain run. */
async function startTurn(
  session: SessionState,
  user: UserMessageInfo,
  initial?: InitialUserPayload,
): Promise<TurnState> {
  const cfg = getConfig();
  const startTime = toIso(user.time.created);
  const runId = uuid7();
  const segment = generateDottedOrderSegment(startTime, runId);

  let traceId: string;
  let parentRunId: string | undefined;
  let dottedOrder: string;
  if (cfg.parentDottedOrder) {
    const parsed = parseDottedOrder(cfg.parentDottedOrder);
    traceId = parsed.traceId;
    parentRunId = parsed.runId;
    dottedOrder = `${cfg.parentDottedOrder}.${segment}`;
  } else {
    traceId = runId;
    dottedOrder = segment;
  }

  session.turnCount += 1;
  const turn: TurnState = {
    runId,
    dottedOrder,
    traceId,
    parentRunId,
    startTime,
    userMessageID: user.id,
    userContent: initial?.content ?? "",
    userFiles: initial?.files ? [...initial.files] : [],
    agent: user.agent,
    model: user.model,
    turnNumber: session.turnCount,
    assistants: new Map(),
    tools: new Map(),
    assistantOrder: [],
  };
  session.currentTurn = turn;

  try {
    const runTree = newRunTree({
      id: runId,
      name: USER_PROMPT_TURN_NAME,
      run_type: "chain",
      inputs: {
        messages: [
          {
            role: "user",
            content: turn.userContent,
            ...(turn.userFiles.length > 0 ? { files: turn.userFiles } : {}),
          },
        ],
      },
      project_name: cfg.project,
      start_time: startTime,
      trace_id: traceId,
      dotted_order: dottedOrder,
      ...(parentRunId ? { parent_run_id: parentRunId } : {}),
      extra: {
        metadata: {
          ...baseMetadata(session.sessionID),
          turn_number: turn.turnNumber,
          agent: user.agent,
          user_message_id: user.id,
          ...(user.model
            ? {
                ls_provider: user.model.providerID,
                ls_model_name: user.model.modelID,
              }
            : {}),
          ...(user.variant ? { variant: user.variant } : {}),
        },
      },
    });
    await runTree.postRun();
    logger.debug(
      `Started turn ${turn.turnNumber} runId=${runId} for user=${user.id} content="${turn.userContent.slice(0, 60)}"`,
    );
  } catch (err) {
    logger.error(`Failed to post turn run: ${err}`);
  }

  return turn;
}

/** Patches the Turn run with final outputs + end_time. */
async function closeTurn(
  session: SessionState,
  turn: TurnState,
  endIso: string,
  errorMessage?: string,
): Promise<void> {
  const cfg = getConfig();
  try {
    const assistantMessages: Array<Record<string, unknown>> = [];
    for (const mid of turn.assistantOrder) {
      const a = turn.assistants.get(mid);
      if (!a) continue;
      const { messages } = buildAssistantOutput(a, turn);
      assistantMessages.push(...messages);
    }

    const finalUserContent = turn.userContent || "";

    const runTree = newRunTree({
      id: turn.runId,
      name: USER_PROMPT_TURN_NAME,
      run_type: "chain",
      project_name: cfg.project,
      start_time: turn.startTime,
      end_time: endIso,
      trace_id: turn.traceId,
      dotted_order: turn.dottedOrder,
      parent_run_id: turn.parentRunId,
      inputs: {
        messages: [
          {
            role: "user",
            content: finalUserContent,
            ...(turn.userFiles.length > 0 ? { files: turn.userFiles } : {}),
          },
        ],
      },
      outputs: { messages: assistantMessages },
      ...(errorMessage ? { error: errorMessage } : {}),
      extra: {
        metadata: {
          ...baseMetadata(session.sessionID),
          turn_number: turn.turnNumber,
          agent: turn.agent,
          ...(turn.model
            ? {
                ls_provider: turn.model.providerID,
                ls_model_name: turn.model.modelID,
              }
            : {}),
        },
      },
    });
    await runTree.patchRun();
    logger.debug(
      `Closed turn ${turn.turnNumber} runId=${turn.runId} status=${errorMessage ?? "ok"}`,
    );
  } catch (err) {
    logger.error(`Failed to close turn run: ${err}`);
  }
}

// ─── Assistant run lifecycle ────────────────────────────────────────────────

async function ensureAssistantRun(
  session: SessionState,
  turn: TurnState,
  info: AssistantMessageInfo,
): Promise<AssistantRunState> {
  let a = turn.assistants.get(info.id);
  if (a) {
    a.providerID = a.providerID ?? info.providerID;
    a.modelID = a.modelID ?? info.modelID;
    a.agent = a.agent ?? info.agent;
    return a;
  }

  const cfg = getConfig();
  const runId = uuid7();
  const startTime = toIso(info.time.created);
  const segment = generateDottedOrderSegment(startTime, runId);
  const dottedOrder = `${turn.dottedOrder}.${segment}`;

  a = {
    runId,
    dottedOrder,
    startTime,
    providerID: info.providerID,
    modelID: info.modelID,
    agent: info.agent,
    textParts: new Map(),
    reasoningParts: new Map(),
    toolCallIds: [],
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    cost: 0,
    posted: false,
    closed: false,
  };
  turn.assistants.set(info.id, a);
  turn.assistantOrder.push(info.id);

  try {
    const runTree = newRunTree({
      id: runId,
      name: ASSISTANT_RUN_NAME,
      run_type: "llm",
      inputs: { messages: [{ role: "user", content: turn.userContent }] },
      project_name: cfg.project,
      start_time: startTime,
      parent_run_id: turn.runId,
      trace_id: turn.traceId,
      dotted_order: dottedOrder,
      extra: {
        metadata: {
          ...baseMetadata(session.sessionID),
          ls_provider: info.providerID,
          ls_model_name: info.modelID,
          ls_invocation_params: { model: info.modelID },
          agent: info.agent,
          turn_number: turn.turnNumber,
        },
      },
    });
    await runTree.postRun();
    a.posted = true;
    logger.debug(
      `Created assistant run ${runId} for msg=${info.id} (${info.providerID}/${info.modelID})`,
    );
  } catch (err) {
    logger.error(`Failed to post assistant run: ${err}`);
  }

  return a;
}

async function closeAssistantRun(
  session: SessionState,
  turn: TurnState,
  info: AssistantMessageInfo,
  a: AssistantRunState,
): Promise<void> {
  if (a.closed) return;
  const cfg = getConfig();
  const endIso = toIso(info.time.completed ?? Date.now());
  a.endTime = endIso;
  a.finish = info.finish;
  a.tokens = {
    input: info.tokens.input ?? a.tokens.input,
    output: info.tokens.output ?? a.tokens.output,
    reasoning: info.tokens.reasoning ?? a.tokens.reasoning,
    cacheRead: info.tokens.cache?.read ?? a.tokens.cacheRead,
    cacheWrite: info.tokens.cache?.write ?? a.tokens.cacheWrite,
  };
  a.cost = info.cost ?? a.cost;
  a.error = info.error ?? a.error;

  const { messages } = buildAssistantOutput(a, turn);
  const errorMessage = extractErrorMessage(info.error);

  try {
    const runTree = newRunTree({
      id: a.runId,
      name: ASSISTANT_RUN_NAME,
      run_type: "llm",
      project_name: cfg.project,
      start_time: a.startTime,
      end_time: endIso,
      trace_id: turn.traceId,
      parent_run_id: turn.runId,
      dotted_order: a.dottedOrder,
      outputs: { messages },
      ...(errorMessage ? { error: errorMessage } : {}),
      extra: {
        metadata: {
          ...baseMetadata(session.sessionID),
          ls_provider: a.providerID,
          ls_model_name: a.modelID,
          ls_invocation_params: {
            model: a.modelID,
            ...(info.finish ? { finish_reason: info.finish } : {}),
          },
          usage_metadata: buildUsageMetadata(a),
          cost_usd: a.cost,
          agent: a.agent,
          turn_number: turn.turnNumber,
        },
      },
    });
    await runTree.patchRun({ excludeInputs: true });
    a.closed = true;
    logger.debug(`Closed assistant run ${a.runId} status=${errorMessage ?? "ok"}`);
  } catch (err) {
    logger.error(`Failed to close assistant run: ${err}`);
  }
}

function extractErrorMessage(err: unknown): string | undefined {
  if (!err) return undefined;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const e = err as { name?: string; message?: string; data?: { message?: string } };
    const name = e.name ?? "Error";
    const msg = e.message ?? e.data?.message;
    return msg ? `${name}: ${msg}` : name;
  }
  return String(err);
}

// ─── Tool run lifecycle ─────────────────────────────────────────────────────

function ensureToolRun(
  turn: TurnState,
  part: ToolPart,
  fallbackStart: number,
): ToolRunState {
  let t = turn.tools.get(part.callID);
  if (t) return t;

  const runId = uuid7();
  const startMs =
    (part.state.status === "running" || part.state.status === "completed" || part.state.status === "error")
      ? part.state.time.start
      : fallbackStart;
  const startIso = toIso(startMs);
  const segment = generateDottedOrderSegment(startIso, runId);
  const dottedOrder = `${turn.dottedOrder}.${segment}`;

  t = {
    runId,
    dottedOrder,
    callID: part.callID,
    toolName: part.tool,
    startTime: startIso,
    assistantMessageID: part.messageID,
    input: part.state.input ?? {},
    posted: false,
    closed: false,
  };
  turn.tools.set(part.callID, t);

  const a = turn.assistants.get(part.messageID);
  if (a && !a.toolCallIds.includes(part.callID)) {
    a.toolCallIds.push(part.callID);
  }

  return t;
}

async function postToolStart(
  session: SessionState,
  turn: TurnState,
  t: ToolRunState,
): Promise<void> {
  if (t.posted) return;
  const cfg = getConfig();
  try {
    const runTree = newRunTree({
      id: t.runId,
      name: t.toolName,
      run_type: "tool",
      inputs: { input: t.input },
      project_name: cfg.project,
      start_time: t.startTime,
      parent_run_id: turn.runId,
      trace_id: turn.traceId,
      dotted_order: t.dottedOrder,
      extra: {
        metadata: {
          ...baseMetadata(session.sessionID),
          tool_name: t.toolName,
          call_id: t.callID,
          assistant_message_id: t.assistantMessageID,
          turn_number: turn.turnNumber,
          ...(t.title ? { title: t.title } : {}),
        },
      },
    });
    await runTree.postRun();
    t.posted = true;
    logger.debug(`Posted tool run ${t.runId} (${t.toolName}) callID=${t.callID}`);
  } catch (err) {
    logger.error(`Failed to post tool run: ${err}`);
  }
}

async function closeToolRun(
  session: SessionState,
  turn: TurnState,
  t: ToolRunState,
): Promise<void> {
  if (t.closed) return;
  const cfg = getConfig();
  try {
    const runTree = newRunTree({
      id: t.runId,
      name: t.toolName,
      run_type: "tool",
      project_name: cfg.project,
      start_time: t.startTime,
      end_time: t.endTime ?? toIso(Date.now()),
      parent_run_id: turn.runId,
      trace_id: turn.traceId,
      dotted_order: t.dottedOrder,
      inputs: { input: t.input },
      outputs: { output: t.output ?? "" },
      ...(t.error ? { error: t.error } : {}),
      extra: {
        metadata: {
          ...baseMetadata(session.sessionID),
          tool_name: t.toolName,
          call_id: t.callID,
          assistant_message_id: t.assistantMessageID,
          turn_number: turn.turnNumber,
          ...(t.title ? { title: t.title } : {}),
          ...(t.metadata ?? {}),
        },
      },
    });
    await runTree.patchRun();
    t.closed = true;
    logger.debug(`Closed tool run ${t.runId} (${t.toolName}) status=${t.error ? "error" : "ok"}`);
  } catch (err) {
    logger.error(`Failed to close tool run: ${err}`);
  }
}

// ─── Public event handlers ──────────────────────────────────────────────────

/**
 * Called from the `chat.message` hook. We capture the full user prompt
 * text and attachments at submission time so the Turn run's inputs can
 * be posted with real content, rather than waiting on (possibly absent)
 * streaming `message.part.updated` events.
 */
export async function handleChatMessage(
  sessionID: string,
  user: UserMessageInfo,
  parts: readonly Part[],
): Promise<void> {
  const session = getOrCreateSession(sessionID);
  session.messageRoles.set(user.id, "user");
  const payload = extractInitialUserPayload(parts);

  // Also cache the parts so any later `message.part.updated`-based logic
  // (e.g. rebuilding user content) still works uniformly.
  for (const part of parts) {
    session.partCache.set(part.id, part);
  }

  if (session.currentTurn?.userMessageID === user.id) {
    const turn = session.currentTurn;
    if (!turn.userContent && payload.content) turn.userContent = payload.content;
    if (payload.files.length > 0) {
      for (const f of payload.files) {
        if (!turn.userFiles.some((existing) => existing.url === f.url)) {
          turn.userFiles.push(f);
        }
      }
    }
    return;
  }

  await maybeCloseStaleTurn(session);
  await startTurn(session, user, payload);
}

export async function handleMessageUpdated(info: MessageInfo): Promise<void> {
  const session = getOrCreateSession(info.sessionID);
  session.messageRoles.set(info.id, info.role);

  if (info.role === "user") {
    // Real user prompts always reach us first through the `chat.message`
    // hook (see handleChatMessage), which has the canonical Part[] and
    // starts the Turn. The bus-level `message.updated` for a user message
    // is therefore either:
    //   • a redundant echo of the turn we already started, OR
    //   • a synthetic user message (compaction, subtask, session resume
    //     replay of history) which should NOT surface as its own Turn.
    // In both cases we do nothing here — bailing out prevents the empty
    // "Interrupted" ghost turns that show up otherwise.
    if (session.currentTurn?.userMessageID === info.id) return;
    logger.debug(
      `Ignoring user message.updated ${info.id} — no matching chat.message; likely synthetic/replayed`,
    );
    return;
  }

  const turn = session.currentTurn;
  if (!turn) {
    logger.debug(
      `assistant message ${info.id} observed with no active turn, skipping`,
    );
    return;
  }
  const a = await ensureAssistantRun(session, turn, info);

  const completed =
    info.time.completed !== undefined || info.finish !== undefined || !!info.error;
  if (!completed) return;

  for (const callId of a.toolCallIds) {
    const t = turn.tools.get(callId);
    if (t && !t.closed) {
      await closeToolRun(session, turn, t);
    }
  }
  await closeAssistantRun(session, turn, info, a);

  // Decide whether this assistant message was the FINAL step of the turn
  // or just a "stop to call a tool" intermediate step. When the model
  // stops on `tool-calls` / `tool_use`, opencode will invoke the tools
  // and then continue with another assistant message nested under the
  // same parent user message. Closing the Turn here would drop that
  // continuation's content from the trace, so we only close the Turn
  // when this assistant's finish reason indicates a real terminal state.
  //
  // Errors always close the Turn (with the error propagated).
  if (turn.userMessageID !== info.parentID) return;

  const allToolsClosed = Array.from(turn.tools.values()).every((t) => t.closed);
  if (!allToolsClosed) {
    logger.debug(
      `Assistant ${info.id} completed but turn still has open tools — deferring close`,
    );
    return;
  }

  if (!info.error && isToolCallContinuation(info.finish)) {
    logger.debug(
      `Assistant ${info.id} finished with "${info.finish}" — waiting for continuation step`,
    );
    return;
  }

  const endIso = toIso(info.time.completed ?? Date.now());
  const errorMessage = extractErrorMessage(info.error);
  await closeTurn(session, turn, endIso, errorMessage);
  session.currentTurn = undefined;
  await flushPendingTraces();
}

/** True when the assistant stopped specifically to let a tool run (i.e. a continuation is expected). */
function isToolCallContinuation(finish: string | undefined): boolean {
  if (!finish) return false;
  const f = finish.toLowerCase();
  return (
    f === "tool_use" ||
    f === "tool-use" ||
    f === "tool-calls" ||
    f === "tool_calls" ||
    f === "tool"
  );
}

export async function handleMessagePartUpdated(
  part: Part,
  delta: string | undefined,
): Promise<void> {
  const session = getOrCreateSession(part.sessionID);
  session.partCache.set(part.id, part);
  let role = session.messageRoles.get(part.messageID);

  // Opencode may deliver part.updated events before message.updated has
  // flushed the role. Fall back to inferring from the part's type —
  // text/reasoning/tool/step-* parts are always assistant-owned in
  // practice; file parts belong to user messages; everything else is
  // treated as a no-op.
  if (!role) {
    if (
      part.type === "reasoning" ||
      part.type === "tool" ||
      part.type === "step-start" ||
      part.type === "step-finish"
    ) {
      role = "assistant";
    } else if (part.type === "file") {
      role = "user";
    }
  }

  if (role === "user") {
    handleUserPart(session, part);
    return;
  }

  if (role === "assistant") {
    await handleAssistantPart(session, part, delta);
    return;
  }

  logger.debug(
    `part.updated for unknown messageID=${part.messageID} (type=${part.type}), caching`,
  );
}

function handleUserPart(session: SessionState, part: Part): void {
  const turn = session.currentTurn;
  if (!turn || turn.userMessageID !== part.messageID) return;
  if (part.type === "text") {
    const tp = part as TextPart;
    if (tp.synthetic || tp.ignored) return;
    // Re-accumulate user content from all text parts we have seen so far.
    turn.userContent = collectUserText(session, turn.userMessageID);
  } else if (part.type === "file") {
    const fp = part as Part & { mime: string; url: string; filename?: string };
    if (!turn.userFiles.some((f) => f.url === fp.url)) {
      turn.userFiles.push({
        mime: fp.mime,
        url: fp.url,
        filename: fp.filename,
      });
    }
  }
}

function collectUserText(session: SessionState, userMessageID: string): string {
  const fragments: string[] = [];
  for (const part of session.partCache.values()) {
    if (part.messageID !== userMessageID) continue;
    if (part.type !== "text") continue;
    const tp = part as TextPart;
    if (tp.synthetic || tp.ignored) continue;
    fragments.push(tp.text ?? "");
  }
  return fragments.join("");
}

async function handleAssistantPart(
  session: SessionState,
  part: Part,
  delta: string | undefined,
): Promise<void> {
  const turn = session.currentTurn;
  if (!turn) return;

  const a = turn.assistants.get(part.messageID);
  if (!a) {
    // Assistant run not yet created — cache, will be attached when message.updated arrives.
    return;
  }

  switch (part.type) {
    case "text": {
      const tp = part as TextPart;
      if (tp.synthetic || tp.ignored) return;
      const prior = a.textParts.get(tp.id) ?? "";
      let next: string;
      if (delta !== undefined) {
        next = prior + delta;
      } else if (tp.text !== undefined) {
        next = tp.text;
      } else {
        next = prior;
      }
      a.textParts.set(tp.id, next);
      return;
    }
    case "reasoning": {
      const rp = part as ReasoningPart;
      const prior = a.reasoningParts.get(rp.id) ?? "";
      let next: string;
      if (delta !== undefined) {
        next = prior + delta;
      } else if (rp.text !== undefined) {
        next = rp.text;
      } else {
        next = prior;
      }
      a.reasoningParts.set(rp.id, next);
      return;
    }
    case "step-finish": {
      const sp = part as StepFinishPart;
      a.tokens.input += sp.tokens.input ?? 0;
      a.tokens.output += sp.tokens.output ?? 0;
      a.tokens.reasoning += sp.tokens.reasoning ?? 0;
      a.tokens.cacheRead += sp.tokens.cache?.read ?? 0;
      a.tokens.cacheWrite += sp.tokens.cache?.write ?? 0;
      a.cost += sp.cost ?? 0;
      return;
    }
    case "tool": {
      const tp = part as ToolPart;
      const tool = ensureToolRun(turn, tp, Date.now());
      if (tp.state.status === "running" || tp.state.status === "completed") {
        tool.input = tp.state.input ?? tool.input;
      }
      if (tp.state.status === "running") {
        tool.startTime = toIso(tp.state.time.start);
        if ((tp.state as { title?: string }).title) {
          tool.title = (tp.state as { title?: string }).title;
        }
        if (!tool.posted) await postToolStart(session, turn, tool);
      } else if (tp.state.status === "completed") {
        tool.startTime = toIso(tp.state.time.start);
        tool.endTime = toIso(tp.state.time.end);
        tool.output = tp.state.output;
        tool.title = tp.state.title ?? tool.title;
        tool.metadata = tp.state.metadata ?? tool.metadata;
        if (!tool.posted) await postToolStart(session, turn, tool);
        await closeToolRun(session, turn, tool);
      } else if (tp.state.status === "error") {
        tool.startTime = toIso(tp.state.time.start);
        tool.endTime = toIso(tp.state.time.end);
        tool.error = tp.state.error;
        tool.metadata = tp.state.metadata ?? tool.metadata;
        if (!tool.posted) await postToolStart(session, turn, tool);
        await closeToolRun(session, turn, tool);
      }
      return;
    }
    case "compaction": {
      const cp = part as CompactionPart;
      void handleInlineCompaction(session, cp);
      return;
    }
    default:
      return;
  }
}

async function handleInlineCompaction(
  session: SessionState,
  part: CompactionPart,
): Promise<void> {
  const cfg = getConfig();
  const endIso = toIso(Date.now());
  const startIso = session.compactionStartTime
    ? toIso(session.compactionStartTime)
    : endIso;
  const runId = uuid7();
  const segment = generateDottedOrderSegment(startIso, runId);
  const turn = session.currentTurn;
  const parentRunId = turn?.runId;
  const traceId = turn?.traceId ?? runId;
  const dottedOrder = turn ? `${turn.dottedOrder}.${segment}` : segment;

  try {
    const runTree = newRunTree({
      id: runId,
      name: `${COMPACTION_RUN_NAME} (${part.auto ? "auto" : "manual"})`,
      run_type: "chain",
      inputs: {},
      outputs: { overflow: part.overflow ?? false, auto: part.auto },
      project_name: cfg.project,
      start_time: startIso,
      end_time: endIso,
      trace_id: traceId,
      dotted_order: dottedOrder,
      ...(parentRunId ? { parent_run_id: parentRunId } : {}),
      extra: {
        metadata: {
          ...baseMetadata(session.sessionID),
          trigger: part.auto ? "auto" : "manual",
          overflow: part.overflow ?? false,
        },
      },
    });
    await runTree.postRun();
    logger.debug(`Posted inline compaction run ${runId}`);
  } catch (err) {
    logger.error(`Failed to post compaction run: ${err}`);
  } finally {
    session.compactionStartTime = undefined;
  }
}

// ─── Session-level events ──────────────────────────────────────────────────

export async function handleSessionIdle(sessionID: string): Promise<void> {
  const session = getSession(sessionID);
  if (!session) return;
  const turn = session.currentTurn;
  if (!turn) {
    await flushPendingTraces();
    return;
  }
  await closeOpenAssistantAndTools(session, turn);
  await closeTurn(session, turn, toIso(Date.now()));
  session.currentTurn = undefined;
  await flushPendingTraces();
}

async function maybeCloseStaleTurn(session: SessionState): Promise<void> {
  const turn = session.currentTurn;
  if (!turn) return;
  await closeOpenAssistantAndTools(session, turn);
  await closeTurn(session, turn, toIso(Date.now()), "Interrupted");
  session.currentTurn = undefined;
}

async function closeOpenAssistantAndTools(
  session: SessionState,
  turn: TurnState,
): Promise<void> {
  for (const a of turn.assistants.values()) {
    if (a.closed) continue;
    for (const callId of a.toolCallIds) {
      const t = turn.tools.get(callId);
      if (t && !t.closed) {
        t.endTime = t.endTime ?? toIso(Date.now());
        t.error = t.error ?? "Interrupted";
        await closeToolRun(session, turn, t);
      }
    }
    const cfg = getConfig();
    try {
      const { messages } = buildAssistantOutput(a, turn);
      const runTree = newRunTree({
        id: a.runId,
        name: ASSISTANT_RUN_NAME,
        run_type: "llm",
        project_name: cfg.project,
        start_time: a.startTime,
        end_time: toIso(Date.now()),
        trace_id: turn.traceId,
        parent_run_id: turn.runId,
        dotted_order: a.dottedOrder,
        outputs: { messages },
        error: "Interrupted",
        extra: {
          metadata: {
            ...baseMetadata(session.sessionID),
            ls_provider: a.providerID,
            ls_model_name: a.modelID,
            usage_metadata: buildUsageMetadata(a),
            agent: a.agent,
            turn_number: turn.turnNumber,
          },
        },
      });
      await runTree.patchRun({ excludeInputs: true });
      a.closed = true;
    } catch (err) {
      logger.error(`Failed to close stale assistant run: ${err}`);
    }
  }
}

export async function handleSessionError(
  sessionID: string | undefined,
  err: unknown,
): Promise<void> {
  if (!sessionID) return;
  const session = getSession(sessionID);
  if (!session) return;
  const turn = session.currentTurn;
  if (!turn) return;
  const errorMessage = extractErrorMessage(err) ?? "Session error";
  await closeOpenAssistantAndTools(session, turn);
  await closeTurn(session, turn, toIso(Date.now()), errorMessage);
  session.currentTurn = undefined;
  await flushPendingTraces();
}

export function handlePreCompact(sessionID: string): void {
  const session = getOrCreateSession(sessionID);
  session.compactionStartTime = Date.now();
}

export async function handleSessionCompacted(
  sessionID: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const session = getOrCreateSession(sessionID);
  const cfg = getConfig();
  const endIso = toIso(Date.now());
  const startIso = session.compactionStartTime
    ? toIso(session.compactionStartTime)
    : endIso;
  const runId = uuid7();
  const segment = generateDottedOrderSegment(startIso, runId);
  const turn = session.currentTurn;
  const parentRunId = turn?.runId;
  const traceId = turn?.traceId ?? runId;
  const dottedOrder = turn ? `${turn.dottedOrder}.${segment}` : segment;

  try {
    const trigger = (detail?.trigger as string | undefined) ?? "auto";
    const summary = (detail?.summary as string | undefined) ?? "";
    const runTree = newRunTree({
      id: runId,
      name: `${COMPACTION_RUN_NAME} (${trigger})`,
      run_type: "chain",
      inputs: {},
      outputs: summary ? { summary } : { ...detail },
      project_name: cfg.project,
      start_time: startIso,
      end_time: endIso,
      trace_id: traceId,
      dotted_order: dottedOrder,
      ...(parentRunId ? { parent_run_id: parentRunId } : {}),
      extra: {
        metadata: {
          ...baseMetadata(session.sessionID),
          trigger,
          ...(detail ?? {}),
        },
      },
    });
    await runTree.postRun();
  } catch (err) {
    logger.error(`Failed to post compacted run: ${err}`);
  } finally {
    session.compactionStartTime = undefined;
  }
}

export async function handleSessionDeleted(sessionID: string): Promise<void> {
  const session = getSession(sessionID);
  if (!session) return;
  if (session.currentTurn) {
    await closeOpenAssistantAndTools(session, session.currentTurn);
    await closeTurn(
      session,
      session.currentTurn,
      toIso(Date.now()),
      "Session deleted",
    );
    session.currentTurn = undefined;
  }
  await flushPendingTraces();
}

// ─── Tool hook helpers ──────────────────────────────────────────────────────

/** Record that a tool is about to execute so we can attribute args early. */
export function handleToolBefore(
  sessionID: string,
  callID: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const session = getOrCreateSession(sessionID);
  const turn = session.currentTurn;
  if (!turn) return;
  let tool = turn.tools.get(callID);
  if (!tool) {
    tool = {
      runId: uuid7(),
      dottedOrder: `${turn.dottedOrder}.${generateDottedOrderSegment(Date.now(), uuid7())}`,
      callID,
      toolName,
      startTime: toIso(Date.now()),
      input: args ?? {},
      posted: false,
      closed: false,
    };
    turn.tools.set(callID, tool);
  } else {
    tool.input = args ?? tool.input;
  }
}

/** Final opportunity to patch in tool.execute.after outputs. */
export async function handleToolAfter(
  sessionID: string,
  callID: string,
  toolName: string,
  args: Record<string, unknown>,
  output: { title: string; output: string; metadata: unknown },
): Promise<void> {
  const session = getOrCreateSession(sessionID);
  const turn = session.currentTurn;
  if (!turn) return;
  const tool = turn.tools.get(callID);
  if (!tool) return;
  tool.input = args ?? tool.input;
  tool.output = output.output ?? tool.output;
  tool.title = output.title ?? tool.title;
  if (!tool.endTime) tool.endTime = toIso(Date.now());
  if (typeof output.metadata === "object" && output.metadata !== null) {
    tool.metadata = output.metadata as Record<string, unknown>;
  }
  if (!tool.toolName) tool.toolName = toolName;
  if (!tool.posted) await postToolStart(session, turn, tool);
  await closeToolRun(session, turn, tool);
}

/** Flush on command-execution or similar boundary events. */
export async function flushAll(): Promise<void> {
  await flushPendingTraces();
}
