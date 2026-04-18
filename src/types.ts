/**
 * Narrow type definitions mirroring the subset of opencode SDK shapes this
 * plugin consumes. We deliberately avoid importing from `@opencode-ai/sdk`
 * at runtime so the plugin keeps a tiny dependency footprint and so we do
 * not break when SDK types evolve — we only require structural compatibility.
 */

export type MessageRole = "user" | "assistant";

export interface UserMessageInfo {
  id: string;
  sessionID: string;
  role: "user";
  time: { created: number };
  agent?: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
}

export interface AssistantMessageInfo {
  id: string;
  sessionID: string;
  role: "assistant";
  time: { created: number; completed?: number };
  parentID: string;
  modelID: string;
  providerID: string;
  agent: string;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  finish?: string;
  error?: { name: string; data?: unknown } | Record<string, unknown>;
  variant?: string;
  summary?: boolean;
}

export type MessageInfo = UserMessageInfo | AssistantMessageInfo;

export interface PartBase {
  id: string;
  sessionID: string;
  messageID: string;
}

export interface TextPart extends PartBase {
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
}

export interface ReasoningPart extends PartBase {
  type: "reasoning";
  text: string;
  time: { start: number; end?: number };
}

export interface FilePart extends PartBase {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
}

export interface StepStartPart extends PartBase {
  type: "step-start";
}

export interface StepFinishPart extends PartBase {
  type: "step-finish";
  reason: string;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}

export interface CompactionPart extends PartBase {
  type: "compaction";
  auto: boolean;
  overflow?: boolean;
}

export interface SubtaskPart extends PartBase {
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  model?: { providerID: string; modelID: string };
  command?: string;
}

export interface AgentPart extends PartBase {
  type: "agent";
  name: string;
}

export interface RetryPart extends PartBase {
  type: "retry";
  attempt: number;
  error: unknown;
  time: { created: number };
}

export interface ToolStatePending {
  status: "pending";
  input: Record<string, unknown>;
  raw: string;
}

export interface ToolStateRunning {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: { start: number };
}

export interface ToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { start: number; end: number; compacted?: number };
}

export interface ToolStateError {
  status: "error";
  input: Record<string, unknown>;
  error: string;
  metadata?: Record<string, unknown>;
  time: { start: number; end: number };
}

export type ToolState =
  | ToolStatePending
  | ToolStateRunning
  | ToolStateCompleted
  | ToolStateError;

export interface ToolPart extends PartBase {
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
}

export type Part =
  | TextPart
  | ReasoningPart
  | FilePart
  | StepStartPart
  | StepFinishPart
  | CompactionPart
  | SubtaskPart
  | AgentPart
  | RetryPart
  | ToolPart
  | (PartBase & { type: string; [key: string]: unknown });

/** Event payloads produced by opencode's bus and surfaced via the plugin `event` hook. */
export interface EventEnvelope {
  type: string;
  properties: Record<string, unknown>;
}

/** Common event properties we recognize. */
export interface EventMessageUpdated {
  type: "message.updated";
  properties: { info: MessageInfo };
}

export interface EventMessagePartUpdated {
  type: "message.part.updated";
  properties: { part: Part; delta?: string };
}

export interface EventMessagePartRemoved {
  type: "message.part.removed";
  properties: { sessionID: string; messageID: string; partID: string };
}

export interface EventMessageRemoved {
  type: "message.removed";
  properties: { sessionID: string; messageID: string };
}

export interface EventSessionIdle {
  type: "session.idle";
  properties: { sessionID: string };
}

export interface EventSessionStatus {
  type: "session.status";
  properties: {
    sessionID: string;
    status:
      | { type: "idle" }
      | { type: "busy" }
      | { type: "retry"; attempt: number; message: string; next: number };
  };
}

export interface EventSessionError {
  type: "session.error";
  properties: {
    sessionID?: string;
    error: { name?: string; message?: string; data?: unknown } | string;
  };
}

export interface EventSessionCompacted {
  type: "session.compacted";
  properties: { sessionID: string; [key: string]: unknown };
}

export interface EventSessionDeleted {
  type: "session.deleted";
  properties: { sessionID: string };
}

export interface EventSessionCreated {
  type: "session.created";
  properties: { sessionID?: string; [key: string]: unknown };
}

export interface EventSessionUpdated {
  type: "session.updated";
  properties: { sessionID?: string; [key: string]: unknown };
}

export type Event =
  | EventMessageUpdated
  | EventMessagePartUpdated
  | EventMessagePartRemoved
  | EventMessageRemoved
  | EventSessionIdle
  | EventSessionStatus
  | EventSessionError
  | EventSessionCompacted
  | EventSessionDeleted
  | EventSessionCreated
  | EventSessionUpdated
  | EventEnvelope;
