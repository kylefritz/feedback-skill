-- Notes sent from a page's Comment button (public/comments.js -> worker.js).
-- Read and answered by scripts/comments.py.
CREATE TABLE comments (
  id TEXT PRIMARY KEY,                 -- c_<time36><rand>
  created TEXT NOT NULL,               -- ISO 8601 UTC
  page TEXT NOT NULL,                  -- a name from public/pages.json
  author TEXT,                         -- whatever name the sender typed (optional)
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL,                  -- deep link to the view it was written from
  view TEXT NOT NULL,                  -- the page's own view string: a camera, a scroll position
  viewport TEXT,                       -- WxH in CSS px, to recreate the view at the same aspect
  pins TEXT NOT NULL DEFAULT '[]',     -- [{n, x, y, z, id, label}]: 3D point + piece, or page px + selector
  strokes INTEGER NOT NULL DEFAULT 0,  -- pen strokes drawn (they exist only in the image)
  image TEXT,                          -- data:image/jpeg;base64 picture: view + pins + pen
  status TEXT NOT NULL DEFAULT 'open', -- open | done | wontfix
  reply TEXT,                          -- the agent's answer, shown on the page (public)
  replied TEXT
);
CREATE INDEX comments_page ON comments (page, created);
