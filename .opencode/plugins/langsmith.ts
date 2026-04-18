/**
 * Project-level loader for the LangSmith tracing plugin.
 *
 * Opencode auto-loads any `.ts`/`.js` file in `.opencode/plugins/` at startup.
 * We re-export the built plugin entry so it can be developed and debugged
 * from inside this repository without publishing to npm.
 *
 * Env vars can be supplied via the shell OR via a `.opencode/langsmith.env`
 * file (auto-loaded by the plugin on startup, lowest precedence).
 */

// @ts-ignore — resolved at runtime relative to this file by opencode/Bun.
export { LangsmithTracingPlugin as default } from "../../dist/index.js";
