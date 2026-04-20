#!/usr/bin/env python3
"""Inspect a single LangSmith trace produced by langsmith-opencode-plugins.

Usage:
    python3 verify/inspect_trace.py <run-id|share-url>

Prints:
  - the run tree (chain -> llm -> tool / chain -> llm -> ...)
  - for every tool run, its inputs / outputs / error
  - a report of whether successive same-named tool runs share output
    content (which is the symptom the user is debugging: AI keeps
    seeing the same stale error JSON on subsequent tool calls).
"""

from __future__ import annotations

import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from _env import langsmith_client


def _extract_share_token(arg: str) -> str:
    arg = arg.strip()
    m = re.search(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", arg
    )
    if not m:
        raise SystemExit(f"Could not extract a UUID from {arg!r}")
    return m.group(0)


def _truncate(value: Any, limit: int = 400) -> str:
    if value is None:
        return "<none>"
    s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    if len(s) <= limit:
        return s
    return s[:limit] + f"… (+{len(s) - limit} chars)"


@dataclass
class Node:
    id: str
    name: str
    run_type: str
    start_time: Any
    end_time: Any
    parent_run_id: str | None
    inputs: Any
    outputs: Any
    error: Any
    metadata: dict[str, Any] = field(default_factory=dict)
    children: list["Node"] = field(default_factory=list)


def _run_to_node(r) -> Node:
    extra = getattr(r, "extra", None) or {}
    md = extra.get("metadata") or {} if isinstance(extra, dict) else {}
    return Node(
        id=str(r.id),
        name=r.name,
        run_type=r.run_type,
        start_time=r.start_time,
        end_time=r.end_time,
        parent_run_id=str(r.parent_run_id) if r.parent_run_id else None,
        inputs=r.inputs,
        outputs=r.outputs,
        error=getattr(r, "error", None),
        metadata=md if isinstance(md, dict) else {},
    )


def _fetch_shared_trace(client, share_token: str) -> tuple[Node, list[Node]]:
    """Fetch a shared trace and all of its children.

    Uses /public/<token>/run to get the root (which includes
    child_run_ids), then pulls each child via /public/<token>/run/<id>
    with a small thread pool to keep this snappy.
    """
    root_raw = client.read_shared_run(share_token)
    root = _run_to_node(root_raw)
    child_ids = getattr(root_raw, "child_run_ids", None) or []

    def _fetch(child_id: str) -> Node | None:
        try:
            return _run_to_node(client.read_shared_run(share_token, run_id=child_id))
        except Exception as err:  # noqa: BLE001
            print(f"WARN: failed to fetch child {child_id}: {err}", file=sys.stderr)
            return None

    children: list[Node] = []
    if child_ids:
        with ThreadPoolExecutor(max_workers=8) as pool:
            for node in pool.map(_fetch, [str(cid) for cid in child_ids]):
                if node is not None:
                    children.append(node)

    return root, [root, *children]


def _build_tree(nodes: list[Node], root_id: str) -> Node:
    by_id = {n.id: n for n in nodes}
    root = by_id.get(root_id)
    if root is None:
        raise SystemExit(f"Root run {root_id} not found in returned runs")
    for n in nodes:
        if n.parent_run_id and n.parent_run_id in by_id and n is not root:
            by_id[n.parent_run_id].children.append(n)
    for n in nodes:
        n.children.sort(key=lambda c: c.start_time or 0)
    return root


def _walk(node: Node, depth: int = 0) -> None:
    indent = "  " * depth
    label = f"{node.run_type}:{node.name}"
    err_marker = " ⛔ERROR" if node.error else ""
    print(f"{indent}- {label}{err_marker}  id={node.id[:8]}")
    if node.run_type == "tool":
        call_id = node.metadata.get("call_id") if isinstance(node.metadata, dict) else None
        print(f"{indent}  call_id: {call_id}")
        print(f"{indent}  inputs:  {_truncate(node.inputs)}")
        print(f"{indent}  outputs: {_truncate(node.outputs)}")
        if node.error:
            print(f"{indent}  error:   {_truncate(node.error)}")
    for c in node.children:
        _walk(c, depth + 1)


def _flatten_tools(node: Node, acc: list[Node] | None = None) -> list[Node]:
    if acc is None:
        acc = []
    if node.run_type == "tool":
        acc.append(node)
    for c in node.children:
        _flatten_tools(c, acc)
    return acc


def _summarise_tool_stability(tools: list[Node]) -> None:
    """Report whether same-named tool runs share their output strings.

    The user's claim is that once a tool errors, every subsequent
    invocation of the same tool returns the same stale error JSON. If
    that's happening, successive same-named tool runs will have
    byte-identical outputs/errors.
    """
    print("\n=== per-tool output stability ===")
    by_name: dict[str, list[Node]] = {}
    for t in tools:
        by_name.setdefault(t.name, []).append(t)
    for name, group in by_name.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda n: n.start_time or 0)
        outputs = []
        for t in group:
            payload = {
                "inputs": t.inputs,
                "outputs": t.outputs,
                "error": t.error,
            }
            outputs.append(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str))
        first = outputs[0]
        all_equal = all(o == first for o in outputs[1:])
        print(f"\n[{name}] calls={len(group)}  all_outputs_identical={all_equal}")
        for i, t in enumerate(group):
            call_id = t.metadata.get("call_id") if isinstance(t.metadata, dict) else None
            marker = "ERROR" if t.error else "ok"
            print(
                f"  #{i + 1} {marker:5} call_id={call_id} "
                f"input={_truncate(t.inputs, 120)} "
                f"output={_truncate(t.outputs, 120)} "
                f"err={_truncate(t.error, 120)}"
            )
        # If all outputs really are identical across calls, print one
        # of them in full so we can eyeball the JSON shape.
        if all_equal:
            print("  ⚠ identical payload across all calls — dumping first:")
            print("  " + _truncate(outputs[0], 800))


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    share_token = _extract_share_token(sys.argv[1])
    client = langsmith_client()

    print(f"Fetching shared trace {share_token} from {client.api_url} …")
    root_raw, nodes = _fetch_shared_trace(client, share_token)
    root = _build_tree(nodes, root_raw.id)
    print(
        f"Got {len(nodes)} runs "
        f"(root={root.run_type}:{root.name}, error={'yes' if root.error else 'no'})\n"
    )

    print("=== tree ===")
    _walk(root)

    tools = _flatten_tools(root)
    _summarise_tool_stability(tools)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
