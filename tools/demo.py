# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.48"]
# ///
"""Drive the example like a person would, against `make dev`, and take the README shots.

    uv run tools/demo.py send   [URL]   # a pin and a pen circle on each page, then Send
    uv run tools/demo.py replies [URL]  # after replying with comments.py: the replies on the page

Screenshots go to docs/img/. Needs Chromium for Playwright once:
    uvx --from playwright playwright install chromium
"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "docs" / "img"
PHONE = {"viewport": {"width": 390, "height": 844}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True}  # fmt: skip
DESKTOP = {"viewport": {"width": 1280, "height": 800}, "device_scale_factor": 1}
DESK_CAM = "cam=1.4,1.45,1.6,0,0.76,0"  # looks at the desk top, so the middle of the screen is the desk


def tap(page, x, y):
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.up()


def circle(page, cx, cy, r, steps=28):
    import math

    page.mouse.move(cx + r, cy)
    page.mouse.down()
    for i in range(1, steps + 1):
        a = 2 * math.pi * i / steps
        page.mouse.move(cx + r * math.cos(a), cy + r * 0.8 * math.sin(a))
    page.mouse.up()


def note(page, text, author="Sam"):
    page.fill(".fb textarea", text)
    page.fill(".fb-author", author)


def sent(page):
    page.click("[data-act=send]")
    page.wait_for_selector(".fb-toast:has-text('Sent')")
    page.wait_for_selector(".fb-list[open] li")


def send(base):
    IMG.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        # 3D, phone: pin the desk, circle the monitor with the pen.
        page = b.new_context(**PHONE).new_page()
        page.goto(f"{base}/#{DESK_CAM}")
        page.wait_for_timeout(800)
        page.click(".fb-button")
        tap(page, 195, 422)
        page.wait_for_selector(".fb-pin")
        page.click("[data-tool=pen]")
        circle(page, 230, 300, 55)
        note(page, "Could the desk be walnut? And the circled monitor should sit lower.")
        page.screenshot(path=IMG / "phone-3d-note.png")
        sent(page)
        # Lesson: after Send the tool stays Pen, so a second circle is ink, not an orbit.
        assert page.get_attribute("[data-tool=pen]", "aria-pressed") == "true"

        # 2D, desktop: pin the price, circle the hero button.
        page = b.new_context(**DESKTOP).new_page()
        page.goto(f"{base}/flat.html")
        page.wait_for_timeout(300)
        page.click(".fb-button")
        box = page.locator(".price strong").bounding_box()
        tap(page, box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.wait_for_selector(".fb-pin")
        page.click("[data-tool=pen]")
        cta = page.locator(".hero .cta").bounding_box()
        circle(page, cta["x"] + cta["width"] / 2, cta["y"] + cta["height"] / 2, cta["width"] * 0.7)
        note(page, "Is $12 a season right? The circled button reads small.", "Alex")
        page.screenshot(path=IMG / "desktop-2d-note.png")
        sent(page)
        b.close()
    print("sent two notes; screenshots in docs/img/")


def replies(base):
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        page = b.new_context(**PHONE).new_page()
        page.goto(f"{base}/#{DESK_CAM}")
        page.wait_for_timeout(800)
        page.click(".fb-button")
        page.click(".fb-list summary")
        page.wait_for_selector(".fb-reply")
        page.screenshot(path=IMG / "phone-3d-reply.png")
        page = b.new_context(**DESKTOP).new_page()
        page.goto(f"{base}/flat.html")
        page.click(".fb-button")
        page.click(".fb-list summary")
        page.wait_for_selector(".fb-reply")
        page.screenshot(path=IMG / "desktop-2d-reply.png")
        b.close()
    print("replies show on both pages; screenshots in docs/img/")


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "send"
    base = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8791").rstrip("/")
    {"send": send, "replies": replies}[action](base)
