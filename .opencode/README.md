# `.opencode/` project-level opencode config

This directory makes opencode load the LangSmith tracing plugin straight
from this repo's `dist/` output (no npm install required).

```
.opencode/
├── plugins/
│   └── langsmith.ts            # loader — re-exports ../../dist/index.js
├── langsmith.env.example       # commit-safe template
└── langsmith.env               # gitignored; real API key lives here
```

## Quick start

```bash
npm install
npm run build                   # produces ../dist
cp .opencode/langsmith.env.example .opencode/langsmith.env   # only if missing
# edit .opencode/langsmith.env with your key/endpoint/project
opencode
```

`.opencode/langsmith.env` is read at plugin startup and injected into
`process.env`, so you don't need to export the vars by hand.
Environment variables already set in your shell win over the file.

## Supported keys

Both the `OC_LANGSMITH_*` and `CC_LANGSMITH_*` prefixes are accepted so the
same file can be shared with the claude-code equivalent plugin. See the
top-level `README.md` for the full matrix.
