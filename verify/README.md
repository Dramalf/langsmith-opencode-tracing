# verify

Ad-hoc scripts for pulling traces off the LangSmith backend the plugin
writes to (self-hosted at `http://45.78.192.67/api/v1`) to reason about
plugin bugs without having to click around in the UI.

Scripts read auth from `.opencode/langsmith.env` at the repo root so
they stay in sync with whatever the plugin is actually using:

- `CC_LANGSMITH_ENDPOINT` → LangSmith API base URL
- `CC_LANGSMITH_API_KEY` → personal API key

## Usage

```bash
python3 verify/inspect_trace.py <run-id | share-url>
```

Examples:

```bash
# by run ID (e.g. from a share link .../public/<id>/r)
python3 verify/inspect_trace.py 9bfe3cb7-9435-4bd7-9304-68af213ed00d

# by full share URL
python3 verify/inspect_trace.py http://45.78.192.67/public/9bfe3cb7-9435-4bd7-9304-68af213ed00d/r
```

The script prints the trace tree, each tool run's inputs/outputs/error,
and a diff between successive same-tool invocations so we can see
whether our plugin is emitting stale data or not.
