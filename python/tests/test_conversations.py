import json
import unittest
from pathlib import Path

from trajectory import NormalizationError, normalize_transcript
from trajectory.conversations import normalize_conversation

ROOT = Path(__file__).resolve().parents[2]


class ConversationTests(unittest.TestCase):
    def test_slack_fixtures_match_separate_api(self):
        for name in ("thread", "cleanup", "rich-thread"):
            directory = ROOT / "fixtures" / "slack" / name
            result = normalize_conversation(source="slack", transcript=(directory / "input.json").read_text())
            self.assertEqual(result, json.loads((directory / "expected.json").read_text()))

    def test_agent_api_does_not_accept_slack(self):
        with self.assertRaises(NormalizationError) as caught:
            normalize_transcript(source="slack", transcript="{}")
        self.assertEqual(caught.exception.code, "unknown_source")

    def test_bad_conversation_reports_input_error(self):
        with self.assertRaises(NormalizationError) as caught:
            normalize_conversation(source="slack", transcript="{}")
        self.assertEqual(caught.exception.code, "invalid_input")

    def test_conversation_api_does_not_accept_agent_sources(self):
        with self.assertRaises(NormalizationError) as caught:
            normalize_conversation(source="codex", transcript="{}")
        self.assertEqual(caught.exception.code, "unknown_source")
