---
name: feedback
description: Put a Comment button on a web page (a 3D viewer, a plain page, a prototype) so people can point at things, draw with a pen, write a note and send it, then pick those notes up as a coding agent, look at each one's picture, act, and reply so the answer shows on the page. Use when someone wants feedback, comments, annotations or markup on a page or 3D model, when a session starts with open comments from a SessionStart hook, when asked to read, answer or close comments or notes from a site, or when setting up the Worker + D1 backend, the comments.py script or the hook.
---

# feedback

A person leaves a note on the page. A coding agent picks it up, looks at it, does the work,
and replies. The reply shows under the note on the page.

```
person: Comment -> pins / pen / note -> Send
  -> worker.js (POST /api/comments) -> D1 row + JPEG of the view
agent: session starts -> hook lists open notes -> comments.py show ID -> LOOK at the picture
  -> edit -> PR -> deploy -> comments.py reply ID "what changed (PR link)"
person: opens Comment -> "Earlier notes" -> the reply, "Go there", "Picture"
```

The repo this skill ships in has a working example: `example/public/` (a three.js desk and
a plain landing page), `example/worker.js`, `example/migrations/`, `example/wrangler.jsonc`,
and `scripts/comments.py`.

## Handling notes (the usual job)

1. **List them.** A SessionStart hook prints open notes when a session starts. Otherwise run
   `uv run scripts/comments.py` (add `--config path/to/wrangler.jsonc` if the config isn't
   in the current folder, `--local` for `wrangler dev`'s database, `--all` for closed ones).
2. **Read each one in full:** `uv run scripts/comments.py show ID`. It prints the note, the
   link, the view, the viewport, every pin, and saves the picture to `out/comments/ID.jpg`.
3. **Look at the picture.** Open the JPEG with your image-reading tool, every time. Pen
   marks exist only in the picture: the database has a stroke count, not the strokes. A
   note that says "move this" with a circle means nothing until you've seen the circle.
   - **3D page:** the picture is the frame they saw, with the ink and numbered pins on it.
     Each pin carries its 3D point and, if the model has them, the piece's `id` and
     `label` (from glTF extras). Use the id to find the piece in the source.
   - **2D page:** the picture is the ink and pins on white (a page's DOM can't be
     snapshotted like a canvas). Run `uv run tools/overlay.py out/comments/ID.jpg LINK WxH`
     with the link and viewport from `show`: it screenshots the page at that size and
     multiplies the marks onto it. Pins carry a CSS selector (`id`) and the tapped text.
4. **When nothing was marked** (no pins, no pen), the note carries only the view. Recreate
   it: open the link in a browser at the note's viewport (same aspect ratio, or the
   framing changes), screenshot it, and for 3D raycast from the middle of the frame to see
   what was in front of them. Still unsure what they meant? Don't guess at a change: reply
   with a question and leave it `--status open`.
5. **Do the work** the way the repo does work: branch, edit, test, PR with screenshots,
   merge, deploy. Check the deployed page shows the change.
6. **Reply** with what changed and where, in a sentence or two:
   `uv run scripts/comments.py reply ID "Lowered the shelf 2 in and made it walnut (PR #41)."`
   `--status done` is the default; `wontfix` says why not; `open` asks a question back.
   **Replies are public.** Anyone who can open the page can read them. No private details,
   no names beyond what the note itself used, no internal links that leak anything.
7. Tell the user what came in and what you did, with the PR links.

Don't reply "done" before the change is live: the person will go look.

## Adding it to a site

1. **Server.** Copy `example/worker.js`, `example/rules.js` and
   `example/migrations/0001_comments.sql`. In `wrangler.jsonc`: `main`, an `assets` block
   with `"run_worker_first": ["/api/*"]` (only the API runs the script; static files stay
   free), a `d1_databases` entry with binding `DB`, and `vars.ALLOWED_ORIGINS` set to the
   site's origin. Create the database (`wrangler d1 create <name>`, put its id in the
   config), then `wrangler d1 migrations apply <name> --remote`, then `wrangler deploy`.
   Ask the user before creating cloud resources or deploying.
2. **Catalog.** List every page that gets a button in a `pages.json` (`name`, `title`,
   `path`). The worker builds its whitelist from it, and `tests/test_catalog.py` checks
   every `mountComments({page: ...})` is in it. A page missing from the catalog gets
   "unknown page" on Send; keep them equal with that test.
3. **Page.** Add `comments.css` and `comments.js`, then call `mountComments` with an
   adapter. Plain page: `mountComments({page: 'pricing', ...domAdapter()})`. 3D: see
   `example/public/scene.js`, which supplies `pick` (raycast), `project` (3D point to
   screen), `frame` (render, return the canvas), `view`/`goTo`/`link` (the camera), `hold`
   (disable the orbit controls), and calls `tick()` in the render loop. Give pieces
   `{id, label}` in glTF extras so a pin says what it's on.
   Behind a login (Cloudflare Access): `vars.AUTHOR_FROM_ACCESS = "1"` and
   `mountComments({..., me: './api/me'})`, so notes carry the signed-in email instead of a
   typed name (README, "Signed-in sites").
4. **Agent side.** Copy `scripts/comments.py` (standard library only; needs a wrangler
   login, no token in the repo) and add the SessionStart hook:

   ```json
   {"hooks": {"SessionStart": [{"matcher": "startup|resume", "hooks": [{"type": "command",
     "command": "cd \"$CLAUDE_PROJECT_DIR\" && uv run --quiet scripts/comments.py --hook",
     "timeout": 30}]}]}}
   ```

   in `.claude/settings.json`. `--hook` prints nothing when nothing is open, and never
   fails a session start (offline, logged out, no config: silent).
5. **Test locally:** `wrangler d1 migrations apply <name> --local`, then `wrangler dev`, send
   a note with a pin and a pen stroke, then `comments.py --local`, `show`, `reply`, and check
   the reply on the page. `tools/demo.py` does the browser half for the example.

## Lessons (each one happened)

1. **The ink canvas goes under the panel.** Above it (z-index), the pen takes the tap on
   Send and the note never goes.
2. **Don't reset the tool after sending.** In Point mode a drag orbits the camera. Someone
   who sent one note and kept circling things orbited instead, and the next note arrived
   with no circle. comments.js keeps the tool they were using.
3. **A note with no pins and no pen has only the camera.** Recreate the view at the
   picture's aspect ratio and raycast to see what's there; if it's still unclear, reply
   with a question instead of guessing.
4. **`wrangler dev` may not support a brand-new `compatibility_date`.** Its bundled workerd
   refuses dates newer than itself. Pin a date it supports (the example pins one).
5. **The endpoint is public.** No login: a honeypot field, size caps (4000-char note, 40
   pins, 1.5 MB picture), a page whitelist and a link check. If spam shows up, add
   Turnstile or Cloudflare Access on `/api/*`. Replies are public too.
6. **Keep the whitelist equal to the catalog, with a test.** A page added without its
   whitelist entry silently loses every note.
7. **A Worker's main module may only export handlers.** `export const PAGES` next to
   `export default` makes workerd refuse to start ("Incorrect type for map entry"). Shared
   constants live in `rules.js`.
8. **WebGL needs `preserveDrawingBuffer: true`** (or a render right before reading the
   canvas), or the picture is blank.
9. **Local D1 doesn't report `meta.changes`.** comments.py uses `UPDATE ... RETURNING id`
   to tell a reply to a missing note from a real one.
10. **Two servers can share a port.** `localhost` may resolve to IPv6 while `wrangler dev`
    listens on IPv4 127.0.0.1. If the page 404s with someone else's error page, check
    `lsof -iTCP:PORT -sTCP:LISTEN` and use `127.0.0.1`.

## Data

`comments` table (`example/migrations/0001_comments.sql`): `id`, `created`, `page`,
`author` (optional, typed by the sender), `body`, `link`, `view` (the page's own view
string: a camera `px,py,pz,tx,ty,tz`, or a scroll `x,y`), `viewport` (`WxH`), `pins` (JSON
`[{n, x, y, z, id, label}]`; 2D pins have page pixels and `z: null`), `strokes` (a count),
`image` (data URL JPEG), `status` (`open|done|wontfix`), `reply`, `replied`.
