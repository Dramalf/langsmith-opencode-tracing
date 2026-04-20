"""Shared helpers: load the same env file the plugin reads."""

from __future__ import annotations

import os
import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_ENV_CANDIDATES = [
    _REPO_ROOT / ".opencode" / "langsmith.env",
    Path.home() / ".opencode" / "langsmith.env",
]


def load_env() -> None:
    """Populate os.environ from the first langsmith.env file found.

    Does not override existing environment variables — same policy as
    the TypeScript plugin (see src/env-file.ts).
    """
    for path in _ENV_CANDIDATES:
        if not path.is_file():
            continue
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
            if not m:
                continue
            key, val = m.group(1), m.group(2).strip()
            if (val.startswith('"') and val.endswith('"')) or (
                val.startswith("'") and val.endswith("'")
            ):
                val = val[1:-1]
            os.environ.setdefault(key, val)
        return


def langsmith_client():
    """Return a LangSmith client wired to whatever endpoint/key the plugin uses."""
    load_env()
    from langsmith import Client

    api_url = (
        os.environ.get("LANGSMITH_ENDPOINT")
        or os.environ.get("CC_LANGSMITH_ENDPOINT")
        or os.environ.get("OC_LANGSMITH_ENDPOINT")
    )
    api_key = (
        os.environ.get("LANGSMITH_API_KEY")
        or os.environ.get("CC_LANGSMITH_API_KEY")
        or os.environ.get("OC_LANGSMITH_API_KEY")
    )
    if not api_key:
        raise SystemExit(
            "No LangSmith API key found. Set LANGSMITH_API_KEY or populate .opencode/langsmith.env"
        )
    return Client(api_url=api_url, api_key=api_key)
