/**
 * Minimal dotenv-style loader.
 *
 * Loads `KEY=VALUE` lines from a file into `process.env` without overriding
 * any pre-existing variables. Supports:
 *   - blank lines and `#` comments
 *   - single or double-quoted values
 *   - a leading `export ` keyword
 *
 * We intentionally avoid a runtime dependency on `dotenv` so the plugin
 * stays a zero-install drop-in.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import * as logger from "./logger.js";

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length);
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = stripQuotes(line.slice(eq + 1).trim());
    out[key] = value;
  }
  return out;
}

/** Load env vars from the first file in `candidates` that exists. Returns the path that was loaded, if any. */
export function loadEnvFromFirst(candidates: string[]): string | undefined {
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const parsed = parseEnvFile(readFileSync(p, "utf-8"));
      let applied = 0;
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined || process.env[k] === "") {
          process.env[k] = v;
          applied += 1;
        }
      }
      logger.debug(`Loaded ${applied} env var(s) from ${p}`);
      return p;
    } catch (err) {
      logger.warn(`Failed to read env file ${p}: ${err}`);
    }
  }
  return undefined;
}

/** Standard opencode-style env file search order for a given working directory. */
export function defaultEnvFileCandidates(directory?: string): string[] {
  const cwd = directory ?? process.cwd();
  const explicit = process.env.OC_LANGSMITH_ENV_FILE;
  const out: string[] = [];
  if (explicit) out.push(resolve(cwd, explicit));
  out.push(resolve(cwd, ".opencode", "langsmith.env"));
  out.push(resolve(cwd, ".opencode", ".env"));
  return out;
}
