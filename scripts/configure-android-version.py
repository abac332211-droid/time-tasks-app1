#!/usr/bin/env python3
"""Align generated Capacitor Android version metadata with the app sources."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


SEMVER = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")


def version_parts(value: str) -> tuple[int, int, int]:
    match = SEMVER.fullmatch(value)
    if not match:
        raise ValueError(f"Expected a stable X.Y.Z version, got: {value!r}")
    return tuple(int(part) for part in match.groups())


def android_version_code(value: str) -> int:
    major, minor, patch = version_parts(value)
    # The decimal slots must be bounded to keep SemVer tuples collision-free.
    if minor > 999 or patch > 999:
        raise ValueError("Android versionCode requires minor and patch components <= 999")
    code = major * 1_000_000 + minor * 1_000 + patch
    if code < 1 or code > 2_100_000_000:
        raise ValueError(f"Calculated Android versionCode is out of range: {code}")
    return code


def configure(root: Path) -> tuple[str, int]:
    package_path = root / "package.json"
    html_path = root / "index.html"
    sw_path = root / "sw.js"
    gradle_path = root / "android" / "app" / "build.gradle"

    package = json.loads(package_path.read_text(encoding="utf-8"))
    package_version = package.get("version")
    if not isinstance(package_version, str):
        raise ValueError("package.json must define a string version")

    html = html_path.read_text(encoding="utf-8")
    app_match = re.search(r'\bconst\s+APP_VERSION\s*=\s*["\']([^"\']+)["\']\s*;', html)
    if not app_match:
        raise ValueError("Could not find APP_VERSION in index.html")

    sw = sw_path.read_text(encoding="utf-8")
    cache_match = re.search(r'\bconst\s+CACHE_NAME\s*=\s*["\']timetasks-cache-v([^"\']+)["\']\s*;', sw)
    if not cache_match:
        raise ValueError("Could not find the versioned TimeTasks cache in sw.js")

    versions = {
        "package.json": package_version,
        "index.html": app_match.group(1),
        "sw.js": cache_match.group(1),
    }
    if len(set(versions.values())) != 1:
        details = ", ".join(f"{name}={value}" for name, value in versions.items())
        raise ValueError(f"Application version sources do not match: {details}")

    version = package_version
    version_code = android_version_code(version)
    gradle = gradle_path.read_text(encoding="utf-8")

    gradle, code_count = re.subn(
        r"(?m)^(\s*versionCode\s+)\d+\s*$",
        lambda match: f"{match.group(1)}{version_code}",
        gradle,
    )
    gradle, name_count = re.subn(
        r'(?m)^(\s*versionName\s+)["\'][^"\']+["\']\s*$',
        lambda match: f'{match.group(1)}"{version}"',
        gradle,
    )
    if code_count != 1 or name_count != 1:
        raise ValueError(
            "Expected exactly one versionCode and one versionName in "
            f"{gradle_path}; found {code_count} and {name_count}"
        )

    gradle_path.write_text(gradle, encoding="utf-8")
    return version, version_code


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        version, code = configure(args.root.resolve())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    print(f"Android versionName={version} versionCode={code}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
