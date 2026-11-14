// A small three.js scene with a Comment button. Each piece carries {id, label} in userData,
// which is where GLTFLoader puts glTF "extras": export ids and labels from Blender (custom
// properties) or your generator, and the same tagOf() below finds them in a loaded GLB.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { mountComments } from './comments.js';

const canvas = document.getElementById('view');
// preserveDrawingBuffer keeps the last frame readable, so the snapshot isn't blank.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9e5de');
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 0.6, 0);

scene.add(new THREE.HemisphereLight('#ffffff', '#b9b2a6', 2.2));
const sun = new THREE.DirectionalLight('#ffffff', 1.6);
sun.position.set(3, 5, 2);
scene.add(sun);

const mat = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });
function piece(id, label, parts) {
  const g = new THREE.Group();
  g.userData = { id, label };
  for (const [geo, color, [x, y, z], rot] of parts) {
    const m = new THREE.Mesh(geo, mat(color));
    m.position.set(x, y, z);
    if (rot) m.rotation.set(...rot);
    g.add(m);
  }
  scene.add(g);
  return g;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r1, r2, h) => new THREE.CylinderGeometry(r1, r2, h, 32);

piece('floor', 'Floor', [[box(4, 0.02, 3), '#cfc6b8', [0, -0.01, 0]]]);
piece('desk', 'Desk, oak top', [
  [box(1.4, 0.04, 0.7), '#b98a5a', [0, 0.74, 0]],
  ...[[-0.66, -0.31], [0.66, -0.31], [-0.66, 0.31], [0.66, 0.31]].map(([x, z]) => [box(0.04, 0.72, 0.04), '#3b3b3b', [x, 0.36, z]]),
]);
piece('lamp', 'Desk lamp', [
  [cyl(0.08, 0.09, 0.02), '#2b2b2b', [-0.5, 0.77, -0.2]],
  [cyl(0.01, 0.01, 0.4), '#2b2b2b', [-0.5, 0.96, -0.2]],
  [cyl(0.04, 0.1, 0.1), '#e2b13c', [-0.46, 1.17, -0.16], [0.4, 0, -0.3]],
]);
piece('monitor', 'Monitor', [
  [box(0.6, 0.36, 0.03), '#1c1f24', [0.1, 1.05, -0.22]],
  [box(0.06, 0.2, 0.06), '#2b2b2b', [0.1, 0.86, -0.24]],
  [box(0.22, 0.015, 0.16), '#2b2b2b', [0.1, 0.765, -0.24]],
]);
piece('mug', 'Mug', [[cyl(0.04, 0.04, 0.1), '#d9534f', [0.5, 0.81, 0.1]]]);
piece('chair', 'Chair', [
  [box(0.48, 0.06, 0.46), '#4a6b8a', [0, 0.46, 0.62]],
  [box(0.48, 0.5, 0.05), '#4a6b8a', [0, 0.74, 0.84]],
  [cyl(0.03, 0.03, 0.43), '#3b3b3b', [0, 0.22, 0.62]],
  [cyl(0.28, 0.28, 0.03), '#3b3b3b', [0, 0.02, 0.62]],
]);
piece('plant', 'Plant in a pot', [
  [cyl(0.12, 0.09, 0.26), '#c46a43', [1.2, 0.13, -0.6]],
  [new THREE.SphereGeometry(0.22, 24, 16), '#4f8a4b', [1.2, 0.46, -0.6]],
]);

// The view is the camera: px,py,pz,tx,ty,tz. It's in the link so a note can be revisited.
const r3 = v => Math.round(v * 1000) / 1000;
const view = () => [...camera.position.toArray(), ...controls.target.toArray()].map(r3).join(',');
function goTo(v) {
  const n = String(v).split(',').map(Number);
  if (n.length !== 6 || n.some(x => !Number.isFinite(x))) return;
  camera.position.fromArray(n.slice(0, 3));
  controls.target.fromArray(n.slice(3));
  controls.update();
}
const link = () => `${location.origin}${location.pathname}#cam=${view()}`;
camera.position.set(1.9, 1.6, 2.2);
goTo(new URLSearchParams(location.hash.slice(1)).get('cam') || view());
controls.addEventListener('end', () => history.replaceState(null, '', link()));

const ray = new THREE.Raycaster(), at = new THREE.Vector3();
const tagOf = o => { while (o) { if (o.userData?.id) return o.userData; o = o.parent; } return {}; };

const comments = mountComments({
  page: 'desk',
  target: canvas,
  pick(x, y) {
    const b = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((x - b.left) / b.width * 2 - 1, -(y - b.top) / b.height * 2 + 1), camera);
    const hit = ray.intersectObjects(scene.children, true)[0];
    if (!hit) return null;
    const t = tagOf(hit.object);
    return { x: r3(hit.point.x), y: r3(hit.point.y), z: r3(hit.point.z), id: t.id || null, label: t.label || null };
  },
  project(p) {
    at.set(p.x, p.y, p.z).project(camera);
    if (at.z > 1 || Math.abs(at.x) > 1.1 || Math.abs(at.y) > 1.1) return null;
    const b = canvas.getBoundingClientRect();
    return [b.left + (at.x + 1) / 2 * b.width, b.top + (1 - at.y) / 2 * b.height];
  },
  frame() { renderer.render(scene, camera); return canvas; },
  view, goTo, link,
  hold(on) { controls.enabled = !on; },
});

function fit() { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight, false); }
addEventListener('resize', fit);
fit();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); comments.tick(); });
