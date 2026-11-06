"""Convert a Claude Code or Codex session file to ATIF using Harbor's own converters.

Harbor (https://github.com/harbor-framework/harbor) has no standalone
conversion CLI — session -> ATIF conversion lives inside its agent classes
(`ClaudeCode._convert_events_to_trajectory`, `Codex._convert_events_to_trajectory`)
and normally runs as part of a harness trial. This driver imports those classes
from a Harbor checkout with the harness-only dependencies stubbed out, so the
exact upstream conversion code runs against a session file on disk.

The full harbor package is not installable in isolation (heavy deps), so only
`pydantic` is required. Run via uv:

    uv run --python 3.12 --with pydantic scripts/harbor_atif_convert.py \
        <session-file> --source claude-code --harbor <harbor-checkout> --out atif.json

Writes compact JSON to --out, and Harbor's as-persisted formatting
(`format_trajectory_json`, indent=2) to --out-pretty if given.
"""

import argparse
import json
import logging
import shutil
import sys
import tempfile
import types
from pathlib import Path, PurePosixPath


def install_stubs(harbor_src: Path) -> None:
    sys.path.insert(0, str(harbor_src))

    # Bypass harbor/__init__.py (does importlib.metadata.version lookup).
    pkg = types.ModuleType("harbor")
    pkg.__path__ = [str(harbor_src / "harbor")]
    pkg.__version__ = "stub"
    sys.modules["harbor"] = pkg

    def stub(name: str, **attrs) -> None:
        mod = types.ModuleType(name)

        class Placeholder:
            def __init__(self, *args, **kwargs):
                self.__dict__.update(kwargs)

        # Any name imported from a stubbed module that we don't explicitly
        # provide resolves to a permissive placeholder class.
        mod.__getattr__ = lambda item: Placeholder  # type: ignore[method-assign]
        for key, value in attrs.items():
            setattr(mod, key, value)
        sys.modules[name] = mod

    class BaseInstalledAgent:  # bare stand-in; __init__ is bypassed below
        pass

    class Descriptor:
        def __init__(self, *args, **kwargs):
            self.__dict__.update(kwargs)

    def with_prompt_template(*args, **kwargs):
        if len(args) == 1 and callable(args[0]) and not kwargs:
            return args[0]
        return lambda fn: fn

    stub(
        "harbor.agents.installed.base",
        BaseInstalledAgent=BaseInstalledAgent,
        CliFlag=Descriptor,
        EnvVar=Descriptor,
        with_prompt_template=with_prompt_template,
    )
    stub("harbor.agents.base")
    stub("harbor.environments.base")
    stub("harbor.models.agent.context")
    stub(
        "harbor.models.trial.paths",
        EnvironmentPaths=types.SimpleNamespace(agent_dir=PurePosixPath("/agent")),
    )
    stub(
        "harbor.utils.env",
        parse_bool_env_value=lambda value, default=False: (
            default if value is None else str(value).lower() in ("1", "true", "yes")
        ),
    )
    stub("harbor.utils.templating")
    # harbor.models.agent.name (small enum), harbor.models.trajectories (pydantic
    # ATIF models), and harbor.utils.trajectory_utils load for real.


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session_file", type=Path)
    parser.add_argument("--source", choices=["claude-code", "codex"], required=True)
    parser.add_argument("--harbor", type=Path, required=True, help="Path to a harbor checkout")
    parser.add_argument("--out", type=Path, required=True, help="Compact JSON output path")
    parser.add_argument("--out-pretty", type=Path, help="As-persisted (indent=2) output path")
    args = parser.parse_args()

    harbor_src = args.harbor / "src"
    if not (harbor_src / "harbor").is_dir():
        sys.exit(f"not a harbor checkout: {args.harbor}")

    logging.basicConfig(level=logging.WARNING)
    install_stubs(harbor_src)

    from harbor.agents.installed.claude_code import ClaudeCode  # noqa: E402
    from harbor.agents.installed.codex import Codex  # noqa: E402
    from harbor.utils.trajectory_utils import format_trajectory_json  # noqa: E402

    cls = ClaudeCode if args.source == "claude-code" else Codex
    agent = object.__new__(cls)  # skip harness-oriented __init__
    agent.logger = logging.getLogger(cls.__name__)
    agent.model_name = None
    agent.logs_dir = Path(".")
    agent._version = None

    # The converters take a session *directory*; isolate the one session file so
    # sibling sessions (and subagent transcripts) don't get merged in.
    with tempfile.TemporaryDirectory() as tmp:
        session_dir = Path(tmp)
        shutil.copy(args.session_file, session_dir / args.session_file.name)
        trajectory = agent._convert_events_to_trajectory(session_dir)

    if trajectory is None:
        sys.exit("harbor converter returned no trajectory")

    data = (
        trajectory.to_json_dict()
        if hasattr(trajectory, "to_json_dict")
        else trajectory.model_dump(exclude_none=True)
    )
    args.out.write_text(json.dumps(data, separators=(",", ":")))
    if args.out_pretty:
        args.out_pretty.write_text(format_trajectory_json(data))
    print(
        json.dumps({"steps": len(data.get("steps", [])), "schema_version": data.get("schema_version")})
    )


if __name__ == "__main__":
    main()
