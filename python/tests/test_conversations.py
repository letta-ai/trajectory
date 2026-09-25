import json
import unittest
from pathlib import Path

from trajectory import NormalizationError, normalize_transcript
from trajectory.conversations import normalize_conversation

ROOT = Path(__file__).resolve().parents[2]


class ConversationTests(unittest.TestCase):
    def test_slack_fixtures_match_separate_api(self):
        for name in ("thread", "cleanup", "rich-thread", "channel"):
            directory = ROOT / "fixtures" / "slack" / name
            fixture = json.loads((directory / "input.json").read_text())
            result = normalize_conversation(
                source="slack", transcript=json.dumps(fixture["messages"]),
                channel=fixture["channel"], channel_name=fixture.get("channel_name"), users=fixture.get("users"),
            )
            self.assertEqual(result, json.loads((directory / "expected.json").read_text()))

    def test_agent_api_does_not_accept_slack(self):
        with self.assertRaises(NormalizationError) as caught:
            normalize_transcript(source="slack", transcript="{}")
        self.assertEqual(caught.exception.code, "unknown_source")

    def test_bad_conversation_reports_input_error(self):
        with self.assertRaises(NormalizationError) as caught:
            normalize_conversation(source="slack", transcript="{}", channel="C")
        self.assertEqual(caught.exception.code, "invalid_input")

    def test_conversation_api_does_not_accept_agent_sources(self):
        with self.assertRaises(NormalizationError) as caught:
            normalize_conversation(source="codex", transcript="{}", channel="C")
        self.assertEqual(caught.exception.code, "unknown_source")

    def test_channel_dump_becomes_one_nested_conversation(self):
        root = {"type": "message", "user": "UALICE", "ts": "1700000000.000001", "text": "root"}
        reply = {"type": "message", "user": "UBOB", "ts": "1700000001.000001",
                 "thread_ts": "1700000000.000001", "text": "reply"}
        standalone = {"type": "message", "user": "UCAROL", "ts": "1700000002.000001", "text": ":eyes:"}
        users = [{"id": "UALICE", "profile": {"display_name": "Alice"}}]
        jsonl = "".join(json.dumps(r) + "\n" for r in (reply, standalone, root))
        result = normalize_conversation(source="slack", transcript=jsonl, channel="CEXAMPLE", users=users)
        self.assertEqual(result["records"][0], {
            "role": "meta", "source": "slack", "channel": "CEXAMPLE",
            "participants": {"Alice": {"id": "UALICE"}, "UBOB": {"id": "UBOB"}, "UCAROL": {"id": "UCAROL"}},
        })
        self.assertEqual([r["id"] for r in result["records"][1:]], ["1700000000.000001", "1700000002.000001"])
        self.assertEqual(result["records"][1]["speaker"], "Alice")
        self.assertEqual([r["id"] for r in result["records"][1]["replies"]], ["1700000001.000001"])
        self.assertNotIn("replies", result["records"][2])
        self.assertEqual(result, normalize_conversation(
            source="slack", transcript=json.dumps({"ok": True, "messages": [root, reply, standalone]}),
            channel="CEXAMPLE", users=users,
        ))
        with self.assertRaises(NormalizationError):
            normalize_conversation(source="slack", transcript=jsonl, channel="")

    def test_channel_name_and_empty_channel(self):
        result = normalize_conversation(source="slack", transcript="", channel="CEXAMPLE", channel_name="eng-deploys")
        self.assertEqual(result, {
            "records": [{"role": "meta", "source": "slack", "channel": "CEXAMPLE",
                         "channel_name": "eng-deploys", "participants": {}}],
            "diagnostics": [],
        })
