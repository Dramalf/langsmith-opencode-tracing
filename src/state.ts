/**
 * In-memory per-session trace state.
 *
 * Opencode plugins stay resident in the same process for the lifetime of
 * a session, so — unlike the claude-code reference — we do not need file
 * based state. Everything is kept in a Map keyed by sessionID.
 */

import type { Part } from "./types.js";

/** Tracking info for one LLM (assistant) run inside a turn. */
export interface AssistantRunState {
  /** langsmith run id */
  runId: string;
  /** dotted_order including this run */
  dottedOrder: string;
  /** wall-clock start time ISO */
  startTime: string;
  /** time end ISO (populated when the assistant message is completed) */
  endTime?: string;
  /** provider id (from AssistantMessage.providerID) */
  providerID?: string;
  /** model id (from AssistantMessage.modelID) */
  modelID?: string;
  /** agent name */
  agent?: string;
  /** concatenated text parts (id → text) – preserves streaming order */
  textParts: Map<string, string>;
  /** concatenated reasoning parts (id → text) */
  reasoningParts: Map<string, string>;
  /** callIDs of tool calls emitted by this assistant message (in order) */
  toolCallIds: string[];
  /** tokens captured from step-finish parts and final message.tokens */
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** cost (accumulated from step-finish parts, or from final message.cost) */
  cost: number;
  /** final finish reason from the AssistantMessage */
  finish?: string;
  /** error object (if any) */
  error?: unknown;
  /** marks whether postRun has been sent */
  posted: boolean;
  /** marks whether patchRun (close) has been sent */
  closed: boolean;
}

/** Tracking info for one tool run inside a turn. */
export interface ToolRunState {
  /** langsmith run id */
  runId: string;
  /** dotted_order */
  dottedOrder: string;
  /** opencode callID */
  callID: string;
  /** tool name */
  toolName: string;
  /** wall-clock start time ISO */
  startTime: string;
  /** wall-clock end time ISO (once completed/errored) */
  endTime?: string;
  /** assistant message id this tool belongs to */
  assistantMessageID?: string;
  /** inputs captured at running/completed time */
  input: Record<string, unknown>;
  /** output text (completed) */
  output?: string;
  /** error (if status: error) */
  error?: string;
  /** tool title (human-readable summary from opencode) */
  title?: string;
  /** postRun has been sent with timestamps */
  posted: boolean;
  /** final patch has been sent */
  closed: boolean;
  /** metadata captured from running/completed state */
  metadata?: Record<string, unknown>;
}

export interface TurnState {
  /** langsmith run id for the Turn (chain) */
  runId: string;
  /** dotted_order for the turn (also prefix for children) */
  dottedOrder: string;
  /** trace id (root) */
  traceId: string;
  /** optional external parent run id */
  parentRunId?: string;
  /** turn start time ISO */
  startTime: string;
  /** user message id that started this turn */
  userMessageID: string;
  /** user prompt content (plain text concatenation of user text parts) */
  userContent: string;
  /** user file/attachment parts captured from message.part.updated */
  userFiles: Array<{ mime: string; url: string; filename?: string }>;
  /** user agent/model/variant */
  agent?: string;
  model?: { providerID: string; modelID: string };
  /** turn number (1-based) */
  turnNumber: number;
  /** LLM runs keyed by assistant messageID */
  assistants: Map<string, AssistantRunState>;
  /** Tool runs keyed by callID */
  tools: Map<string, ToolRunState>;
  /** order in which assistants were seen */
  assistantOrder: string[];
}

export interface SessionState {
  sessionID: string;
  /** turn counter (advanced as each turn closes) */
  turnCount: number;
  /** currently-open turn (if any) */
  currentTurn?: TurnState;
  /** last seen role per messageID for filtering part updates */
  messageRoles: Map<string, "user" | "assistant">;
  /** compaction timing */
  compactionStartTime?: number;
  /** cache of raw parts we've observed while the turn is active
   *  (keyed by partID) — used to rebuild content when needed. */
  partCache: Map<string, Part>;
}

const sessions = new Map<string, SessionState>();

export function getOrCreateSession(sessionID: string): SessionState {
  let s = sessions.get(sessionID);
  if (!s) {
    s = {
      sessionID,
      turnCount: 0,
      messageRoles: new Map(),
      partCache: new Map(),
    };
    sessions.set(sessionID, s);
  }
  return s;
}

export function getSession(sessionID: string): SessionState | undefined {
  return sessions.get(sessionID);
}

export function deleteSession(sessionID: string): void {
  sessions.delete(sessionID);
}

export function clearAllSessions(): void {
  sessions.clear();
}

/** Total session count (for diagnostics / tests). */
export function sessionCount(): number {
  return sessions.size;
}
