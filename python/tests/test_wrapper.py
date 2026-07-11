import json
import unittest
from pathlib import Path
from unittest.mock import patch

import trajectory._client as client
from trajectory import (
    NodeUnavailableError,
    NormalizationError,
    normalize_many,
    normalize_transcript,
)

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = (
    ("claude-code", "claude-code/tool-call", "input.jsonl"),
    ("claude-code", "claude-code/cleanup", "input.jsonl"),
    ("codex", "codex/tool-calls", "input.jsonl"),
    ("codex", "codex/cleanup", "input.jsonl"),
    ("langsmith", "langsmith/tool-call", "input.jsonl"),
    ("langsmith", "langsmith/cleanup", "input.jsonl"),
    ("letta", "letta/tool-call", "input.json"),
    ("letta", "letta/cleanup", "input.json"),
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
        invalid = {"source": "not-a-source", "transcript": "{}"}

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


if __name__ == "__main__":
    unittest.main()
