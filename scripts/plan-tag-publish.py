#!/usr/bin/env python3
"""Validate a release tag and plan an npm retry without moving a dist-tag back."""

import argparse
import json
import re
from pathlib import Path


TAG_RE = re.compile(r"v(\d+\.\d+\.\d+)(?:-([0-9A-Za-z-]+)\.(\d+))?")


def pinned_value(path: Path, pattern: str) -> str:
    matches = re.findall(pattern, path.read_text(), flags=re.MULTILINE)
    if len(matches) != 1:
        raise ValueError(f"Expected one version pin in {path}, found {len(matches)}")
    return matches[0]


def version_order(version: str, dist_tag: str) -> tuple[int, int, int, int]:
    match = TAG_RE.fullmatch(f"v{version}")
    if match is None:
        raise ValueError(f"Cannot compare existing {dist_tag} dist-tag: {version!r}")
    base, label, number = match.groups()
    if (label or "latest") != dist_tag:
        raise ValueError(f"Existing {dist_tag} dist-tag points to {version!r}; inspect it before publishing")
    return (*map(int, base.split(".")), int(number or 0))


def plan(tag: str, root: Path, registry: dict) -> dict[str, str]:
    match = TAG_RE.fullmatch(tag)
    if match is None:
        raise ValueError(f"Expected a release tag like v1.2.3 or v1.2.3-next.1, got {tag!r}")
    base, prerelease, number = match.groups()
    npm_version = tag[1:]
    npm_tag = prerelease or "latest"
    py_label = {"a": "a", "alpha": "a", "b": "b", "beta": "b"}.get(
        (prerelease or "").lower(), "rc"
    )
    py_version = base if prerelease is None else f"{base}{py_label}{number}"

    package = json.loads((root / "package.json").read_text())
    if package.get("name") != "@letta-ai/trajectory" or package.get("version") != npm_version:
        raise ValueError("Tag, npm package name, and package.json version do not match")
    if pinned_value(root / "src/version.ts", r'^export const NORMALIZER_VERSION = "([^"]+)";$') != npm_version:
        raise ValueError("NORMALIZER_VERSION does not match the tag")
    if pinned_value(root / "pyproject.toml", r'^name = "([^"]+)"$') != "agent-trajectory":
        raise ValueError("Unexpected PyPI distribution name")
    if pinned_value(root / "pyproject.toml", r'^version = "([^"]+)"$') != py_version:
        raise ValueError("pyproject.toml version does not match the tag")
    if pinned_value(root / "python/src/trajectory/__init__.py", r'^__version__ = "([^"]+)"$') != py_version:
        raise ValueError("Python __version__ does not match the tag")

    if registry.get("name") != "@letta-ai/trajectory":
        raise ValueError("Unexpected npm registry package")
    versions = registry.get("versions")
    dist_tags = registry.get("dist-tags")
    if not isinstance(versions, dict) or not isinstance(dist_tags, dict):
        raise ValueError("npm registry metadata is missing versions or dist-tags")
    published = npm_version in versions
    if published and versions[npm_version].get("version") != npm_version:
        raise ValueError("npm registry version metadata is inconsistent")
    current = dist_tags.get(npm_tag)
    if not published and current is not None:
        target_order = version_order(npm_version, npm_tag)
        current_order = version_order(current, npm_tag)
        if current_order >= target_order:
            raise ValueError(f"Publishing {npm_version} would move npm {npm_tag} backwards from {current}")

    return {
        "npm_version": npm_version,
        "py_version": py_version,
        "npm_tag": npm_tag,
        "publish_npm": "false" if published else "true",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("release_dir", type=Path)
    parser.add_argument("npm_registry_metadata", type=Path)
    args = parser.parse_args()
    registry = json.loads(args.npm_registry_metadata.read_text())
    for key, value in plan(args.tag, args.release_dir, registry).items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()
