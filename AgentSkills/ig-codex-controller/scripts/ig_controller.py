"""Entrypoint for the self-contained InferenceGraph Codex controller skill."""

from __future__ import annotations

from pathlib import Path
import sys


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
if str(SCRIPT_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIRECTORY))

from ig_control.cli import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
