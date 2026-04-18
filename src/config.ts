/**
 * Configuration loaded from environment variables.
 *
 * Mirrors the naming convention of langsmith-claude-code but uses a
 * `OC_LANGSMITH_` prefix so the two plugins can coexist.
 */

import type { RunTreeConfig } from "langsmith";
import * as logger from "./logger.js";

export interface Config {
  enabled: boolean;
  apiKey: string;
  project: string;
  apiBaseUrl: string;
  debug: boolean;
  /** Dotted-order string of an existing LangSmith run to nest all traces under. */
  parentDottedOrder?: string;
  replicas?: RunTreeConfig["replicas"];
  /** Custom metadata to attach to every root turn run. */
  customMetadata?: Record<string, unknown>;
}

function readBool(v: string | undefined, fallback = false): boolean {
  if (v === undefined) return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

/** Look up the first defined env var in a priority-ordered list. */
function firstEnv(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

export function loadConfig(): Config {
  const enabled =
    readBool(process.env.TRACE_TO_LANGSMITH) ||
    readBool(process.env.OC_TRACE_TO_LANGSMITH) ||
    readBool(process.env.CC_TRACE_TO_LANGSMITH) ||
    readBool(process.env.LANGSMITH_TRACING);

  const apiKey =
    firstEnv(
      "OC_LANGSMITH_API_KEY",
      "CC_LANGSMITH_API_KEY",
      "LANGSMITH_API_KEY",
    ) ?? "";

  const project =
    firstEnv(
      "OC_LANGSMITH_PROJECT",
      "CC_LANGSMITH_PROJECT",
      "LANGSMITH_PROJECT",
    ) ?? "opencode";

  const apiBaseUrl =
    firstEnv(
      "OC_LANGSMITH_ENDPOINT",
      "CC_LANGSMITH_ENDPOINT",
      "LANGSMITH_ENDPOINT",
    ) ?? "https://api.smith.langchain.com";

  const debug =
    readBool(process.env.OC_LANGSMITH_DEBUG) ||
    readBool(process.env.CC_LANGSMITH_DEBUG) ||
    readBool(process.env.LANGSMITH_DEBUG);

  let replicas: RunTreeConfig["replicas"] | undefined;
  const providedReplicas = firstEnv(
    "OC_LANGSMITH_RUNS_ENDPOINTS",
    "CC_LANGSMITH_RUNS_ENDPOINTS",
  );
  if (providedReplicas !== undefined) {
    try {
      replicas = JSON.parse(providedReplicas);
    } catch {
      logger.error(
        "Failed to parse LANGSMITH_RUNS_ENDPOINTS; must be valid JSON.",
      );
    }
  }

  const parentDottedOrder =
    firstEnv(
      "OC_LANGSMITH_PARENT_DOTTED_ORDER",
      "CC_LANGSMITH_PARENT_DOTTED_ORDER",
    ) || undefined;

  let customMetadata: Record<string, unknown> | undefined;
  const providedMetadata = firstEnv(
    "OC_LANGSMITH_METADATA",
    "CC_LANGSMITH_METADATA",
  );
  if (providedMetadata !== undefined) {
    try {
      const parsed = JSON.parse(providedMetadata);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        customMetadata = parsed as Record<string, unknown>;
      } else {
        logger.error(
          "LANGSMITH_METADATA must be a JSON object (not an array or primitive).",
        );
      }
    } catch {
      logger.error(
        "Failed to parse LANGSMITH_METADATA; must be valid JSON.",
      );
    }
  }

  return {
    enabled,
    apiKey,
    project,
    apiBaseUrl,
    debug,
    parentDottedOrder,
    replicas,
    customMetadata,
  };
}
