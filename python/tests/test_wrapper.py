import json
import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import trajectory._client as client
from trajectory import (
    NodeUnavailableError,
    NormalizationError,
    SourceContext,
    list_trajectories,
    normalize_checkpoint,
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
    ("hermes", "hermes/tool-calls", "input.json"),
    ("hermes", "hermes/cleanup", "input.json"),
    ("letta-code", "letta-code/tool-calls", "input.jsonl"),
    ("letta-code", "letta-code/cleanup", "input.jsonl"),
    ("openclaw", "openclaw/tool-calls", "input.jsonl"),
    ("openclaw", "openclaw/cleanup", "input.jsonl"),
    ("openhands", "openhands/tool-calls", "input.json"),
    ("openhands", "openhands/cleanup", "input.json"),
    ("pi", "pi/tool-calls", "input.jsonl"),
    ("pi", "pi/cleanup", "input.jsonl"),
)


def fixture_text(name: str, filename: str) -> str:
    return (ROOT / "fixtures" / name / filename).read_text(encoding="utf-8")


def codex_message(role: str, text: str) -> str:
    return json.dumps(
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": role,
                "content": [
                    {
                        "type": "input_text" if role == "user" else "output_text",
                        "text": text,
                    }
                ],
            },
        }
    )


def codex_function_output(call_id: str, output: str) -> str:
    return json.dumps(
        {
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "call_id": call_id,
                "output": output,
            },
        }
    )


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

    def test_normalizes_single_role_partial_fragments(self) -> None:
        source_context: SourceContext = {"partial": True}
        for role in ("user", "assistant"):
            with self.subTest(role=role):
                result = normalize_transcript(
                    source="codex",
                    transcript=codex_message(role, f"{role} fragment"),
                    source_context=source_context,
                )
                self.assertEqual(
                    [record["role"] for record in result["records"]],
                    ["meta", role],
                )

        continued = normalize_transcript(
            source="codex",
            transcript=codex_message("assistant", "continued answer"),
            source_context={"baseByteOffset": 4096},
        )
        self.assertEqual(
            [record["role"] for record in continued["records"]],
            ["meta", "assistant"],
        )

    def test_partial_fragment_keeps_external_tool_result(self) -> None:
        result = normalize_transcript(
            source="codex",
            transcript=codex_function_output("call_earlier", "command output"),
            source_context={"partial": True},
        )
        tool = next(record for record in result["records"] if record["role"] == "tool")

        self.assertEqual(tool["tool_call_id"], "call_earlier")
        self.assertEqual(tool["content"], "command output")
        self.assertNotIn(
            "orphan_tool_result",
            [diagnostic["code"] for diagnostic in result["diagnostics"]],
        )

    def test_omits_tool_results_while_retaining_calls(self) -> None:
        result = normalize_transcript(
            source="codex",
            transcript="\n".join(
                [
                    codex_message("user", "run the command"),
                    json.dumps(
                        {
                            "type": "response_item",
                            "payload": {
                                "type": "function_call",
                                "name": "exec_command",
                                "call_id": "call_1",
                                "arguments": "{}",
                            },
                        }
                    ),
                    codex_function_output("call_1", "command output"),
                ]
            ),
            filters={"toolResults": "omit"},
        )

        self.assertNotIn("tool", [record["role"] for record in result["records"]])
        self.assertTrue(
            any(
                record["role"] == "assistant" and record["content"] is None
                for record in result["records"]
            )
        )

    def test_partial_fragment_is_opt_in(self) -> None:
        with self.assertRaises(NormalizationError) as raised:
            normalize_transcript(
                source="codex",
                transcript=codex_message("assistant", "unprompted answer"),
            )

        self.assertEqual(raised.exception.code, "missing_user_records")

    def test_requires_node_20_or_newer(self) -> None:
        client._node_executable.cache_clear()
        try:
            with patch.object(client.shutil, "which", return_value=None):
                with self.assertRaisesRegex(NodeUnavailableError, "Node.js 20"):
                    normalize_transcript(source="codex", transcript="{}")
        finally:
            client._node_executable.cache_clear()

    def test_lists_trajectories_with_pagination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory) / "proj-a"
            project.mkdir()
            for name in ("s1", "s2", "s3"):
                (project / f"{name}.jsonl").write_text("{}\n", encoding="utf-8")
            subagents = project / "s1" / "subagents"
            workflows = subagents / "workflows" / "wf-1"
            workflows.mkdir(parents=True)
            (subagents / "agent-direct.jsonl").write_text(
                "{}\n", encoding="utf-8"
            )
            (workflows / "agent-workflow.jsonl").write_text(
                "{}\n", encoding="utf-8"
            )
            (workflows / "journal.jsonl").write_text(
                "{}\n", encoding="utf-8"
            )

            first = list_trajectories(
                source="claude-code", root=directory, limit=2
            )
            self.assertEqual(len(first["items"]), 2)
            self.assertIn("nextCursor", first)
            second = list_trajectories(
                source="claude-code", root=directory, cursor=first["nextCursor"]
            )
            self.assertEqual(len(second["items"]), 3)
            self.assertNotIn("nextCursor", second)
            ids = {item["id"] for item in first["items"] + second["items"]}
            self.assertEqual(ids, {"s1", "s2", "s3", "direct", "workflow"})

    @unittest.skipUnless(HAS_LANGGRAPH_SQLITE, "LangGraph SQLite extra not installed")
    def test_normalizes_deepagents_checkpoint_with_current_python(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "checkpoint.db"
            shutil.copyfile(ROOT / "fixtures/deepagents/checkpoint.db", database)
            result = normalize_checkpoint(
                thread_id="thread-123",
                path=database,
            )
            filtered = normalize_checkpoint(
                thread_id="thread-123",
                path=database,
                filters={"toolResults": "omit"},
            )
            batch = normalize_many(
                [
                    {
                        "source": "deepagents",
                        "checkpoint": {
                            "path": str(database),
                            "threadId": "thread-basic",
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
        self.assertNotIn("tool", [record["role"] for record in filtered["records"]])
        self.assertEqual(batch[0]["records"][1]["content"], "Basic thread")


if __name__ == "__main__":
    unittest.main()
