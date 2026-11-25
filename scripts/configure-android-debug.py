#!/usr/bin/env python3
"""Give the Debug APK a separate application ID so it can coexist with Release."""
from __future__ import annotations

import argparse
import re
from pathlib import Path


def configure(root: Path) -> bool:
    gradle_path = root / "android" / "app" / "build.gradle"
    gradle = gradle_path.read_text(encoding="utf-8")

    has_app_suffix = 'applicationIdSuffix ".debug"' in gradle
    has_version_suffix = 'versionNameSuffix "-debug"' in gradle
    if has_app_suffix and has_version_suffix:
        return False
    if has_app_suffix or has_version_suffix:
        raise ValueError("Android Debug suffix configuration is incomplete")

    build_types = list(re.finditer(r"(?m)^(?P<indent>[ \t]*)buildTypes[ \t]*\{[ \t]*$", gradle))
    if len(build_types) != 1:
        raise ValueError(
            f"Expected exactly one buildTypes {{ block in {gradle_path}; found {len(build_types)}"
        )

    match = build_types[0]
    indent = match.group("indent") + "    "
    block = (
        "\n"
        + indent + "debug {\n"
        + indent + "    applicationIdSuffix \".debug\"\n"
        + indent + "    versionNameSuffix \"-debug\"\n"
        + indent + "}\n"
    )
    gradle = gradle[:match.end()] + block + gradle[match.end():]
    gradle_path.write_text(gradle, encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        changed = configure(args.root.resolve())
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print("Android Debug applicationIdSuffix=.debug versionNameSuffix=-debug"
          if changed else "Android Debug suffix already configured")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
