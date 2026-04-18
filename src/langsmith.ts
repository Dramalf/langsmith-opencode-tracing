/**
 * Thin wrapper around the LangSmith JS SDK. Produces RunTree nodes,
 * handles dotted-order construction, and exposes flush helpers.
 */

import { Client, RunTree, type RunTreeConfig } from "langsmith";
import * as logger from "./logger.js";

let client: Client | undefined;
let replicas: RunTreeConfig["replicas"] | undefined;

export function initTracing(
  apiKey?: string,
  apiUrl?: string,
  providedReplicas?: RunTreeConfig["replicas"],
): Client | undefined {
  if (apiKey) {
    client = new Client({ apiKey, apiUrl });
  } else {
    client = undefined;
  }
  replicas = providedReplicas;
  return client;
}

export function getClient(): Client | undefined {
  return client;
}

export function getReplicas(): RunTreeConfig["replicas"] | undefined {
  return replicas;
}

/** Await pending batches to ensure traces are sent before the current tick ends. */
export async function flushPendingTraces(): Promise<void> {
  logger.debug("Awaiting pending trace batches...");
  await Promise.all([
    client?.awaitPendingTraceBatches(),
    RunTree.getSharedClient().awaitPendingTraceBatches(),
  ]);
  logger.debug("Trace batches flushed successfully");
}

/**
 * Construct a dotted-order segment (LangSmith-canonical format).
 * Mirrors convertToDottedOrderFormat in langsmith-sdk.
 */
export function generateDottedOrderSegment(
  time: string | number | Date,
  runId: string,
): string {
  const iso =
    typeof time === "string"
      ? time
      : time instanceof Date
        ? time.toISOString()
        : new Date(time).toISOString();
  const withMicros = `${iso.slice(0, -1)}000Z`;
  const stripped = withMicros.replace(/[-:.]/g, "");
  return stripped + runId;
}

function runIdFromSegment(segment: string): string {
  const zIdx = segment.indexOf("Z");
  return zIdx >= 0 ? segment.slice(zIdx + 1) : segment;
}

/** Parse a dotted_order string into its trace ID and leaf run ID. */
export function parseDottedOrder(dottedOrder: string): {
  traceId: string;
  runId: string;
} {
  const segments = dottedOrder.split(".");
  const traceId = runIdFromSegment(segments[0]);
  const runId = runIdFromSegment(segments[segments.length - 1]);
  return { traceId, runId };
}

export function toIso(t: number | string | Date | undefined): string {
  if (t === undefined) return new Date().toISOString();
  if (typeof t === "string") return t;
  if (t instanceof Date) return t.toISOString();
  return new Date(t).toISOString();
}
