# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.48", "pillow>=10"]
# ///
"""Put a 2D note's pen marks and pins back on the page they were drawn over.

A plain page has no frame to snapshot, so its note's picture is the ink and pins on white.
This opens the note's link at the note's viewport, screenshots it, and multiplies the
picture over it (white drops out, the marks stay):

    uv run tools/overlay.py out/comments/c_xxx.jpg "http://127.0.0.1:8791/flat#y=0" 1280x800
    -> out/comments/c_xxx-on-page.png

Take the link and viewport from `comments.py show ID`. If the page has changed since the
note was written, the marks land on today's layout: say so in the reply if it matters.
Needs Chromium for Playwright once: uvx --from playwright playwright install chromium
"""

import sys
from pathlib import Path

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright


def main(picture: str, link: str, viewport: str) -> Path:
    w, h = (int(n) for n in viewport.lower().split("x"))
    marks = Image.open(picture).convert("RGB")
    shot = Path(picture).with_name(Path(picture).stem + "-page.png")
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": w, "height": h}, device_scale_factor=marks.width / w)
        page.goto(link)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(300)  # the #y= scroll runs on load
        page.screenshot(path=shot)
        b.close()
    base = Image.open(shot).convert("RGB").resize(marks.size)
    out = Path(picture).with_name(Path(picture).stem + "-on-page.png")
    ImageChops.multiply(base, marks).save(out)
    shot.unlink()
    print(out)
    return out


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
