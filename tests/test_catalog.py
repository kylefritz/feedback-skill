"""The server only takes notes for pages in its catalog. Keep the catalog, the pages that
mount a Comment button and the worker's whitelist the same thing."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "example" / "public"
CATALOG = json.loads((PUBLIC / "pages.json").read_text())["pages"]
NAMES = [p["name"] for p in CATALOG]


def mounted_pages() -> dict[str, Path]:
    found = {}
    for f in [*PUBLIC.glob("*.html"), *PUBLIC.glob("*.js")]:
        for name in re.findall(r"""mountComments\(\{\s*page:\s*['"]([^'"]+)['"]""", f.read_text()):
            found[name] = f
    return found


def test_names_are_unique_and_tidy():
    assert len(NAMES) == len(set(NAMES))
    assert all(re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", n) for n in NAMES)


def test_every_catalog_page_exists():
    for p in CATALOG:
        path = p["path"].lstrip("/") or "index.html"
        assert (PUBLIC / path).exists(), p


def test_every_comment_button_is_in_the_catalog():
    mounted = mounted_pages()
    assert mounted, "no mountComments({page: ...}) found"
    assert set(mounted) == set(NAMES), (set(mounted), set(NAMES))


def test_worker_whitelist_is_the_catalog():
    assert "from './rules.js'" in (ROOT / "example" / "worker.js").read_text()
    src = (ROOT / "example" / "rules.js").read_text()
    assert "from './public/pages.json'" in src
    assert "new Set(catalog.pages.map(p => p.name))" in src


def test_worker_exports_only_its_handler():
    # workerd won't start a main module with non-handler exports (`export const ...`).
    src = (ROOT / "example" / "worker.js").read_text()
    assert re.findall(r"^export\s+(\w+)", src, re.M) == ["default"]


def test_config_has_placeholders_only():
    src = (ROOT / "example" / "wrangler.jsonc").read_text()
    assert '"account_id": "<your-account-id>"' in src
    assert '"database_id": "<your-database-id>"' in src
    assert not re.search(r"\b[0-9a-f]{32}\b", src), "a real account id slipped in"
