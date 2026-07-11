import json
import importlib.util
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import trajectory._client as client
from trajectory import (
    DEEP_AGENTS_CODE_DEFAULT_DATABASE_PATH,
    NodeUnavailableError,
    NormalizationError,
    normalize_checkpoint,
    normalize_deepagents_code,
    normalize_many,
    normalize_transcript,
)

ROOT = Path(__file__).resolve().parents[2]
try:
    HAS_LANGGRAPH_SQLITE = importlib.util.find_spec("langgraph.checkpoint.sqlite") is not None
except ModuleNotFoundError:
    HAS_LANGGRAPH_SQLITE = False
FIXTURES = (
    ("claude-code", "claude-code/tool-call", "input.jsonl"),
    ("claude-code", "claude-code/cleanup", "input.jsonl"),
    ("codex", "codex/tool-calls", "input.jsonl"),
    ("codex", "codex/cleanup", "input.jsonl"),
    ("deepagents-code", "deepagents-code/tool-calls", "input.json"),
    ("deepagents-code", "deepagents-code/cleanup", "input.json"),
    ("letta", "letta/tool-call", "input.json"),
    ("letta", "letta/cleanup", "input.json"),
    ("letta", "letta/local-v3", "input.jsonl"),
    ("letta", "letta/local-legacy", "input.jsonl"),
    ("openhands", "openhands/tool-calls", "input.json"),
    ("openhands", "openhands/cleanup", "input.json"),
)


def fixture_text(name: str, filename: str) -> str:
    return (ROOT / "fixtures" / name / filename).read_text(encoding="utf-8")


class WrapperTests(unittest.TestCase):
    def test_all_golden_fixtures_match(self) -> None:
        for source, name, input_filename in FIXTURES:
            with self.subTest(name=name):
                actual = normalize_transcript(
                    source=source,
                    transcript=fixture_text(name, input_filename),
                )
                expected = json.loads(fixture_text(name, "expected.json"))
                self.assertEqual(actual, expected)

    def test_batch_matches_single_results(self) -> None:
        requests = [
            {
                "source": source,
                "transcript": fixture_text(name, input_filename),
            }
            for source, name, input_filename in FIXTURES
        ]
        expected = [
            json.loads(fixture_text(name, "expected.json")) for _, name, _ in FIXTURES
        ]

        self.assertEqual(normalize_many(requests), expected)

    def test_normalization_errors_include_code_and_batch_index(self) -> None:
        valid = {
            "source": "codex",
            "transcript": fixture_text("codex/cleanup", "input.jsonl"),
        }
        invalid = {"source": "langsmith", "transcript": "{}"}

        with self.assertRaises(NormalizationError) as raised:
            normalize_many([valid, invalid])

        self.assertEqual(raised.exception.code, "unknown_source")
        self.assertEqual(raised.exception.input_index, 1)

    def test_empty_batch_avoids_starting_node(self) -> None:
        self.assertEqual(normalize_many([]), [])

    def test_requires_node_20_or_newer(self) -> None:
        client._node_executable.cache_clear()
        try:
            with patch.object(client.shutil, "which", return_value=None):
                with self.assertRaisesRegex(NodeUnavailableError, "Node.js 20"):
                    normalize_transcript(source="codex", transcript="{}")
        finally:
            client._node_executable.cache_clear()

    def test_deepagents_code_requires_explicit_thread_id(self) -> None:
        with self.assertRaises(NormalizationError) as raised:
            normalize_deepagents_code(thread_id="")

        self.assertEqual(raised.exception.code, "invalid_input")

    def test_deepagents_code_delegates_fixed_path_and_retags_meta(self) -> None:
        generic = {
            "records": [
                {"role": "meta", "source": "deepagents", "cwd": "/workspace"},
                {
                    "role": "user",
                    "content": "Hello",
                    "timestamp": "2026-01-02T03:04:05.000Z",
                },
                {
                    "role": "assistant",
                    "content": "Hi",
                    "timestamp": "2026-01-02T03:04:06.000Z",
                },
            ],
            "diagnostics": [],
        }
        bounds = {"toolResults": {"maxCharacters": 20, "strategy": "head"}}
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "home"
            database = home / ".deepagents" / ".state" / "sessions.db"
            database.parent.mkdir(parents=True)
            shutil.copyfile(ROOT / "fixtures/deepagents/checkpoint.db", database)
            with patch.dict(os.environ, {"HOME": str(home)}):
                with patch.object(
                    client, "normalize_checkpoint", return_value=generic
                ) as delegated:
                    result = normalize_deepagents_code(
                        thread_id="thread-123",
                        checkpoint_namespace="sdk",
                        checkpoint_id="checkpoint-1",
                        bounds=bounds,  # type: ignore[arg-type]
                        python_executable="/test/python",
                    )

        delegated.assert_called_once_with(
            path=database,
            thread_id="thread-123",
            checkpoint_namespace="sdk",
            checkpoint_id="checkpoint-1",
            bounds=bounds,
            python_executable="/test/python",
        )
        self.assertEqual(
            result["records"][0],
            {
                "role": "meta",
                "source": "deepagents-code",
                "cwd": "/workspace",
            },
        )
        self.assertEqual(result["records"][1:], generic["records"][1:])
        self.assertEqual(result["diagnostics"], generic["diagnostics"])

    @unittest.skipUnless(HAS_LANGGRAPH_SQLITE, "LangGraph SQLite extra not installed")
    def test_normalizes_deepagents_checkpoint_with_current_python(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "checkpoint.db"
            shutil.copyfile(ROOT / "fixtures/deepagents/checkpoint.db", database)
            result = normalize_checkpoint(
                path=database,
                thread_id="thread-123",
                checkpoint_namespace="sdk",
            )
            batch = normalize_many(
                [
                    {
                        "source": "deepagents",
                        "checkpoint": {
                            "path": str(database),
                            "threadId": "thread-123",
                            "checkpointNamespace": "other",
                        },
                    }
                ]
            )

        self.assertEqual(result["records"][0]["role"], "meta")
        self.assertEqual(result["records"][0]["source"], "deepagents")
        self.assertEqual(
            [record["role"] for record in result["records"]],
            ["meta", "user", "reasoning", "assistant", "assistant", "tool", "assistant"],
        )
        self.assertEqual(result["records"][-1]["content"], "It is sunny and 22 C in Paris.")
        self.assertEqual(batch[0]["records"][1]["content"], "Other namespace")

    @unittest.skipUnless(HAS_LANGGRAPH_SQLITE, "LangGraph SQLite extra not installed")
    def test_normalizes_deepagents_code_from_default_local_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "home"
            database = home / ".deepagents" / ".state" / "sessions.db"
            database.parent.mkdir(parents=True)
            shutil.copyfile(ROOT / "fixtures/deepagents/checkpoint.db", database)
            with patch.dict(os.environ, {"HOME": str(home)}):
                generic = normalize_checkpoint(
                    path=database,
                    thread_id="thread-123",
                    checkpoint_namespace="sdk",
                )
                result = normalize_deepagents_code(
                    thread_id="thread-123",
                    checkpoint_namespace="sdk",
                )
                historical = normalize_deepagents_code(
                    thread_id="thread-123",
                    checkpoint_namespace="sdk",
                    checkpoint_id="00000000-0000-6000-8000-000000000001",
                )
                other = normalize_deepagents_code(
                    thread_id="thread-123",
                    checkpoint_namespace="other",
                )

        expected = dict(generic)
        expected["records"] = [
            {**generic["records"][0], "source": "deepagents-code"},
            *generic["records"][1:],
        ]
        self.assertEqual(
            DEEP_AGENTS_CODE_DEFAULT_DATABASE_PATH,
            "~/.deepagents/.state/sessions.db",
        )
        self.assertEqual(result, expected)
        self.assertEqual(historical["records"][0]["source"], "deepagents-code")
        self.assertNotEqual(
            historical["records"][-1].get("content"),
            "It is sunny and 22 C in Paris.",
        )
        self.assertEqual(other["records"][1]["content"], "Other namespace")


if __name__ == "__main__":
    unittest.main()
