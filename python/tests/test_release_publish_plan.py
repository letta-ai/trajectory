"""Guard the manual release retry against wrong tags and stale npm dist-tags."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("plan_tag_publish", ROOT / "scripts/plan-tag-publish.py")
assert spec and spec.loader
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


class ReleasePublishPlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "src").mkdir()
        (self.root / "python/src/trajectory").mkdir(parents=True)
        self.write_versions("0.4.3", "0.4.3")

    def write_versions(self, npm_version, py_version):
        (self.root / "package.json").write_text(
            json.dumps({"name": "@letta-ai/trajectory", "version": npm_version})
        )
        (self.root / "src/version.ts").write_text(
            f'export const NORMALIZER_VERSION = "{npm_version}";\n'
        )
        (self.root / "pyproject.toml").write_text(
            f'[project]\nname = "agent-trajectory"\nversion = "{py_version}"\n'
        )
        (self.root / "python/src/trajectory/__init__.py").write_text(
            f'__version__ = "{py_version}"\n'
        )

    def registry(self, latest="0.4.2", versions=None, tag="latest"):
        return {
            "name": "@letta-ai/trajectory",
            "versions": {version: {"version": version} for version in (versions or [])},
            "dist-tags": {tag: latest},
        }

    def test_publish_missing_stable_version(self):
        result = planner.plan("v0.4.3", self.root, self.registry())
        self.assertEqual(result, {
            "npm_version": "0.4.3", "py_version": "0.4.3",
            "npm_tag": "latest", "publish_npm": "true",
        })

    def test_skip_published_npm_version_before_pypi_retry(self):
        result = planner.plan("v0.4.3", self.root, self.registry("0.4.3", ["0.4.3"]))
        self.assertEqual(result["publish_npm"], "false")

    def test_pypi_retry_can_continue_when_existing_npm_version_lacks_dist_tag(self):
        result = planner.plan("v0.4.3", self.root, self.registry("0.4.2", ["0.4.3"]))
        self.assertEqual(result["publish_npm"], "false")
        result = planner.plan("v0.4.3", self.root, self.registry(versions=["0.4.3"], tag="next"))
        self.assertEqual(result["publish_npm"], "false")

    def test_refuse_to_move_latest_backwards(self):
        with self.assertRaisesRegex(ValueError, "move npm latest backwards"):
            planner.plan("v0.4.3", self.root, self.registry("0.4.4"))

    def test_prerelease_normalizes_python_version_and_uses_own_dist_tag(self):
        self.write_versions("0.4.4-next.2", "0.4.4rc2")
        result = planner.plan("v0.4.4-next.2", self.root, self.registry("0.4.4-next.1", tag="next"))
        self.assertEqual(result["npm_tag"], "next")
        self.assertEqual(result["py_version"], "0.4.4rc2")
        self.assertEqual(result["publish_npm"], "true")

    def test_reject_mismatched_python_pin(self):
        self.write_versions("0.4.3", "0.4.2")
        with self.assertRaisesRegex(ValueError, "pyproject.toml version"):
            planner.plan("v0.4.3", self.root, self.registry())

    def test_reject_non_version_ref(self):
        with self.assertRaisesRegex(ValueError, "Expected a release tag"):
            planner.plan("main", self.root, self.registry())


if __name__ == "__main__":
    unittest.main()
