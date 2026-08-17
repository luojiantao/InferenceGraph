"""Command-line bridge for the pure JSON control-plane operations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

from pydantic import ValidationError

from .models import GraphSnapshot, NormalizedRunRequest, ResearchResult, RunState
from .normalize import initialize_run, normalize_request
from .reconcile import (
    acknowledge_expansion_settlement,
    reconcile_research_result,
    reconcile_worker_result,
    validate_worker_result,
)
from .report import render_report
from .scheduler import accept_expansion_claim, select_next_action


def _read_json(path: str) -> dict[str, Any]:
    if path == "-":
        value = json.load(sys.stdin)
    else:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("JSON input must be an object")
    return value


def _write_json(value: Any) -> None:
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json", by_alias=True)
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="InferenceGraph Codex control plane")
    subparsers = parser.add_subparsers(dest="command", required=True)

    normalize = subparsers.add_parser("normalize")
    normalize.add_argument("--request", required=True)

    initialize = subparsers.add_parser("initialize")
    initialize.add_argument("--request", required=True)
    initialize.add_argument("--session", required=True)

    next_command = subparsers.add_parser("next")
    next_command.add_argument("--state", required=True)
    next_command.add_argument("--snapshot")

    accept_claim = subparsers.add_parser("accept-claim")
    accept_claim.add_argument("--state", required=True)
    accept_claim.add_argument("--claim", required=True)
    accept_claim.add_argument("--snapshot", required=True)

    validate = subparsers.add_parser("validate-worker-result")
    validate.add_argument("--worker-result", required=True)

    reconcile = subparsers.add_parser("reconcile")
    reconcile.add_argument("--state", required=True)
    reconcile.add_argument("--snapshot", required=True)
    reconcile.add_argument("--worker-result", required=True)

    acknowledge = subparsers.add_parser("ack-settlement")
    acknowledge.add_argument("--state", required=True)
    acknowledge.add_argument("--settlement", required=True)

    research = subparsers.add_parser("reconcile-research")
    research.add_argument("--state", required=True)
    research.add_argument("--research-result", required=True)

    report = subparsers.add_parser("report")
    report.add_argument("--state", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "normalize":
            _write_json(normalize_request(_read_json(args.request)))
            return 0

        if args.command == "initialize":
            request = NormalizedRunRequest.model_validate(_read_json(args.request))
            session = _read_json(args.session)
            _write_json(
                initialize_run(
                    request,
                    session_id=session["sessionId"],
                    root_vertex_id=session["rootVertexId"],
                    graph_revision=session["graphRevision"],
                )
            )
            return 0

        if args.command == "next":
            state = RunState.model_validate(_read_json(args.state))
            snapshot = None if args.snapshot is None else GraphSnapshot.model_validate(_read_json(args.snapshot))
            next_state, action = select_next_action(state, snapshot)
            _write_json({"state": next_state.model_dump(mode="json", by_alias=True), "action": action.model_dump(mode="json", by_alias=True)})
            return 0

        if args.command == "accept-claim":
            state = RunState.model_validate(_read_json(args.state))
            snapshot = GraphSnapshot.model_validate(_read_json(args.snapshot))
            next_state, action = accept_expansion_claim(state, _read_json(args.claim), snapshot)
            _write_json({"state": next_state.model_dump(mode="json", by_alias=True), "action": action.model_dump(mode="json", by_alias=True)})
            return 0

        if args.command == "validate-worker-result":
            _write_json(validate_worker_result(_read_json(args.worker_result)))
            return 0

        if args.command == "reconcile":
            state = RunState.model_validate(_read_json(args.state))
            snapshot = GraphSnapshot.model_validate(_read_json(args.snapshot))
            result = validate_worker_result(_read_json(args.worker_result))
            _write_json(reconcile_worker_result(state, snapshot, result))
            return 0

        if args.command == "ack-settlement":
            state = RunState.model_validate(_read_json(args.state))
            _write_json(acknowledge_expansion_settlement(state, _read_json(args.settlement)))
            return 0

        if args.command == "reconcile-research":
            state = RunState.model_validate(_read_json(args.state))
            result = ResearchResult.model_validate(_read_json(args.research_result))
            _write_json(reconcile_research_result(state, result))
            return 0

        if args.command == "report":
            state = RunState.model_validate(_read_json(args.state))
            sys.stdout.write(render_report(state))
            return 0
    except (KeyError, ValidationError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2

    raise AssertionError(f"Unhandled command: {args.command}")
