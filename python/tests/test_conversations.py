import json
import unittest
from pathlib import Path

from trajectory import NormalizationError, normalize_transcript
from trajectory.conversations import group_slack_messages, normalize_conversation

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

    def test_group_slack_messages_feeds_normalize_conversation(self):
        root = {"type": "message", "user": "UALICE", "ts": "1700000000.000001", "text": "root"}
        reply = {"type": "message", "user": "UBOB", "ts": "1700000001.000001",
                 "thread_ts": "1700000000.000001", "text": "reply"}
        standalone = {"type": "message", "user": "UCAROL", "ts": "1700000002.000001", "text": ":eyes:"}
        users = [{"id": "UALICE", "profile": {"display_name": "Alice"}}]
        threads = group_slack_messages([reply, standalone, root], team="TEXAMPLE", channel="CEXAMPLE", users=users)
        self.assertEqual([t["thread_ts"] for t in threads], ["1700000000.000001", "1700000002.000001"])
        self.assertIs(threads[0]["messages"][1], root)
        result = normalize_conversation(source="slack", transcript=json.dumps(threads[0]))
        self.assertEqual(result["records"][1]["speaker"], {"id": "UALICE", "name": "Alice"})
        self.assertEqual(len(result["records"]), 3)
        with self.assertRaises(NormalizationError):
            group_slack_messages([{"type": "message", "text": "no ts"}], team="T", channel="C")
