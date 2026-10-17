"""STAGING-ONLY helper for altE2E.mjs: runs Odito's REAL crawler image extraction and the REAL images_missing_alt_text rule on an
HTML page read from stdin, so the end-to-end check exercises the actual data contract (crawler -> finding -> identity -> write ->
recrawl -> verification), not a hand-written copy of it.

    python crawlHelper.py <page-url> < page.html   ->   {"images": [...], "issues": [before_snapshot, ...]}
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_WORKERS = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "..", "..", "python_workers"))
sys.path.insert(0, PYTHON_WORKERS)

from bs4 import BeautifulSoup  # noqa: E402
from scraper.shared.seo import extract_image_data  # noqa: E402
from scraper.workers.seo.page_analysis.rules.categories.image_rules import ImagesMissingAltTextRule  # noqa: E402


def main():
    url = sys.argv[1]
    html = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    data = {}
    extract_image_data(BeautifulSoup(html, "html.parser"), url, data)
    images = data.get("images", [])
    issues = ImagesMissingAltTextRule().evaluate({"images": images}, "64b7f3a2c9e77a0012345678", "64b7f3a2c9e77a0012345679", url)
    print(json.dumps({"images": images, "issues": [i["before_snapshot"] for i in issues]}))


if __name__ == "__main__":
    main()
