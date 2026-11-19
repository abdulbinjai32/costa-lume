// Costa Lume — the car. Six civilian brands plus the Policía de Lume PATRULLA, built from shared
// geometry and shared materials so a hundred cars cost a handful of textures and not one upload.
//
// Model: a merged body shell per brand (paint bucket + trim bucket), a separate glass shell, four
// wheels on their own pivots (steer on the front pair, spin on all four), lamp quads whose material
// is shared per state (headlight, tail, brake, wreck) and a paint material per colour drawn from a
// fixed palette — never a per-car texture.
//
// Physics is arcade, tuned at the fixed 1/60 s step: throttle drives a per-brand top speed and
// acceleration, the front wheels turn by a speed-scaled rate, the rear pairs' lateral velocity is
// killed by grip each step (the handbrake keeps most of it, so the car slides and the driver steers
// out of it), drag and rolling resistance bleed speed off, and the body leans into pitch and roll on
// springs. Collision is axis-separated against city.colliders with a sub-sweep, so a 12 m/s step can
// never tunnel a wall; car-to-car contact pushes both bodies apart and trades speed.
//
// State the rest of the game reads: group (Object3D), pos/yaw/speed/steer/vel (chassis), brand,
// length/width, health, destroyed, driver, plus enter()/exit()/update()/drive()/wreck().
import * as THREE from 'three';
import { makeBuilder, pushBox, pushCylinder, finish } from '../world/geometry.js';

// ---------------------------------------------------------------------------------------------
// Brands. top/accel are m/s and m/s^2; grip is how fast lateral slip is killed; hand keeps the
// share of grip the handbrake leaves; mass scales how much a hit pushes it and how fast it stops.
// ---------------------------------------------------------------------------------------------
export const BRANDS = {
  viento: {
    name: 'Viento', kind: 'sedan', length: 4.46, width: 1.82, height: 0.72, ride: 0.30,
    cabin: [0.86, 0.56, 2.10, 0.06], wheel: 0.32, wheelbase: 1.30,
    top: 46, accel: 7.6, brake: 15, grip: 7.4, hand: 0.30, mass: 1220, steer: 0.62, drag: 0.00040,
  },
  tiburon: {
    name: 'Tiburón', kind: 'muscle', length: 4.72, width: 1.92, height: 0.66, ride: 0.28,
    cabin: [0.92, 0.50, 1.92, 0.18], wheel: 0.35, wheelbase: 1.42,
    top: 53, accel: 9.4, brake: 14, grip: 6.6, hand: 0.24, mass: 1460, steer: 0.58, drag: 0.00038,
  },
  lagarto: {
    name: 'Lagarto', kind: 'suv', length: 4.86, width: 1.98, height: 0.90, ride: 0.44,
    cabin: [0.92, 0.74, 2.66, 0.00], wheel: 0.40, wheelbase: 1.38,
    top: 40, accel: 6.6, brake: 13, grip: 6.9, hand: 0.32, mass: 1780, steer: 0.60, drag: 0.00055,
  },
  abeja: {
    name: 'Abeja', kind: 'compact', length: 3.66, width: 1.68, height: 0.74, ride: 0.28,
    cabin: [0.80, 0.62, 2.06, -0.04], wheel: 0.29, wheelbase: 1.14,
    top: 38, accel: 6.4, brake: 15, grip: 8.6, hand: 0.34, mass: 980, steer: 0.70, drag: 0.00042,
  },
  faro: {
    name: 'Faro', kind: 'van', length: 5.12, width: 1.98, height: 1.22, ride: 0.36,
    cabin: [0.90, 1.02, 3.30, -0.30], wheel: 0.35, wheelbase: 1.52,
    top: 36, accel: 5.2, brake: 12, grip: 6.2, hand: 0.34, mass: 1980, steer: 0.56, drag: 0.00070,
  },
  marea: {
    name: 'Marea', kind: 'pickup', length: 5.10, width: 1.94, height: 0.78, ride: 0.38,
    cabin: [0.88, 0.70, 1.70, 0.52], wheel: 0.37, wheelbase: 1.46,
    top: 41, accel: 6.4, brake: 13, grip: 6.4, hand: 0.30, mass: 1690, steer: 0.60, drag: 0.00055,
  },
  patrulla: {
    name: 'PATRULLA', kind: 'cruiser', length: 4.62, width: 1.90, height: 0.74, ride: 0.31,
    cabin: [0.90, 0.58, 2.16, 0.10], wheel: 0.33, wheelbase: 1.34,
    top: 50, accel: 9.0, brake: 16, grip: 7.8, hand: 0.28, mass: 1560, steer: 0.62, drag: 0.00038,
  },
};

export const BRAND_KEYS = Object.keys(BRANDS);
const ALIASES = { viento: 'viento', tiburon: 'tiburon', 'tiburón': 'tiburon', lagarto: 'lagarto', abeja: 'abeja', faro: 'faro', marea: 'marea', patrulla: 'patrulla', cruiser: 'patrulla' };

// Paint palette: the boulevard reads as pastel hotel colours, so cars are pale by default and the
// saturated ones are the exception. Indexes are fixed, so a seed picks the same street twice.
const PAINT_HEX = [
  0xe9e4d8, 0xd9d2c0, 0x2f5d73, 0x8c2f2a, 0xe0b45e, 0x3c6b52, 0x9aa7ae,
  0x1f2a33, 0xcc5a35, 0xdde3e0, 0x4a6b8a, 0xb8553f, 0x8a8f7a, 0xf2ede2,
  0x2b4a52, 0xc99a6b, 0x6b3f5c, 0x455a3f,
];

// ---------------------------------------------------------------------------------------------
// Shared resources. Everything here is built once, lazily, on first createCar: geometry per brand,
// one wheel geometry, four lamp materials, one glass/paint/trim/lightbar material.
// ---------------------------------------------------------------------------------------------
const shared = {
  brands: {},
  wheel: null,
  paint: new Map(),
  glass: null, trim: null, glassDark: null, smoke: null,
  lamp: null,
};

function paintMaterial(hex) {
  const key = hex >>> 0;
  let m = shared.paint.get(key);
  if (!m) {
    // vertex colours carry the trim, so the material colour is the paint itself
    m = new THREE.MeshStandardMaterial({ color: key, roughness: 0.38, metalness: 0.38, vertexColors: true });
    m.name = `car-paint-${key.toString(16)}`;
    shared.paint.set(key, m);
  }
  return m;
}

// The lamp palette: one unlit material per emitted colour, shared by every car in the world.
function lampMaterials() {
  if (shared.lamp) return shared.lamp;
  const make = (hex, opacity = 1) => new THREE.MeshBasicMaterial({
    color: hex, toneMapped: false, transparent: opacity < 1, opacity,
  });
  shared.lamp = {
    head: make(0xfff3d6),
    tail: make(0x7d1a12),
    brake: make(0xff3a1f),
    reverse: make(0xf2f2e6),
    wreck: make(0x2a2622),
    police: make(0x2f6fff),
    policeRed: make(0xff2a1a),
    beam: make(0xffe6b0, 0.18),
  };
  return shared.lamp;
}

// One brand's geometry: a single merged body shell (paint verts white so the material's colour can
// be the paint, trim verts grey so bumpers stay dark under any paint), a glass shell, and two lamp
// meshes that each carry a pair of lenses. Nine meshes is the whole car.
function buildBrand(key) {
  const b = BRANDS[key];
  const paint = makeBuilder();
  const trim = makeBuilder();
  const glass = makeBuilder();
  const L = b.length;
  const W = b.width;
  const H = b.height;
  const yBody = b.ride + H / 2;
  const nose = L / 2;
  const rear = -L / 2;
  const halfW = W / 2;

  // lower body, then a shoulder slab that flares 4 cm so the silhouette is not one fat box
  pushBox(paint, 0, yBody, 0, W, H, L);
  pushBox(paint, 0, yBody + H * 0.42, 0, W + 0.05, H * 0.22, L * 0.96);
  // bonnet falls away at the nose, boot lifts at the tail
  pushBox(paint, 0, yBody + H * 0.46, nose - L * 0.16, W * 0.94, H * 0.16, L * 0.30);
  pushBox(paint, 0, yBody + H * 0.44, rear + L * 0.14, W * 0.94, H * 0.20, L * 0.26);

  const [cabinW, cabinH, cabinL, cabinZ] = b.cabin;
  const cabY = yBody + H / 2 + cabinH / 2 - 0.02;
  // glass box, inset from the cabin so the pillars read as body colour around it
  pushBox(glass, 0, cabY, cabinZ, cabinW, cabinH, cabinL);
  // roof: paint slab on top of the glass, so the greenhouse reads from above
  pushBox(paint, 0, cabY + cabinH / 2 + 0.03, cabinZ, cabinW + 0.04, 0.07, cabinL * 0.98);
  // A-pillar / B-pillar / C-pillar strips
  const pillarZ = [cabinZ + cabinL / 2 - 0.04, cabinZ, cabinZ - cabinL / 2 + 0.04];
  for (const pz of pillarZ) {
    for (const s of [-1, 1]) {
      pushBox(paint, s * (cabinW / 2 + 0.005), cabY, pz, 0.05, cabinH, 0.07);
    }
  }
  // belt line, mirror stalks, bumpers, grille, sills
  pushBox(trim, 0, yBody + H / 2 - 0.02, 0, W + 0.07, 0.06, L * 0.99);
  for (const s of [-1, 1]) {
    pushBox(trim, s * (halfW + 0.06), cabY - cabinH * 0.18, cabinZ + cabinL / 2 - 0.10, 0.13, 0.09, 0.05);
  }
  pushBox(trim, 0, b.ride + 0.10, nose - 0.03, W * 0.97, 0.20, 0.12);
  pushBox(trim, 0, b.ride + 0.10, rear + 0.03, W * 0.97, 0.20, 0.12);
  pushBox(trim, 0, yBody - H * 0.16, nose + 0.01, W * 0.52, H * 0.20, 0.06);
  for (const s of [-1, 1]) pushBox(trim, s * (halfW - 0.02), b.ride + 0.09, 0, 0.10, 0.16, L * 0.66);

  if (b.kind === 'pickup') {
    // open bed: side walls and a tailgate, so the Marea reads as a working truck
    pushBox(paint, 0, yBody + H / 2 + 0.16, rear + L * 0.20, W * 0.98, 0.32, 0.10);
    for (const s of [-1, 1]) pushBox(paint, s * (halfW - 0.05), yBody + H / 2 + 0.14, rear + L * 0.20, 0.10, 0.28, L * 0.42);
  }
  if (b.kind === 'van') {
    // roof rack rails
    for (const s of [-1, 1]) pushBox(trim, s * (cabinW / 2 - 0.06), cabY + cabinH / 2 + 0.10, cabinZ, 0.05, 0.06, cabinL * 0.8);
  }
  if (key === 'patrulla') {
    // light bar, stripe block and push bumper live on the trim bucket so the paint stays white
    pushBox(trim, 0, cabY + cabinH / 2 + 0.14, cabinZ, 1.10, 0.16, 0.30);
  }
  if (b.kind === 'muscle') {
    // bonnet scoop and a ducktail
    pushBox(trim, 0, yBody + H * 0.56, nose - L * 0.16, 0.44, 0.10, 0.62);
    pushBox(paint, 0, yBody + H * 0.56, rear + L * 0.10, W * 0.80, 0.10, 0.20);
  }

  const lampY = yBody + H * 0.06;
  const lampHead = makeBuilder();
  const lampTail = makeBuilder();
  pushBox(lampHead, -0.62, lampY, nose + 0.02, 0.34, 0.13, 0.05);
  pushBox(lampHead, 0.62, lampY, nose + 0.02, 0.34, 0.13, 0.05);
  pushBox(lampTail, -0.66, lampY, rear - 0.02, 0.30, 0.11, 0.05);
  pushBox(lampTail, 0.66, lampY, rear - 0.02, 0.30, 0.11, 0.05);

  const barL = key === 'patrulla' ? [-0.28, cabY + cabinH / 2 + 0.14, cabinZ] : null;
  const barR = key === 'patrulla' ? [0.28, cabY + cabinH / 2 + 0.14, cabinZ] : null;

  return {
    body: mergeColoured([
      [paint, [1, 1, 1]],
      [trim, [0.34, 0.34, 0.36]],
    ]),
    glass: finish(glass),
    head: finish(lampHead),
    tail: finish(lampTail),
    barL,
    barR,
    spec: b,
    wheelbase: b.wheelbase,
  };
}

// Concatenate builders into one geometry with a per-build colour, so one material can carry the
// paint and the dark trim in a single draw.
function mergeColoured(parts) {
  const pos = [];
  const nor = [];
  const uv = [];
  const col = [];
  for (const [b, c] of parts) {
    for (let i = 0; i < b.pos.length; i += 1) pos.push(b.pos[i]);
    for (let i = 0; i < b.nor.length; i += 1) nor.push(b.nor[i]);
    for (let i = 0; i < b.uv.length; i += 1) uv.push(b.uv[i]);
    const n = b.pos.length / 3;
    for (let i = 0; i < n; i += 1) col.push(c[0], c[1], c[2]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

function brandGeo(key) {
  let g = shared.brands[key];
  if (!g) {
    g = buildBrand(key);
    shared.brands[key] = g;
  }
  return g;
}

// Cylinder lying along x: the wheel's axle. Built once, shared by every car, spun by rotation.x.
function wheelGeo() {
  if (!shared.wheel) {
    const wb = makeBuilder();
    pushCylinder(wb, new THREE.Vector3(-0.11, 0, 0), new THREE.Vector3(0.11, 0, 0), 1, 1, 12);
    // hub cap: a slightly proud disc on the outside face, so the wheel reads turning
    pushCylinder(wb, new THREE.Vector3(0.10, 0, 0), new THREE.Vector3(0.135, 0, 0), 0.46, 0.40, 10);
    shared.wheel = finish(wb);
  }
  return shared.wheel;
}

function baseMaterials() {
  if (!shared.glass) {
    shared.glass = new THREE.MeshStandardMaterial({ color: 0x1d2d35, roughness: 0.08, metalness: 0.85, transparent: true, opacity: 0.78 });
    shared.glass.name = 'car-glass';
    shared.trim = new THREE.MeshStandardMaterial({ color: 0x1a1d20, roughness: 0.62, metalness: 0.30 });
    shared.trim.name = 'car-trim';
    shared.glassDark = new THREE.MeshStandardMaterial({ color: 0x0c0e10, roughness: 0.5, metalness: 0.2 });
    shared.smoke = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 1.0, metalness: 0.0, flatShading: true });
  }
  return shared;
}

// ---------------------------------------------------------------------------------------------
// A car
// ---------------------------------------------------------------------------------------------
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export function normalizeBrand(brand) {
  if (typeof brand === 'string') {
    const k = ALIASES[brand.toLowerCase()];
    if (k) return k;
  }
  return 'viento';
}

export function createCar(brand, colorHex, options = {}) {
  const key = normalizeBrand(brand);
  const spec = BRANDS[key];
  const geo = brandGeo(key);
  const mats = baseMaterials();
  const lamps = lampMaterials();
  const hex = colorHex === undefined || colorHex === null ? PAINT_HEX[0] : colorHex;

  const group = new THREE.Group();
  group.name = `car-${key}`;

  const paintMat = paintMaterial(hex);
  // body pivot: everything that leans (pitch/roll) hangs off this, so wheels stay flat on the road
  const body = new THREE.Group();
  body.name = `car-${key}-body`;
  group.add(body);

  const shell = new THREE.Mesh(geo.body, paintMat);
  shell.castShadow = true;
  shell.receiveShadow = true;
  body.add(shell);

  const glassMesh = new THREE.Mesh(geo.glass, mats.glass);
  glassMesh.castShadow = false;
  body.add(glassMesh);

  // damage pass: a second copy of the paint shell, dark and rough, faded in by damage
  const dmgMat = new THREE.MeshStandardMaterial({
    color: 0x3a332c, roughness: 0.95, metalness: 0.05, transparent: true, opacity: 0,
    vertexColors: true,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  dmgMat.name = `car-damage-${key}`;
  const dent = new THREE.Mesh(geo.body, dmgMat);
  dent.position.set(0, 0.004, 0);
  dent.castShadow = false;
  dent.receiveShadow = false;
  body.add(dent);

  // lamps: one mesh per pair, so a state change is a material swap and a lens pair is one draw
  const lampMeshes = { head: [], tail: [], bar: [] };
  const headMesh = new THREE.Mesh(geo.head, lamps.head);
  headMesh.position.z = 0.01;
  body.add(headMesh);
  lampMeshes.head.push(headMesh);
  const tailMesh = new THREE.Mesh(geo.tail, lamps.tail);
  tailMesh.position.z = -0.01;
  body.add(tailMesh);
  lampMeshes.tail.push(tailMesh);
  if (geo.barL) {
    const barGeo = new THREE.BoxGeometry(0.44, 0.12, 0.26);
    for (const [side, p] of [['L', geo.barL], ['R', geo.barR]]) {
      const m = new THREE.Mesh(barGeo, side === 'L' ? lamps.police : lamps.policeRed);
      m.position.set(p[0], p[1] + 0.09, p[2]);
      body.add(m);
      lampMeshes.bar.push(m);
    }
  }
  // headlight beams: two additive cones lying ahead of the nose, shown only after dark in stage 4
  const beamMat = lamps.beam;
  const beamGeo = new THREE.ConeGeometry(1.5, 9, 8, 1, true);
  beamGeo.rotateX(-Math.PI / 2);
  beamGeo.translate(0, 0, 4.5);
  const beams = [];
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(beamGeo, beamMat);
    m.position.set(s * 0.62, spec.ride + spec.height * 0.56, spec.length / 2);
    m.visible = false;
    body.add(m);
    beams.push(m);
  }

  // wheels: four pivots; front pair steers, all four spin
  const wgeo = wheelGeo();
  const wmat = mats.trim;
  const wheelRadius = spec.wheel;
  const wheels = [];
  const wz = geo.wheelbase;
  const wx = spec.width / 2 - 0.09;
  for (const [ix, sx] of [[0, -1], [1, 1]]) {
    for (const [iz, sz] of [[0, 1], [1, -1]]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx * wx, wheelRadius, sz * wz);
      const tyre = new THREE.Mesh(wgeo, wmat);
      tyre.scale.set(0.115, wheelRadius, wheelRadius);
      tyre.castShadow = true;
      pivot.add(tyre);
      group.add(pivot);
      wheels.push({ pivot, tyre, front: iz === 0, side: sx, spin: 0 });
    }
  }

  // ---- chassis state ------------------------------------------------------------------------
  const state = {
    pos: new THREE.Vector3(options.x || 0, 0, options.z || 0),
    yaw: options.yaw || 0,
    speed: 0,                          // signed m/s along the heading
    steer: 0,                          // -1..1 normalised front wheel angle
    vel: new THREE.Vector3(),          // world planar velocity (x, 0, z)
    throttle: 0,
    brake: 0,
    handbrake: 0,
    slip: 0,                           // |lateral velocity| m/s
    pitch: 0, roll: 0,
    pitchV: 0, rollV: 0,
  };

  const car = {
    brand: spec.name,
    key,
    kind: spec.kind,
    spec,
    group,
    body,
    wheels,
    paint: paintMat,
    length: spec.length,
    width: spec.width,
    height: spec.ride + spec.height + (spec.cabin ? spec.cabin[1] : 0.6),
    wheelRadius,
    health: 100,
    destroyed: false,
    driver: options.driver || null,     // 'player' | 'ai' | null (parked)
    ai: null,                           // traffic.js hangs its lane state here
    lightsOn: !!options.lightsOn,
    smokeT: 0,
    receivers: [],
    // exposed chassis
    pos: state.pos,
    get yaw() { return state.yaw; },
    set yaw(v) { state.yaw = v; },
    get speed() { return state.speed; },
    set speed(v) { state.speed = v; },
    get steer() { return state.steer; },
    set steer(v) { state.steer = v; },
    vel: state.vel,
  };

  // ---- smoke: one billboard mesh per emitting car, born on first puff -------------------------
  const smoke = { mesh: null, puffs: [] };

  function ensureSmoke(scene) {
    if (smoke.mesh || !scene) return;
    const mat = new THREE.MeshBasicMaterial({
      map: softDisc(), color: 0x40403c, transparent: true, opacity: 0.4, depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const geoP = new THREE.PlaneGeometry(1, 1);
    smoke.mesh = new THREE.Group();
    smoke.mesh.name = 'car-smoke';
    for (let i = 0; i < 10; i += 1) {
      const m = new THREE.Mesh(geoP, mat.clone());
      m.material.opacity = 0;
      m.visible = false;
      smoke.mesh.add(m);
      smoke.puffs.push({ mesh: m, life: 0, max: 1, vx: 0, vy: 0, vz: 0, size: 1 });
    }
    scene.add(smoke.mesh);
  }

  let smokeTurn = 0;
  function puff(dt, rate, tint, scale = 1) {
    if (!smoke.mesh) return;
    for (let i = 0; i < smoke.puffs.length; i += 1) {
      const p = smoke.puffs[(smokeTurn + i) % smoke.puffs.length];
      if (p.life <= 0) {
        smokeTurn = (smokeTurn + i + 1) % smoke.puffs.length;
        p.life = p.max = 1.1 + (i % 3) * 0.25;
        p.mesh.visible = true;
        p.mesh.position.set(
          state.pos.x + Math.sin(state.yaw) * -1.4 + ((i % 5) - 2) * 0.12,
          state.pos.y + 0.5,
          state.pos.z + Math.cos(state.yaw) * -1.4,
        );
        p.vx = 0.4 * Math.sin(state.yaw + 1.2);
        p.vz = 0.4 * Math.cos(state.yaw + 1.2);
        p.vy = 1.1 + (i % 3) * 0.2;
        p.size = scale * (0.7 + (i % 4) * 0.15);
        p.mesh.material.color.setHex(tint);
        break;
      }
    }
    void dt;
    void rate;
  }

  function stepSmoke(dt) {
    if (!smoke.mesh) return;
    for (const p of smoke.puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const t = 1 - Math.max(0, p.life) / p.max;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.vy += 0.35 * dt;
      p.size += dt * 1.6;
      p.mesh.scale.setScalar(p.size * (0.6 + t * 1.4));
      p.mesh.material.opacity = 0.34 * (1 - t) * (1 - t);
      if (p.life <= 0) p.mesh.visible = false;
    }
    if (smoke.mesh.children[0] && smoke.mesh.children[0].material) {
      // billboards: face the camera on the y plane each frame (cheap: parent-level yaw)
      smoke.mesh.rotation.y = 0;
    }
  }

  // ---- lights -------------------------------------------------------------------------------
  function refreshLamps() {
    const lm = lampMaterials();
    const off = car.destroyed;
    for (const m of lampMeshes.head) m.material = off ? lm.wreck : lm.head;
    const braking = state.brake > 0.05 || (car.driver !== 'ai' && state.speed > 0.2 && state.throttle < -0.05);
    for (const m of lampMeshes.tail) m.material = off ? lm.wreck : (braking ? lm.brake : lm.tail);
    for (const m of beams) m.visible = car.lightsOn && !off;
  }

  // ---- public methods -----------------------------------------------------------------------
  function syncTransform() {
    group.position.copy(state.pos);
    // the model is authored nose-forward along local +Z while the shared yaw convention looks down
    // -Z, so the body carries the half turn; everything the game reads still uses `yaw`
    group.rotation.y = state.yaw + Math.PI;
    // suspension: pitch under braking/accel, roll into the corner, both as damped springs
    body.rotation.x = state.pitch;
    body.rotation.z = state.roll;
    for (const w of wheels) {
      w.tyre.rotation.x = w.spin;
      // steer > 0 turns left, and local +X is the car's left once the body carries its half turn
      w.pivot.rotation.y = w.front ? state.steer * 0.52 : 0;
    }
    dmgMat.opacity = Math.min(0.85, (1 - car.health / 100) * 0.92);
    if (car.destroyed) {
      // a burnt hull: paint crushed toward charcoal, glass opaque, wheels slumped
      car.paint.color.setHex(0x2b2622);
      car.paint.roughness = 0.95;
      car.paint.metalness = 0.1;
      glassMesh.material = mats.glassDark;
    }
  }

  function setPose(x, z, yaw, y = 0) {
    state.pos.set(x, y, z);
    state.yaw = yaw;
    state.speed = 0;
    state.steer = 0;
    state.vel.set(0, 0, 0);
    syncTransform();
  }

  // Damage comes off the chassis health; at zero the car is a wreck (stage 3's guns call this).
  function damage(amount) {
    if (car.destroyed || amount <= 0) return;
    car.health = Math.max(0, car.health - amount);
    if (car.health <= 0) wreck();
  }

  function wreck() {
    if (car.destroyed) return;
    car.destroyed = true;
    car.health = 0;
    car.driver = null;
    refreshLamps();
  }

  return Object.assign(car, {
    state,
    smoke,
    ensureSmoke,
    syncTransform,
    setPose,
    damage,
    wreck,
    refreshLamps,
    stepSmoke,
    puff,
    _internal: { state, lampMeshes, dmgMat, beams, geo, spec },
  });
}

// ---------------------------------------------------------------------------------------------
// Arcade physics, one fixed 1/60 s step. Exported because both the player's car and traffic.js's
// AI cars run through it: one grip model, one collision resolver, one feel.
// ---------------------------------------------------------------------------------------------
const GRAV = 0;
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmp = new THREE.Vector3();

// forward from yaw, matching the camera convention (yaw 0 looks down -Z)
export function yawForward(yaw, out) {
  out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  return out;
}

// Closest point on an AABB to a point, in the xz plane.
function closestOnBox(c, x, z, out) {
  out.x = x < c.minX ? c.minX : x > c.maxX ? c.maxX : x;
  out.z = z < c.minZ ? c.minZ : z > c.maxZ ? c.maxZ : z;
  return out;
}

// One car's chassis step. ctrl = { throttle -1..1, brake 0..1, steer -1..1, handbrake 0..1 }.
// ctx = { colliders, bounds, cars, onImpact(car, other, severity) }.
export function stepCar(car, dt, ctrl, ctx) {
  const st = car.state;
  if (!st) return;
  const spec = car.spec;
  const throttle = ctrl.throttle || 0;
  const brake = ctrl.brake || 0;
  const steerIn = ctrl.steer || 0;
  const hand = ctrl.handbrake || 0;

  st.throttle = throttle;
  st.brake = brake;
  st.handbrake = hand;

  yawForward(st.yaw, _fwd);
  _right.set(-_fwd.z, 0, _fwd.x);          // right-hand side of the car

  // split the world velocity into along-the-car and across-the-car
  let vLong = st.vel.x * _fwd.x + st.vel.z * _fwd.z;
  let vLat = st.vel.x * _right.x + st.vel.z * _right.z;

  const top = spec.top;
  const throttleAbs = Math.abs(throttle);
  const dir = throttle >= 0 ? 1 : -1;

  if (car.destroyed) {
    // a wreck rolls to a stop and will not steer
    vLong *= Math.exp(-3.2 * dt);
    vLat *= Math.exp(-4.5 * dt);
    st.steer *= Math.exp(-6 * dt);
  } else if (throttle !== 0) {
    // engine: push toward the brand's top speed, and let the top speed cap reverse at a quarter
    const limit = dir > 0 ? top : top * 0.28;
    const ratio = Math.abs(vLong) / limit;
    if (Math.sign(vLong) !== dir && Math.abs(vLong) > 0.4) {
      // pressing the throttle against travel brakes first — the arcade "wrong way" feel
      vLong -= Math.sign(vLong) * spec.brake * 0.62 * throttleAbs * dt;
    } else if (ratio < 1) {
      const push = spec.accel * throttleAbs * (1 - ratio * ratio * 0.86);
      vLong += dir * push * dt;
    }
  }

  // brake: only meaningful against the direction of travel
  if (brake > 0 && Math.abs(vLong) > 0.2) {
    const d = Math.sign(vLong) * spec.brake * brake * dt;
    vLong = Math.abs(d) > Math.abs(vLong) ? 0 : vLong - d;
  }

  // drag and rolling resistance: quadratic at speed, constant when rolling
  const dragQ = spec.drag * vLong * Math.abs(vLong);
  const coast = throttle === 0 ? 1.35 : 0;      // engine braking, so a car let go actually slows
  const roll = (0.55 + coast) * Math.sign(vLong) * (Math.abs(vLong) > 0.3 ? 1 : Math.abs(vLong) / 0.3);
  vLong -= (dragQ + roll) * dt;
  // the brand's top speed is the hard ceiling; drag only takes over once the throttle is off
  const ceiling = dir > 0 ? top : top * 0.28;
  if (Math.abs(vLong) > ceiling && Math.sign(vLong) === dir) vLong = dir * ceiling;
  if (Math.abs(vLong) < 0.03 && throttle === 0) vLong = 0;

  // steering: a real car's lock shrinks as speed rises, so the turn rate is the smaller of the
  // geometric limit (v * tan(maxLock) / wheelbase) and what the tyres can hold (a_lat / v).
  st.steer += (steerIn - st.steer) * Math.min(1, 9 * dt);
  const speedAbs = Math.abs(vLong);
  const geometric = (speedAbs * spec.steer) / Math.max(1.8, spec.wheelbase);
  const gripLimit = 9.4 / Math.max(3.2, speedAbs);
  const maxYaw = Math.min(geometric, gripLimit) * (vLong < 0 ? -1 : 1);
  const yawRate = st.steer * maxYaw;

  // lateral grip: kill the slip each step, the handbrake keeps most of it alive
  const gripK = hand > 0.5 ? spec.grip * spec.hand : spec.grip;
  const vLatBefore = vLat;
  vLat *= Math.exp(-gripK * dt);
  // the slip that was scrubbed turns the car a little: this is what makes a drift hold
  st.yaw += (yawRate + vLatBefore * 0.02 * (vLong >= 0 ? 1 : -1)) * dt;

  // rebuild the world velocity on the new heading; keep yaw wrapped so long runs stay precise
  if (st.yaw > Math.PI) st.yaw -= Math.PI * 2;
  else if (st.yaw < -Math.PI) st.yaw += Math.PI * 2;
  yawForward(st.yaw, _fwd);
  _right.set(-_fwd.z, 0, _fwd.x);
  st.vel.x = _fwd.x * vLong + _right.x * vLat;
  st.vel.z = _fwd.z * vLong + _right.z * vLat;
  st.speed = vLong;
  st.slip = Math.abs(vLat);

  // ---- move, in slices short enough that nothing tunnels -----------------------------------
  const dx = st.vel.x * dt;
  const dz = st.vel.z * dt;
  const dist = Math.hypot(dx, dz);
  const slices = Math.min(5, Math.max(1, Math.ceil(dist / 0.42)));
  const sx = dx / slices;
  const sz = dz / slices;
  let impacted = 0;
  for (let i = 0; i < slices; i += 1) {
    st.pos.x += sx;
    st.pos.z += sz;
    impacted = Math.max(impacted, resolveCity(car, ctx));
  }
  if (impacted > 0 && ctx && ctx.onImpact) ctx.onImpact(car, null, impacted);

  // ---- suspension: pitch from long accel, roll from the corner -------------------------------
  const longAccel = (vLong - car._lastLong || 0) / dt;
  car._lastLong = vLong;
  const latAccel = -st.steer * vLong * vLong * 0.0016;
  const pitchTarget = clamp(-longAccel * 0.0042, -0.055, 0.055);
  const rollTarget = clamp(latAccel + vLat * 0.012, -0.075, 0.075);
  st.pitchV += (pitchTarget - st.pitch) * 190 * dt;
  st.pitchV *= Math.exp(-11 * dt);
  st.pitch += st.pitchV * dt;
  st.rollV += (rollTarget - st.roll) * 170 * dt;
  st.rollV *= Math.exp(-10 * dt);
  st.roll += st.rollV * dt;

  // ---- wheels --------------------------------------------------------------------------------
  for (const w of car.wheels) w.spin += (vLong / car.wheelRadius) * dt;

  // ---- damage smoke and the wreck plume -------------------------------------------------------
  car.damageT = (car.damageT || 0) + dt;
  if (car.destroyed) {
    if (car.damageT > 0.10) { car.damageT = 0; car.puff(dt, 1, 0x2b2b28, 1.5); }
  } else if (car.health < 42) {
    if (car.damageT > (car.health < 20 ? 0.14 : 0.30)) {
      car.damageT = 0;
      car.puff(dt, 1, car.health < 20 ? 0x2f2f2c : 0x55504a, car.health < 20 ? 1.25 : 0.85);
    }
  }

  car.syncTransform();
  car.refreshLamps();
  if (car.smoke) car.stepSmoke(dt);
  return car;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Push the car out of any city collider it now overlaps, sampling three discs along its length.
// Returns the largest impact speed (m/s) it lost, 0 for a clean step.
const _cp = new THREE.Vector3();
function resolveCity(car, ctx) {
  if (!ctx || !ctx.colliders) return 0;
  const st = car.state;
  const r = car.width * 0.5 - 0.06;
  const half = car.length * 0.5 - r * 0.85;
  let worst = 0;
  for (let k = -1; k <= 1; k += 1) {
    yawForward(st.yaw, _fwd);
    const px = st.pos.x + _fwd.x * half * k;
    const pz = st.pos.z + _fwd.z * half * k;
    for (let i = 0; i < ctx.colliders.length; i += 1) {
      const c = ctx.colliders[i];
      if (c.height !== undefined && c.height < 0.55) continue;     // kerbs and paint are drivable
      if (px + r < c.minX || px - r > c.maxX || pz + r < c.minZ || pz - r > c.maxZ) continue;
      closestOnBox(c, px, pz, _cp);
      let nx = px - _cp.x;
      let nz = pz - _cp.z;
      let d = Math.hypot(nx, nz);
      if (d > r) continue;
      if (d < 1e-5) {
        // centre inside the box: push out along the shallowest face
        const toMinX = px - c.minX;
        const toMaxX = c.maxX - px;
        const toMinZ = pz - c.minZ;
        const toMaxZ = c.maxZ - pz;
        const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
        if (m === toMinX) { nx = -1; nz = 0; d = 0; } else if (m === toMaxX) { nx = 1; nz = 0; d = 0; }
        else if (m === toMinZ) { nx = 0; nz = -1; d = 0; } else { nx = 0; nz = 1; d = 0; }
      } else {
        nx /= d; nz /= d;
      }
      const push = r - d + 1e-3;
      st.pos.x += nx * push;
      st.pos.z += nz * push;
      // kill the velocity going into the wall, keep what slides along it
      const into = st.vel.x * nx + st.vel.z * nz;
      if (into < 0) {
        worst = Math.max(worst, -into);
        st.vel.x -= nx * into * 1.28;      // a little bounce back, so a wall stops you dead
        st.vel.z -= nz * into * 1.28;
      }
    }
  }
  if (worst > 0) {
    // the impact costs speed overall and shakes the body
    const keep = Math.max(0.28, 1 - worst * 0.09);
    st.vel.x *= keep;
    st.vel.z *= keep;
    st.speed = st.vel.x * Math.sin(st.yaw) * -1 + st.vel.z * Math.cos(st.yaw) * -1;
    st.pitchV -= worst * 0.012;
    car.damage(worst * 0.45);
  }
  return worst;
}

// Car against car: two discs each, pushed apart weighted by mass, closing speed traded as damage.
export function resolvePair(a, b) {
  const sa = a.state;
  const sb = b.state;
  const ra = a.width * 0.5;
  const rb = b.width * 0.5;
  yawForward(sa.yaw, _fwd);
  const ax = [sa.pos.x - _fwd.x * a.length * 0.28, sa.pos.x + _fwd.x * a.length * 0.28];
  const az = [sa.pos.z - _fwd.z * a.length * 0.28, sa.pos.z + _fwd.z * a.length * 0.28];
  yawForward(sb.yaw, _fwd);
  const bx = [sb.pos.x - _fwd.x * b.length * 0.28, sb.pos.x + _fwd.x * b.length * 0.28];
  const bz = [sb.pos.z - _fwd.z * b.length * 0.28, sb.pos.z + _fwd.z * b.length * 0.28];
  let best = null;
  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      const dx = bx[j] - ax[i];
      const dz = bz[j] - az[i];
      const d2 = dx * dx + dz * dz;
      const rr = ra + rb;
      if (d2 > rr * rr) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const pen = rr - d;
      if (!best || pen > best.pen) best = { pen, nx: dx / d, nz: dz / d };
    }
  }
  if (!best) return 0;
  const ma = a.spec.mass;
  const mb = b.spec.mass;
  const wa = mb / (ma + mb);
  const wb = ma / (ma + mb);
  sa.pos.x -= best.nx * best.pen * wa;
  sa.pos.z -= best.nz * best.pen * wa;
  sb.pos.x += best.nx * best.pen * wb;
  sb.pos.z += best.nz * best.pen * wb;
  const rel = (sb.vel.x - sa.vel.x) * best.nx + (sb.vel.z - sa.vel.z) * best.nz;
  if (rel < 0) {
    const imp = -rel * 0.62;
    sa.vel.x -= best.nx * imp * wa * 1.6;
    sa.vel.z -= best.nz * imp * wa * 1.6;
    sb.vel.x += best.nx * imp * wb * 1.6;
    sb.vel.z += best.nz * imp * wb * 1.6;
    sa.speed *= 0.86;
    sb.speed *= 0.86;
    // contact only hurts above a walking-pace shove, so a queue cannot chew a car to scrap
    if (-rel > 3.2) {
      a.damage((-rel - 3.2) * 0.5);
      b.damage((-rel - 3.2) * 0.5);
    }
    return -rel;
  }
  return 0;
}

// Nearest car to a point within radius, preferring the one the caller can legally take.
export function nearestCar(cars, x, z, radius = 4) {
  let best = null;
  let bestD = radius;
  for (const c of cars) {
    if (!c || c.destroyed) continue;
    const d = Math.hypot(c.state.pos.x - x, c.state.pos.z - z) - c.length * 0.28;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// Soft round sprite for smoke, generated once on a canvas.
let _disc = null;
function softDisc() {
  if (_disc) return _disc;
  const size = 64;
  const el = document.createElement('canvas');
  el.width = size;
  el.height = size;
  const ctx = el.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.42)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _disc = new THREE.CanvasTexture(el);
  _disc.colorSpace = THREE.SRGBColorSpace;
  return _disc;
}

export { PAINT_HEX };
