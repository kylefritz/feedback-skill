// comments.js: a Comment button for any web page. Plain JS, no framework, no build step.
//
// Someone taps things to drop numbered pins, or draws with a pen, writes a note and sends
// it. The note goes to POST /api/comments (worker.js stores it in D1) with a JPEG of what
// they were looking at, pins and ink drawn in. A coding agent reads it with
// scripts/comments.py, acts on it and replies; the reply shows under "Earlier notes".
//
// The page tells this module how to find things, through an adapter:
//
//   mountComments({
//     page: 'desk',            // a name the server's catalog (pages.json) knows
//     target,                  // element whose taps become pins (a 3D canvas; document for a 2D page)
//     pick(x, y),              // client px -> {x, y, z, id, label} | null: what's under a tap
//                              //   (extra fields stay in the browser for project(); not `dot`)
//     project(pin),            // -> [clientX, clientY] | null (off screen): where the pin is now
//     frame(),                 // -> canvas | null: the picture under the ink (WebGL: render first)
//     view(),                  // -> string: camera or scroll, stored and handed back to goTo
//     goTo(view),              // put the page back where a note was written
//     link(),                  // -> deep link to this view
//     hold(on),                // stop the camera or scrolling while there is ink on screen
//     button,                  // optional: your own Comment button (else one is added)
//     me,                      // optional: URL answering {email} when the site has sign-in
//                              //   (e.g. Cloudflare Access); the panel shows who is signed in
//                              //   instead of a name box, and the server stamps the author
//   })
//
// It returns {open, close, isOpen, tick, refresh}. Call tick() every frame in a 3D render
// loop so pins follow the camera; on a 2D page scrolling and resizing call it for you.
// domAdapter() below is a ready adapter for an ordinary page (pins on elements).

const INK = '#ff5a36', TAP_SLOP_PX = 6, MAX_PICTURE_PX = 1600, MAX_IMAGE_CHARS = 1_400_000;

export function mountComments(o) {
  const api = o.api || './api/comments', key = o.storageKey || 'feedback-author';
  let open = false, tool = 'point', pins = [], strokes = [], undo = [], live = null, press = null;

  const root = document.createElement('div');
  root.className = 'fb';
  root.innerHTML = `
<canvas class="fb-ink" aria-hidden="true"></canvas><div class="fb-pins" aria-hidden="true"></div>
<section class="fb-panel" hidden aria-label="Comment">
  <div class="fb-row"><div class="fb-tools" role="group" aria-label="Mark"><button type="button" data-tool="point">Point at things</button><button type="button" data-tool="pen">Pen</button></div><button type="button" class="fb-plain" data-act="undo">Undo</button></div>
  <p class="fb-hint"></p>
  <textarea rows="3" maxlength="4000" placeholder="What should change, or what is this?"></textarea>
  <div class="fb-row"><input class="fb-author" maxlength="60" placeholder="Your name (optional)" autocomplete="name"><input class="fb-hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button type="button" class="fb-plain" data-act="cancel">Cancel</button><button type="button" class="fb-send" data-act="send">Send</button></div>
  <details class="fb-list"><summary>Earlier notes</summary><ol></ol></details>
</section>
<div class="fb-toast" role="status" hidden></div>`;
  document.body.append(root);
  const $ = s => root.querySelector(s);
  const ink = $('.fb-ink'), g = ink.getContext('2d'), panel = $('.fb-panel'), layer = $('.fb-pins');
  const note = $('textarea'), author = $('.fb-author'), send = $('[data-act=send]');
  let button = o.button;
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'fb-button';
    button.textContent = '✎ Comment';
    root.append(button);
  }
  try { author.value = localStorage.getItem(key) || ''; } catch {}
  let signedIn = false;
  if (o.me) {
    fetch(o.me, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(d => {
      if (!d?.email) return;
      signedIn = true; author.value = d.email; author.hidden = true;
      const who = document.createElement('span');
      who.className = 'fb-who'; who.textContent = d.email; who.title = 'Signed in';
      author.after(who);
    }).catch(() => {});
  }

  function toast(msg) {
    const t = $('.fb-toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 2800);
  }

  // Ink lives in client pixels on a full-window canvas. It sits *under* the panel (CSS
  // z-index): above it, it would take the pen's taps on Send.
  function sizeInk() { const r = Math.min(devicePixelRatio || 1, 2); ink.width = innerWidth * r; ink.height = innerHeight * r; drawInk(); }
  function paint(ctx) {
    ctx.lineCap = ctx.lineJoin = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = INK;
    for (const st of strokes) {
      ctx.beginPath();
      st.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (st.length === 1) ctx.lineTo(st[0][0] + 0.1, st[0][1]);
      ctx.stroke();
    }
  }
  function drawInk() { const r = ink.width / innerWidth; g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, innerWidth, innerHeight); paint(g); }

  // The view holds still while there is ink on it: the ink is on the screen, not on the things.
  function sync() {
    o.hold?.(open && (tool === 'pen' || strokes.length > 0));
    root.classList.toggle('fb-inking', open && tool === 'pen');
    $('.fb-hint').textContent = tool === 'pen'
      ? 'Draw on the view. It holds still while there is drawing on it; Undo to free it.'
      : strokes.length ? 'Tap things to number them. The view holds still while there is drawing on it.'
        : 'Tap things to number them. Drag or scroll to move around; pins stay put.';
    root.querySelectorAll('[data-tool]').forEach(b => { const on = b.dataset.tool === tool; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    $('[data-act=undo]').disabled = !undo.length;
  }

  function tick() {
    for (const p of pins) {
      const at = open ? o.project(p) : null;
      p.dot.hidden = !at;
      if (at) { p.dot.style.left = at[0] + 'px'; p.dot.style.top = at[1] + 'px'; }
    }
  }

  function addPin(x, y) {
    const hit = o.pick(x, y);
    if (!hit) return;
    const el = document.createElement('div');
    el.className = 'fb-pin'; el.textContent = pins.length + 1; layer.append(el);
    pins.push({ ...hit, dot: el }); undo.push('pin');
    if (hit.label) toast(`${pins.length}: ${hit.label}`);
    tick(); sync();
  }

  function clear() { for (const p of pins) p.dot.remove(); pins = []; strokes = []; undo = []; drawInk(); }

  function setOpen(on) {
    open = on; panel.hidden = !on; button.hidden = on;
    document.body.classList.toggle('fb-noting', on);
    if (on) { tool = 'point'; sizeInk(); refresh(); } else clear();
    sync(); tick();
  }

  // Taps (not drags: a drag still orbits or scrolls) on the target become pins.
  const inside = e => root.contains(e.target) || button.contains(e.target);
  const target = o.target || document;
  target.addEventListener('pointerdown', e => { press = open && tool === 'point' && e.isPrimary && !inside(e) ? { x: e.clientX, y: e.clientY } : null; });
  target.addEventListener('pointerup', e => {
    if (!press) return;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP_PX;
    press = null;
    if (!moved) addPin(e.clientX, e.clientY);
  });
  target.addEventListener('pointercancel', () => { press = null; });
  // While the panel is open a tap marks a thing; it doesn't follow the link or press the button.
  document.addEventListener('click', e => { if (open && !inside(e)) { e.preventDefault(); e.stopPropagation(); } }, true);

  ink.addEventListener('pointerdown', e => {
    if (tool !== 'pen') return;
    ink.setPointerCapture(e.pointerId);
    live = [[e.clientX, e.clientY]]; strokes.push(live); undo.push('stroke');
    drawInk(); sync();
  });
  ink.addEventListener('pointermove', e => { if (live && ink.hasPointerCapture(e.pointerId)) { live.push([e.clientX, e.clientY]); drawInk(); } });
  ink.addEventListener('pointerup', () => { live = null; });
  ink.addEventListener('pointercancel', () => { live = null; });

  root.querySelectorAll('[data-tool]').forEach(b => { b.onclick = () => { tool = b.dataset.tool; sync(); }; });
  $('[data-act=undo]').onclick = () => {
    const last = undo.pop();
    if (last === 'pin') pins.pop().dot.remove();
    else if (last === 'stroke') { strokes.pop(); drawInk(); }
    sync();
  };
  $('[data-act=cancel]').onclick = () => setOpen(false);
  button.addEventListener('click', () => setOpen(true));
  addEventListener('keydown', e => { if (e.key === 'Escape' && open) setOpen(false); });
  addEventListener('resize', () => { if (open) sizeInk(); tick(); });
  addEventListener('scroll', tick, { capture: true, passive: true });

  // The picture: the page's frame where it sits on screen (white elsewhere), the ink on top,
  // the pins as numbered dots. At most 1600 px wide; pen marks exist only here.
  function snapshot(quality) {
    const r = Math.min(devicePixelRatio || 1, 2), w = Math.round(Math.min(MAX_PICTURE_PX, innerWidth * r));
    const s = w / innerWidth, h = Math.round(innerHeight * s);
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const c = out.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);
    const src = o.frame?.();
    if (src) {
      const b = src.isConnected ? src.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
      c.drawImage(src, b.left * s, b.top * s, b.width * s, b.height * s);
    }
    c.setTransform(s, 0, 0, s, 0, 0); paint(c); c.setTransform(1, 0, 0, 1, 0, 0);
    tick();
    for (const p of pins) {
      if (p.dot.hidden) continue;
      const x = parseFloat(p.dot.style.left) * s, y = parseFloat(p.dot.style.top) * s, rad = 13 * s;
      c.fillStyle = '#fff'; c.beginPath(); c.arc(x, y, rad + 2 * s, 0, 7); c.fill();
      c.fillStyle = INK; c.beginPath(); c.arc(x, y, rad, 0, 7); c.fill();
      c.fillStyle = '#fff'; c.font = `600 ${13 * s}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(p.dot.textContent, x, y + 0.5);
    }
    return out.toDataURL('image/jpeg', quality);
  }
  function picture() { for (const q of [0.82, 0.65, 0.45]) { const img = snapshot(q); if (img.length <= MAX_IMAGE_CHARS) return img; } return null; }

  send.onclick = async () => {
    const body = note.value.trim();
    if (!body && !pins.length && !strokes.length) { toast('Write a note, tap something, or draw first'); return; }
    const name = author.value.trim();
    if (!signedIn) try { localStorage.setItem(key, name); } catch {}
    const payload = {
      page: o.page, author: name, body, link: o.link(), view: o.view(), viewport: `${innerWidth}x${innerHeight}`,
      pins: pins.map(({ x, y, z, id, label }) => ({ x, y, z: z ?? null, id: id ?? null, label: label ?? null })),
      strokes: strokes.length, image: picture(), website: $('.fb-hp').value,
    };
    send.disabled = true;
    try {
      const r = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok) throw Error((await r.json().catch(() => ({}))).error || r.status);
      // Keep the tool they were using. Resetting to Point turns their next circle into an orbit.
      note.value = ''; clear(); sync(); toast('Sent. Thanks!'); refresh(true);
    } catch (e) { console.error(e); toast('That didn’t send. Try again in a moment.'); }
    finally { send.disabled = false; }
  };

  // Earlier notes for this page, with the agent's replies.
  const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  async function refresh(openList) {
    const list = $('.fb-list'), ol = list.querySelector('ol'), summary = list.querySelector('summary');
    try {
      const r = await fetch(`${api}?page=${encodeURIComponent(o.page)}`, { cache: 'no-store' });
      if (!r.ok) throw Error(r.status);
      const { comments } = await r.json();
      summary.textContent = `Earlier notes (${comments.length})`;
      if (openList) list.open = true;
      ol.innerHTML = comments.map(c => `<li>
<div class="fb-meta">${esc(c.author || 'Someone')} · ${new Date(c.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · <span class="fb-status" data-status="${esc(c.status)}">${esc(c.status)}</span></div>
${esc(c.body) || '<i>(drawing only)</i>'}
${c.pins.length ? `<div class="fb-meta">${c.pins.map(p => `${p.n}: ${esc(p.label || 'a spot')}`).join(' · ')}</div>` : ''}
${c.reply ? `<div class="fb-reply">${esc(c.reply)}</div>` : ''}
<div class="fb-acts"><button type="button" data-view="${esc(c.view)}">Go there</button>${c.has_image ? `<a href="${api}/${esc(c.id)}.jpg" target="_blank" rel="noopener">Picture</a>` : ''}</div></li>`).join('') || '<li class="fb-meta">No notes yet.</li>';
      ol.querySelectorAll('[data-view]').forEach(b => { b.onclick = () => { o.goTo(b.dataset.view); tick(); }; });
    } catch (e) { console.error(e); summary.textContent = 'Earlier notes (couldn’t load)'; }
  }

  sync();
  return { open: () => setOpen(true), close: () => setOpen(false), isOpen: () => open, tick, refresh };
}

// An adapter for an ordinary page: a pin lands on the element under the tap and follows it
// if the layout moves. `id` is a CSS selector for it (data-comment-id beats id beats a path),
// `label` is data-comment-label plus the text tapped. x, y are page pixels; z is null.
// There's no picture of the DOM itself (frame is null, so the picture is the ink and pins on
// white): the agent opens `link` at the note's viewport size to see what was under them.
// Pass frame: () => canvas (html2canvas, say) if you want the page in the picture.
export function domAdapter({ within = document.body } = {}) {
  const m = location.hash.match(/[#&]y=(\d+)/);
  if (m) addEventListener('load', () => scrollTo(0, Number(m[1])));
  const snippet = el => (el.getAttribute('aria-label') || el.alt || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  function selectorOf(el) {
    if (el.dataset.commentId) return `[data-comment-id="${el.dataset.commentId}"]`;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const path = [];
    for (let e = el; e && e !== document.body && path.length < 5; e = e.parentElement) {
      if (e.id) { path.unshift(`#${CSS.escape(e.id)}`); break; }
      const same = [...(e.parentElement?.children || [])].filter(s => s.tagName === e.tagName);
      path.unshift(e.tagName.toLowerCase() + (same.length > 1 ? `:nth-of-type(${same.indexOf(e) + 1})` : ''));
    }
    return path.join(' > ');
  }
  return {
    target: document,
    pick(x, y) {
      const el = document.elementFromPoint(x, y);
      if (!el || !within.contains(el) || el === within) return null;
      const t = el.closest('[data-comment-id]') || el, b = t.getBoundingClientRect();
      const label = [t.dataset.commentLabel, snippet(el)].filter(Boolean).join(': ') || null;
      return { x: Math.round(x + scrollX), y: Math.round(y + scrollY), z: null, id: selectorOf(t), label,
        node: t, fx: (x - b.left) / (b.width || 1), fy: (y - b.top) / (b.height || 1) };
    },
    project(p) {
      if (p.node?.isConnected) { const b = p.node.getBoundingClientRect(); return [b.left + p.fx * b.width, b.top + p.fy * b.height]; }
      return [p.x - scrollX, p.y - scrollY];
    },
    frame: () => null,
    view: () => `${Math.round(scrollX)},${Math.round(scrollY)}`,
    goTo(v) { const [x, y] = String(v).split(',').map(Number); scrollTo(x || 0, y || 0); },
    link: () => `${location.origin}${location.pathname}${location.search}#y=${Math.round(scrollY)}`,
    hold(on) { document.documentElement.style.overflow = on ? 'hidden' : ''; },
  };
}
