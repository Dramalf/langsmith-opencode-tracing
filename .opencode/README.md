# `.opencode/` project-level opencode config

This directory configures opencode for this repository.

```
.opencode/
├── langsmith.env.example       # commit-safe template for plugin env vars
└── langsmith.env               # gitignored; real LangSmith API key lives here
```

## How it works

1. The repo root's `opencode.json` declares the plugin:

   ```json
   { "plugin": ["opencode-langsmith-tracing"] }
   ```

   On startup opencode installs it from npm into its local plugin cache.

2. `.opencode/langsmith.env` is auto-loaded by the plugin at startup
   and injected into `process.env` (without overriding variables already
   set in your shell).

## Quick start

```bash
cp .opencode/langsmith.env.example .opencode/langsmith.env   # only if missing
# edit .opencode/langsmith.env with your key/endpoint/project
opencode
```

## Supported keys

Both the `OC_LANGSMITH_*` and `CC_LANGSMITH_*` prefixes are accepted so the
same file can be shared with the claude-code equivalent plugin. See the
top-level `README.md` for the full matrix.
