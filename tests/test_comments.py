"""scripts/comments.py: quoting, config parsing, the wrangler call, output, and the hook."""

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("comments", ROOT / "scripts" / "comments.py")
comments = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comments)

CONFIG = ROOT / "example" / "wrangler.jsonc"


def test_q_doubles_single_quotes():
    assert comments.q("plain") == "'plain'"
    assert comments.q("it's") == "'it''s'"
    assert comments.q("'; DROP TABLE comments; --") == "'''; DROP TABLE comments; --'"


def test_q_survives_sqlite(tmp_path):
    import sqlite3

    db = sqlite3.connect(tmp_path / "t.db")
    db.execute("CREATE TABLE t (s TEXT)")
    nasty = "it's \"quoted\" -- and ; then '); DROP TABLE t; --"
    db.execute(f"INSERT INTO t VALUES ({comments.q(nasty)})")
    assert db.execute("SELECT s FROM t").fetchone()[0] == nasty


def test_strip_jsonc_keeps_urls_and_drops_comments():
    src = """{
      // a comment
      "url": "https://example.com/a//b", /* block */
      "list": [1, 2,],
      "s": "a \\" // not a comment",
    }"""
    assert json.loads(comments.strip_jsonc(src)) == {
        "url": "https://example.com/a//b",
        "list": [1, 2],
        "s": 'a " // not a comment',
    }


def test_example_config_names_the_database():
    cfg = comments.load_config(CONFIG)
    assert comments.database_name(cfg) == "feedback-comments"
    with pytest.raises(SystemExit):
        comments.database_name(cfg, "NOPE")


def test_toml_config(tmp_path):
    p = tmp_path / "wrangler.toml"
    p.write_text('name = "x"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "notes"\n')
    assert comments.find_config(None, tmp_path) == p
    assert comments.database_name(comments.load_config(p)) == "notes"


def test_find_config_errors_when_missing(tmp_path, monkeypatch):
    monkeypatch.delenv("COMMENTS_CONFIG", raising=False)
    with pytest.raises(SystemExit):
        comments.find_config(None, tmp_path)


def test_wrangler_gets_the_sql_as_one_argument(monkeypatch):
    monkeypatch.setenv("WRANGLER", "wrangler")
    d1 = comments.D1(CONFIG, "--local")
    argv = d1.argv("SELECT 'a b' FROM comments")
    assert argv[:6] == ["wrangler", "d1", "execute", "feedback-comments", "--local", "--json"]
    assert argv[-2:] == ["--command", "SELECT 'a b' FROM comments"]


def fake_run(results, seen=None):
    def run(argv, **kw):
        if seen is not None:
            seen.append((argv, kw))
        out = json.dumps([{"results": results, "success": True, "meta": {"duration": 0}}])
        return subprocess.CompletedProcess(argv, 0, out, "")

    return run


NOTE_3D = {
    "id": "c_abc1", "created": "2026-01-02T03:04:05.000Z", "page": "desk", "author": None,
    "body": "Make it walnut", "link": "http://localhost:8791/#cam=1,2,3,0,0,0", "view": "1,2,3,0,0,0",
    "viewport": "390x844", "strokes": 2, "status": "open", "reply": None, "replied": None,
    "pins": json.dumps([{"n": 1, "x": 0.1, "y": 0.76, "z": 0.0, "id": "desk", "label": "Desk, oak top"}]),
}  # fmt: skip
NOTE_2D = {
    **NOTE_3D, "id": "c_abc2", "page": "landing", "strokes": 0, "body": "",
    "pins": json.dumps([{"n": 1, "x": 120, "y": 340, "z": None, "id": '[data-comment-id="hero"]', "label": None}]),
}  # fmt: skip


def test_line():
    s = comments.line(NOTE_3D)
    assert "c_abc1" in s and "[open]" in s and "someone: Make it walnut" in s
    assert "pins: 1 Desk, oak top" in s and "pen: 2 stroke(s)" in s
    s = comments.line(NOTE_2D)
    assert "(no text)" in s and '1 [data-comment-id="hero"]' in s and "pen:" not in s


def test_show_saves_the_picture(tmp_path, monkeypatch, capsys):
    import base64

    jpeg = b"\xff\xd8\xff fake jpeg"
    row = {**NOTE_2D, "image": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}
    monkeypatch.setattr(comments.subprocess, "run", fake_run([row]))
    comments.show(comments.D1(CONFIG), "c_abc2", tmp_path)
    assert (tmp_path / "c_abc2.jpg").read_bytes() == jpeg
    out = capsys.readouterr().out
    assert "page (120, 340) px" in out and "viewport: 390x844" in out and "look at it" in out


def test_reply_quotes_the_text(monkeypatch):
    seen = []
    monkeypatch.setattr(comments.subprocess, "run", fake_run([{"id": "c_abc1"}], seen))
    comments.reply(comments.D1(CONFIG), "c_abc1", "Done: it's walnut now (PR #3)", "done")
    sql = seen[0][0][-1]
    assert "reply = 'Done: it''s walnut now (PR #3)'" in sql and "status = 'done'" in sql
    assert sql.endswith("WHERE id = 'c_abc1' RETURNING id")


def test_reply_to_a_missing_note_fails(monkeypatch):
    monkeypatch.setattr(comments.subprocess, "run", fake_run([]))
    with pytest.raises(SystemExit):
        comments.reply(comments.D1(CONFIG), "c_none", "hi", "done")


def test_hook_is_silent_with_nothing_open(monkeypatch, capsys):
    monkeypatch.setattr(comments.subprocess, "run", fake_run([]))
    assert comments.main(["--hook", "--config", str(CONFIG)]) == 0
    assert capsys.readouterr().out == ""


def test_hook_lists_open_notes(monkeypatch, capsys):
    monkeypatch.setattr(comments.subprocess, "run", fake_run([NOTE_3D]))
    assert comments.main(["--hook", "--config", str(CONFIG)]) == 0
    out = capsys.readouterr().out
    assert "feedback-example has 1 open comment(s)" in out and "c_abc1" in out and "show ID" in out


def test_hook_never_fails(monkeypatch, capsys, tmp_path):
    def broken(argv, **kw):
        return subprocess.CompletedProcess(argv, 1, "", "not logged in")

    monkeypatch.setattr(comments.subprocess, "run", broken)
    assert comments.main(["--hook", "--config", str(CONFIG)]) == 0
    assert comments.main(["--hook", "--config", str(tmp_path / "missing.jsonc")]) == 0
    assert capsys.readouterr().out == ""
