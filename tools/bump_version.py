#!/usr/bin/env python3
"""Sets the extension version everywhere, so browsers drop the cached old files.

GitHub Pages lets browsers cache files for 10 minutes; a "?v=<version>" on every
script/style URL (including the imports between modules) forces the new code.

    python tools/bump_version.py 0.2.1
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    version = sys.argv[1]
    manifest = ROOT / "manifest.json"
    manifest.write_text(re.sub(r'"version": "[^"]+"', f'"version": "{version}"', manifest.read_text(encoding="utf-8"), count=1), encoding="utf-8")

    for page in ROOT.glob("*.html"):
        text = page.read_text(encoding="utf-8")
        text = re.sub(r'((?:src|href)="(?:js|css)/[\w-]+\.(?:js|css))(\?v=[^"]*)?"', rf'\1?v={version}"', text)
        page.write_text(text, encoding="utf-8")

    for script in (ROOT / "js").glob("*.js"):
        text = script.read_text(encoding="utf-8")
        text = re.sub(r'(from "\./[\w-]+\.js)(\?v=[^"]*)?"', rf'\1?v={version}"', text)
        script.write_text(text, encoding="utf-8")
    print(f"versão {version} aplicada")


if __name__ == "__main__":
    main()
