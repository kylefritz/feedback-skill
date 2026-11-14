# /// script
# requires-python = ">=3.11"
# ///
"""Read and answer the notes people send from a page's Comment button.

Notes live in a D1 database (worker.js writes them). This reads it with
`wrangler d1 execute --json`, so it needs a wrangler login on this machine and nothing else:
no API token in the repo. The database is the `DB` binding in your wrangler config.

    uv run scripts/comments.py                  # open notes, one line each
    uv run scripts/comments.py --all            # every note
    uv run scripts/comments.py show ID          # one note in full; picture -> out/comments/ID.jpg
    uv run scripts/comments.py reply ID "text" [--status done|wontfix|open]
    uv run scripts/comments.py --hook           # SessionStart hook: silent unless notes are open
    uv run scripts/comments.py --local ...      # against `wrangler dev`'s local database
    uv run scripts/comments.py --config path/to/wrangler.jsonc ...

The config is --config, else $COMMENTS_CONFIG, else wrangler.jsonc / wrangler.json /
wrangler.toml in the current directory. wrangler runs from the config's folder, so --local
reads the same .wrangler/state that `wrangler dev` writes there. Set $WRANGLER to change how
wrangler is run (default: `wrangler` on PATH, else `npx --yes wrangler@4`).

A reply shows under the note in the page's "Earlier notes", for anyone to read.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shlex
import shutil
import subprocess
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path

FIELDS = (
    "id, created, page, author, body, link, view, viewport, pins, strokes, status, reply, replied"
)
STATUSES = ("done", "wontfix", "open")


def q(s: str) -> str:
    """A SQL string literal. The command goes to wrangler as one argv entry (no shell), so
    doubling single quotes is the only escaping SQLite needs."""
    return "'" + str(s).replace("'", "''") + "'"


def strip_jsonc(src: str) -> str:
    """JSONC -> JSON: drop // and /* */ comments outside strings, and trailing commas."""
    out, i, n, in_str = [], 0, len(src), False
    while i < n:
        ch = src[i]
        if in_str:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if ch == '"':
                in_str = False
            i += 1
        elif ch == '"':
            in_str = True
            out.append(ch)
            i += 1
        elif src.startswith("//", i):
            while i < n and src[i] != "\n":
                i += 1
        elif src.startswith("/*", i):
            end = src.find("*/", i + 2)
            i = n if end < 0 else end + 2
        elif ch == ",":
            j = i + 1
            while j < n and src[j] in " \t\r\n":
                j += 1
            if j < n and src[j] in "}]":
                i += 1  # trailing comma
                continue
            out.append(ch)
            i += 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def find_config(explicit: str | None, cwd: Path) -> Path:
    if explicit or os.environ.get("COMMENTS_CONFIG"):
        path = Path(explicit or os.environ["COMMENTS_CONFIG"]).expanduser()
        if not path.is_absolute():
            path = cwd / path
        if not path.exists():
            raise SystemExit(f"no wrangler config at {path}")
        return path
    for name in ("wrangler.jsonc", "wrangler.json", "wrangler.toml"):
        if (cwd / name).exists():
            return cwd / name
    raise SystemExit("no wrangler config here; pass --config path/to/wrangler.jsonc")


def load_config(path: Path) -> dict:
    text = path.read_text()
    if path.suffix == ".toml":
        return tomllib.loads(text)
    return json.loads(strip_jsonc(text))


def database_name(cfg: dict, binding: str = "DB") -> str:
    for db in cfg.get("d1_databases", []):
        if db.get("binding") == binding:
            return db["database_name"]
    raise SystemExit(f"no d1_databases entry with binding {binding!r} in the wrangler config")


def wrangler_cmd() -> list[str]:
    if os.environ.get("WRANGLER"):
        return shlex.split(os.environ["WRANGLER"])
    return ["wrangler"] if shutil.which("wrangler") else ["npx", "--yes", "wrangler@4"]


class D1:
    def __init__(self, config: Path, where: str = "--remote", binding: str = "DB"):
        self.config, self.where = config, where
        cfg = load_config(config)
        self.db, self.site = database_name(cfg, binding), cfg.get("name", "the site")

    def argv(self, command: str) -> list[str]:
        return [*wrangler_cmd(), "d1", "execute", self.db, self.where, "--json",
                "--config", str(self.config), "--command", command]  # fmt: skip

    def run(self, command: str, timeout: int = 60) -> dict:
        r = subprocess.run(
            self.argv(command), capture_output=True, text=True, timeout=timeout,
            cwd=self.config.parent,
        )  # fmt: skip
        if r.returncode:
            raise SystemExit(f"wrangler d1 failed:\n{r.stderr.strip() or r.stdout.strip()}")
        return json.loads(r.stdout)[0]

    def rows(self, command: str, timeout: int = 60) -> list[dict]:
        return self.run(command, timeout)["results"]


def where_pin(p: dict) -> str:
    if p.get("z") is None:
        return f"page ({p['x']}, {p['y']}) px"
    return f"({p['x']}, {p['y']}, {p['z']})"


def line(c: dict) -> str:
    pins = json.loads(c["pins"]) if isinstance(c["pins"], str) else c["pins"]
    bits = [f"{c['id']}  {c['created'][:16].replace('T', ' ')}Z  {c['page']}  [{c['status']}]"]
    bits.append(f"  {c['author'] or 'someone'}: {c['body'] or '(no text)'}")
    if pins:
        bits.append(
            "  pins: " + "; ".join(f"{p['n']} {p['label'] or p['id'] or 'a spot'}" for p in pins)
        )
    if c["strokes"]:
        bits.append(f"  pen: {c['strokes']} stroke(s), see the picture")
    if c["reply"]:
        bits.append(f"  reply: {c['reply']}")
    return "\n".join(bits)


def show(d1: D1, cid: str, out: Path) -> None:
    rows = d1.rows(f"SELECT {FIELDS}, image FROM comments WHERE id = {q(cid)}")
    if not rows:
        raise SystemExit(f"no note {cid}")
    c = rows[0]
    print(line(c))
    print(f"  link: {c['link']}")
    print(f"  view: {c['view']}  viewport: {c['viewport'] or '?'}")
    for p in json.loads(c["pins"]):
        print(f"  pin {p['n']}: {where_pin(p)}  id={p['id']}  {p['label'] or ''}")
    if c["image"]:
        out.mkdir(parents=True, exist_ok=True)
        path = out / f"{cid}.jpg"
        path.write_bytes(base64.b64decode(c["image"].split(",", 1)[1]))
        print(f"  picture: {path}  (look at it: pen marks exist only in the picture)")
    elif c["strokes"]:
        print("  picture: none was sent, so the pen marks are lost; ask in the reply")


def reply(d1: D1, cid: str, text: str, state: str) -> None:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    # RETURNING, not meta.changes: local D1 doesn't report changes.
    done = d1.rows(
        f"UPDATE comments SET reply = {q(text)}, status = {q(state)}, replied = {q(now)} "
        f"WHERE id = {q(cid)} RETURNING id"
    )
    if not done:
        raise SystemExit(f"no note {cid}")
    print(f"{cid}: {state}, replied")


def hook_text(site: str, rows: list[dict], script: str) -> str:
    if not rows:
        return ""
    return "\n".join(
        [
            f"{site} has {len(rows)} open comment(s) from its Comment button. Read each with",
            f"`uv run {script} show ID` and look at its picture, act on it, then answer with",
            f'`uv run {script} reply ID "what changed, with the PR link"`. Mention them to the user.',
            "",
            *(line(c) for c in rows),
        ]
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("action", nargs="?", choices=["list", "show", "reply"], default="list")
    ap.add_argument("id", nargs="?")
    ap.add_argument("text", nargs="?")
    ap.add_argument("--status", choices=STATUSES, default="done")
    ap.add_argument("--all", action="store_true", help="every note, not only open ones")
    ap.add_argument("--hook", action="store_true", help="quiet unless notes are open; never fails")
    ap.add_argument("--local", action="store_true", help="the local database `wrangler dev` uses")
    ap.add_argument("--config", help="wrangler.jsonc / .json / .toml (default: ./wrangler.*)")
    ap.add_argument("--binding", default="DB", help="the D1 binding name (default DB)")
    ap.add_argument("--out", default="out/comments", help="where `show` saves pictures")
    a = ap.parse_args(argv)
    try:
        d1 = D1(find_config(a.config, Path.cwd()), "--local" if a.local else "--remote", a.binding)
    except (SystemExit, OSError, ValueError, KeyError):
        if a.hook:
            return 0
        raise
    if a.action == "show":
        show(d1, a.id or ap.error("show needs an ID"), Path(a.out))
        return 0
    if a.action == "reply":
        if not (a.id and a.text):
            ap.error("reply needs an ID and the text")
        reply(d1, a.id, a.text, a.status)
        return 0
    where = "" if a.all else "WHERE status = 'open'"
    try:
        rows = d1.rows(f"SELECT {FIELDS} FROM comments {where} ORDER BY created", 20 if a.hook else 60)
    except (SystemExit, subprocess.TimeoutExpired, OSError, ValueError, KeyError, IndexError) as e:
        if a.hook:
            return 0  # offline or logged out: a session start shouldn't fail over it
        raise SystemExit(str(e)) from None
    if a.hook:
        script = os.path.relpath(__file__)
        cfg = f" --config {os.path.relpath(d1.config)}" if a.config else ""
        loc = " --local" if a.local else ""
        text = hook_text(d1.site, rows, f"{script}{cfg}{loc}")
        if text:
            print(text)
        return 0
    print("\n".join(line(c) for c in rows) or ("no notes" if a.all else "no open notes"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
