// Costa Lume — the Policía de Lume: the wanted level, the pursuit and the end of a chase.
//
// One heat value drives everything else. Shooting, killing, taking a car where a uniform can see it,
// or a cruiser taking a hit all add heat; heat divided by STAR_STEP is the star rating, and left alone
// it bleeds away once nobody has seen the player for a while, crossing the star boundaries downward.
//
//   stars  cruisers  on foot
//   1      1         0            (the navy will look for you, one car)
//   2      1         0
//   3      2         3
//   4      3         4            roadblock cruiser parked across the road ahead
//   5      3         5            marksmen in the cruisers
//
// Cruisers spawn on the road graph behind the camera, drive the same arcade chassis as everything else
// (stepCar from entities/vehicles.js — one grip model, one collision resolver), close on the player,
// try to box the pair in, ram inside RAM_RANGE and spill officers at close range. Officers on foot walk
// through the same circle-vs-AABB rules the player uses, duck behind the nearest wall when shot at and
// fire bursts with a muzzle flash and a tracer.
//
// A chase ends in one of three ways:
//   escape  no sighting for ESCAPE_SIGHT seconds and nobody within ESCAPE_NEAR: heat bleeds, one star
//           drops every ESCAPE_STAR_T seconds, and the last star clears after ESCAPE_CLEAR seconds.
//           Entering the water drops it outright once the pursuit has lost sight.
//   WASTED  health reaches 0: a short overlay, then a respawn at the nearest hospital.
//   BUSTED  stopped inside a ring of two officers for BUSTED_SURROUND seconds: overlay, then the
//           nearest police station.
// Both endings clear the level and take a cash penalty off the game state.
//
// main.js mirrors `stars` into the HUD and `dots()` onto the minimap; systems/combat.js raycasts
// against `officers` and `cruisers` and reports damage back through damageOfficer()/hitCruiser().
import * as THREE from 'three';
import { createCar, stepCar, resolvePair } from '../entities/vehicles.js';
import { PLAYER } from '../entities/player.js';
import { createEffects, softDiscTexture } from './effects.js';

// Tuning. Metres, seconds, heat points (one star is STAR_STEP of heat).
export const POLICE = {
  STAR_STEP: 12,
  HEAT_MAX: 60,

  // what a crime is worth
  HEAT_SHOT: 2.0,
  HEAT_PED_KILL: 9,
  HEAT_OFFICER_KILL: 12,
  HEAT_STEAL: 10,
  HEAT_CRUISER_HIT: 3,
  HEAT_RAM: 2.4,

  // sighting and escape
  SIGHT_CAR: 58,          // a cruiser sees this far
  SIGHT_FOOT: 34,         // an officer on foot, with a clear line, sees this far
  ESCAPE_SIGHT: 11,       // seconds unseen before heat starts to bleed
  ESCAPE_NEAR: 32,        // ... and nobody may be within this radius either
  ESCAPE_STAR_T: 6,       // one star leaves the board this often while the trail is cold
  WATER_Z: -312,          // south of this is beach and sea: no cruiser follows

  // spawning
  SPAWN_MIN: 105,         // metres behind the camera
  SPAWN_MAX: 210,
  SPAWN_COOLDOWN: 4.5,
  DESPAWN: 280,

  // driving at the player
  CHASE_TOP: 46,          // m/s on the way in
  RIDE_TOP: 47,           // ... and closing for a ram: under a Tiburón's 53, so a clean run escapes
  SEARCH_TOP: 20,         // m/s hunting a cold trail
  NAV_CRUISE: 17,         // m/s while routing along the grid (a block is 72 m)
  ENGAGE: 30,             // metres: inside this, with a clear line, a cruiser goes straight for him
  RAM_RANGE: 7.5,
  RAM_COOLDOWN: 2.2,
  BOX_LEAD: 11,           // the wing cruiser aims this far ahead of the player
  BLOCK_AHEAD: 120,       // where a 4-star roadblock is parked

  // officers on foot
  DISGORGE: 12,           // metres from a stopped cruiser
  DISGORGE_COOLDOWN: 9,
  OFFICER_SPEED: 5.4,
  OFFICER_STANDOFF: 15,   // closes to this and holds
  OFFICER_RANGE: 30,      // will not fire past this
  OFFICER_ACCURACY: 0.55, // hit chance per round at 8 m, falling with distance
  OFFICER_DAMAGE: 7.5,
  BURST_ROUNDS: 3,
  BURST_GAP: 0.15,
  BURST_COOLDOWN: 1.9,
  COVER_RADIUS: 6.5,

  // busted
  ARREST_RADIUS: 6,       // an officer this close to a stopped man stops shooting and moves in
  BUSTED_RADIUS: 2.8,
  BUSTED_MIN: 2,
  BUSTED_SPEED: 1.3,
  BUSTED_HOLD: 2.5,

  // endings
  OVERLAY: 3.2,
  PENALTY_BUSTED: 150,   // floor of the hospital/station bill, before the share of cash
  PENALTY_WASTED: 250,
  PENALTY_SHARE: 0.08,   // ... plus this share of what he was carrying, capped at PENALTY_CAP
  PENALTY_CAP: 300,
};

const CRUISER_PAINT = 0xf2efe6;
const SIREN_RED = 0xff2a1a;
const SIREN_BLUE = 0x2f6fff;
const PAD_Y = 0.16;
const ROAD_HALF = 12.2;
const LANE_OFFSET = 3.0;     // the inner lane, same offset systems/traffic.js drives in

// Hospital and station anchors. city.js has no building registry, so each anchor is snapped to the
// nearest of its legal spawn points when the system is built: the respawn always lands on a sidewalk.
const RESPAWN_SITES = [
  { kind: 'hospital', name: 'Hospital San Rafael', x: -60, z: -110 },
  { kind: 'hospital', name: 'Clínica Puerto Alto', x: -22, z: 76 },
  { kind: 'station', name: 'Comisaría de Lume', x: -22, z: -172 },
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function angleTo(ax, az, bx, bz) {
  // shared yaw convention: 0 looks down -Z
  return Math.atan2(-(bx - ax), -(bz - az));
}

function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ---------------------------------------------------------------------------------------------
// Officer figure: seven instanced parts for every officer in the city, same trick as traffic.js's
// pedestrians. One torso, two legs, two arms, head and a peaked cap.
// ---------------------------------------------------------------------------------------------
function officerGeometries() {
  return {
    torso: new THREE.BoxGeometry(0.44, 0.58, 0.26),
    leg: new THREE.BoxGeometry(0.16, 0.90, 0.18).translate(0, -0.45, 0),
    arm: new THREE.BoxGeometry(0.12, 0.52, 0.14).translate(0, -0.26, 0),
    head: new THREE.BoxGeometry(0.20, 0.22, 0.21),
    cap: new THREE.BoxGeometry(0.24, 0.08, 0.26),
    vest: new THREE.BoxGeometry(0.47, 0.40, 0.29),
    badge: new THREE.BoxGeometry(0.06, 0.06, 0.02),
  };
}

function createOfficerBatch(scene, capacity = 10) {
  const geo = officerGeometries();
  const mats = {
    cloth: new THREE.MeshStandardMaterial({ color: 0x23364f, roughness: 0.84, metalness: 0.02 }),
    trousers: new THREE.MeshStandardMaterial({ color: 0x1a2435, roughness: 0.9, metalness: 0.02 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xa8744e, roughness: 0.74, metalness: 0.02 }),
    cap: new THREE.MeshStandardMaterial({ color: 0x141b25, roughness: 0.9, metalness: 0.02 }),
    badge: new THREE.MeshBasicMaterial({ color: 0xe8b96b, toneMapped: false }),
  };
  const group = new THREE.Group();
  group.name = 'police-officers';
  scene.add(group);

  const parts = {
    torso: new THREE.InstancedMesh(geo.torso, mats.cloth, capacity),
    vest: new THREE.InstancedMesh(geo.vest, mats.cap, capacity),
    badge: new THREE.InstancedMesh(geo.badge, mats.badge, capacity),
    legL: new THREE.InstancedMesh(geo.leg, mats.trousers, capacity),
    legR: new THREE.InstancedMesh(geo.leg, mats.trousers, capacity),
    armL: new THREE.InstancedMesh(geo.arm, mats.cloth, capacity),
    armR: new THREE.InstancedMesh(geo.arm, mats.cloth, capacity),
    head: new THREE.InstancedMesh(geo.head, mats.skin, capacity),
    cap: new THREE.InstancedMesh(geo.cap, mats.cap, capacity),
  };
  for (const m of Object.values(parts)) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.castShadow = true;
    m.receiveShadow = false;
    m.frustumCulled = false;
    group.add(m);
  }
  const dummy = new THREE.Object3D();
  const local = new THREE.Matrix4();
  const joint = new THREE.Matrix4();
  const out = new THREE.Matrix4();

  // Hidden instances are parked under the world, not scaled to nothing: a zero matrix costs the
  // rasteriser nothing either way, but this keeps the bounding sphere sane.
  function place(mesh, i, o, ox, oy, oz, swing) {
    dummy.position.set(o.x, o.y, o.z);
    dummy.rotation.set(0, o.yaw + Math.PI, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    out.copy(dummy.matrix);
    local.makeTranslation(ox, oy, oz);
    joint.makeRotationX(swing);
    out.multiply(local);
    out.multiply(joint);
    mesh.setMatrixAt(i, out);
  }

  function write(list) {
    const n = list.length;
    for (let i = 0; i < capacity; i += 1) {
      const o = list[i];
      if (!o) {
        dummy.position.set(0, -60, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(0.001);
        dummy.updateMatrix();
        for (const m of Object.values(parts)) m.setMatrixAt(i, dummy.matrix);
        continue;
      }
      const gait = Math.sin(o.phase) * (o.moving ? 0.7 : 0.06);
      place(parts.torso, i, o, 0, 1.18, 0, 0);
      place(parts.vest, i, o, 0, 1.20, 0.01, 0);
      place(parts.badge, i, o, 0.12, 1.30, 0.16, 0);
      place(parts.legL, i, o, -0.11, 0.90, 0, gait);
      place(parts.legR, i, o, 0.11, 0.90, 0, -gait);
      // the right arm carries the pistol, so it stays out in front while a burst is going off
      place(parts.armL, i, o, -0.29, 1.44, 0, -gait * 0.8);
      place(parts.armR, i, o, 0.29, 1.44, 0, o.aiming ? -1.35 : gait * 0.8);
      place(parts.head, i, o, 0, 1.59, 0, 0);
      place(parts.cap, i, o, 0, 1.72, 0.01, 0);
    }
    for (const m of Object.values(parts)) m.instanceMatrix.needsUpdate = true;
  }

  function dispose() {
    scene.remove(group);
    for (const g of Object.values(geo)) g.dispose();
    for (const m of Object.values(mats)) m.dispose();
    for (const m of Object.values(parts)) m.dispose();
  }

  return { group, parts, write, dispose, capacity };
}

// ---------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------
export function createPolice({ scene, city, player, hud, rng, audio, traffic, effects, game }) {
  const colliders = (city && city.colliders) || [];
  const bounds = (city && city.bounds) || { minX: -420, maxX: 420, minZ: -520, maxZ: 420 };
  const nodes = (city && city.roadGraph && city.roadGraph.intersections) || [];
  const streets = (city && city.roadGraph && city.roadGraph.streets) || [];
  const spawnPoints = (city && city.spawnPoints) || [];

  // The city's intersections as a drivable graph: junctions linked to their neighbours along each
  // row and column. traffic.js builds the same lattice for its drivers; the police need their own
  // copy because a pursuit routes toward a moving target, not a random next turn.
  const roadNodes = [];
  {
    const byKey = new Map();
    const add = (x, z) => {
      const key = `${x.toFixed(1)}|${z.toFixed(1)}`;
      let n = byKey.get(key);
      if (!n) { n = { x, z, next: [] }; byKey.set(key, n); roadNodes.push(n); }
      return n;
    };
    for (const ix of nodes) add(ix.x, ix.z);
    const rows = new Map();
    const cols = new Map();
    for (const n of roadNodes) {
      if (!rows.has(n.z)) rows.set(n.z, []);
      if (!cols.has(n.x)) cols.set(n.x, []);
      rows.get(n.z).push(n);
      cols.get(n.x).push(n);
    }
    const link = (a, b) => {
      if (!a.next.includes(b)) a.next.push(b);
      if (!b.next.includes(a)) b.next.push(a);
    };
    for (const list of rows.values()) {
      list.sort((p, q) => p.x - q.x);
      for (let i = 0; i + 1 < list.length; i += 1) link(list[i], list[i + 1]);
    }
    for (const list of cols.values()) {
      list.sort((p, q) => p.z - q.z);
      for (let i = 0; i + 1 < list.length; i += 1) link(list[i], list[i + 1]);
    }
  }

  const root = new THREE.Group();
  root.name = 'police';
  if (scene) scene.add(root);
  // the officers' tracers and flashes; a caller may hand in a shared pool instead
  const fx = effects || createEffects(scene);

  const officers = createOfficerBatch(scene, 10);

  // ---- state the game reads --------------------------------------------------------------------
  let stars = 0;
  let heat = 0;
  let sightTimer = 0;        // seconds since a uniform last saw the player
  let contactTimer = 0;      // seconds with nobody within ESCAPE_NEAR
  let starTimer = 0;         // per-star escape clock
  let spawnTimer = 0;
  let sirenPhase = 0;
  let overlay = null;        // 'busted' | 'wasted' while the fade is up
  let overlayT = 0;
  let contact = false;                 // a uniform has eyes on the player this step
  const lastKnown = { x: 0, z: 0 };    // where he was when they last had him
  let lastCar = null;
  let lastBlock = -Infinity; // sim time of the last roadblock
  let bustT = 0;             // seconds stopped inside a ring of officers
  let clock = 0;

  const cruisers = [];
  const officerList = [];

  // one shared siren light: it sits on whichever cruiser is nearest, so three patrol cars cost one
  const sirenLight = new THREE.PointLight(SIREN_BLUE, 0, 16, 2);
  sirenLight.name = 'siren-light';
  root.add(sirenLight);

  const disc = softDiscTexture();
  const haloTexture = disc;

  // ---- helper: is this spot asphalt? (same rule player.js uses to pick an exit side) -------------
  function onRoadway(x, z) {
    for (const s of streets) {
      if (s.axis === 'z') {
        if (Math.abs(x - s.centre) <= ROAD_HALF && z >= s.from && z <= s.to) return true;
      } else if (Math.abs(z - s.centre) <= ROAD_HALF && x >= s.from && x <= s.to) return true;
    }
    return false;
  }

  function streetLevel(x, z) {
    return onRoadway(x, z) ? 0.02 : PAD_Y;
  }

  // ---- line of sight: ray vs the city's solid boxes, in plan ------------------------------------
  function blocked(ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return false;
    const ux = dx / len;
    const uz = dz / len;
    for (let i = 0; i < colliders.length; i += 1) {
      const c = colliders[i];
      if (c.height !== undefined && c.height < 1.3) continue;      // kerbs, paint, benches
      let t0 = 0;
      let t1 = len;
      // slab test on x, then z
      if (Math.abs(ux) < 1e-8) {
        if (ax < c.minX || ax > c.maxX) continue;
      } else {
        let a = (c.minX - ax) / ux;
        let b = (c.maxX - ax) / ux;
        if (a > b) { const s = a; a = b; b = s; }
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
        if (t0 > t1) continue;
      }
      if (Math.abs(uz) < 1e-8) {
        if (az < c.minZ || az > c.maxZ) continue;
      } else {
        let a = (c.minZ - az) / uz;
        let b = (c.maxZ - az) / uz;
        if (a > b) { const s = a; a = b; b = s; }
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
        if (t0 > t1) continue;
      }
      if (t0 > 0.4 && t0 < len - 0.2) return true;
    }
    return false;
  }

  // ---- hired hardware ---------------------------------------------------------------------------
  // A cruiser's own light bar: the brand geometry ships two bar meshes; each car gets its own pair of
  // unlit materials so the bar can flash without repainting every patrol car in the city.
  function dressCruiser(car) {
    const lamps = car._internal && car._internal.lampMeshes && car._internal.lampMeshes.bar;
    const barAnchor = car._internal && car._internal.geo && car._internal.geo.barL;
    const bar = [];
    if (lamps && lamps.length >= 2) {
      const red = new THREE.MeshBasicMaterial({ color: SIREN_RED, toneMapped: false });
      const blue = new THREE.MeshBasicMaterial({ color: SIREN_BLUE, toneMapped: false });
      lamps[0].material = blue;
      lamps[1].material = red;
      bar.push({ mesh: lamps[0], mat: blue }, { mesh: lamps[1], mat: red });
    }
    // glow discs above the bar: the siren a still screenshot has to imply
    const y = barAnchor ? barAnchor[1] + 0.10 : 1.86;
    const z = barAnchor ? barAnchor[2] : 0.1;
    const halos = [];
    for (const [side, colour] of [[-1, SIREN_RED], [1, SIREN_BLUE]]) {
      const mat = new THREE.SpriteMaterial({
        map: haloTexture, color: colour, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      const halo = new THREE.Sprite(mat);
      halo.position.set(side * 0.30, y, z);
      halo.scale.setScalar(1.4);
      car.body.add(halo);
      halos.push(halo);
    }
    return { bar, halos };
  }

  function makeCruiser(x, z, yaw, speed = 0) {
    const car = createCar('patrulla', CRUISER_PAINT, { x, z, yaw, driver: 'police', lightsOn: true });
    if (scene) scene.add(car.group);
    car.setPose(x, z, yaw);
    car.lightsOn = true;
    car.state.speed = speed;
    car.state.vel.set(-Math.sin(yaw) * speed, 0, -Math.cos(yaw) * speed);
    car.syncTransform();
    car.refreshLamps();
    const dress = dressCruiser(car);
    const rec = {
      car, dress, staged: false,
      hasOfficers: false, disgorgeAt: 0, ramAt: 0, blocked: false, wing: 0,
    };
    car.police = rec;
    cruisers.push(rec);
    return rec;
  }

  function nearestNode(x, z) {
    let best = null;
    let bestD = Infinity;
    for (const n of roadNodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  // The next junction on the way to the player: the neighbour that ends up closest to him, with a
  // small preference for carrying straight on so the pursuit does not zig-zag block by block.
  function nextNode(from, at) {
    if (!at) return null;
    const p = player.position;
    let best = null;
    let bestScore = Infinity;
    for (const n of at.next) {
      if (n === from) continue;
      let score = Math.hypot(n.x - p.x, n.z - p.z);
      if (!from) score *= 0.9;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  function releaseCruiser(rec) {
    const i = cruisers.indexOf(rec);
    if (i >= 0) cruisers.splice(i, 1);
    if (rec.car.group.parent) rec.car.group.parent.remove(rec.car.group);
  }

  // ---- where a patrol car comes from -------------------------------------------------------------
  function pickSpawnNode() {
    const p = player.position;
    const yaw = player.heading;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let best = null;
    let bestScore = -Infinity;
    for (const n of roadNodes) {
      const dx = n.x - p.x;
      const dz = n.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 40 || d > POLICE.SPAWN_MAX) continue;
      const ahead = (dx * fx + dz * fz) / (d || 1);       // +1 straight ahead, -1 behind
      // behind first, and a node that is far enough to be off the camera anyway
      const score = (d >= POLICE.SPAWN_MIN ? 1.5 : 0) - ahead * 2.4 - d * 0.004;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  // A cruiser appears at a junction behind the camera, in the lane that runs toward the player:
  // right-hand traffic, so the car sits one lane offset to the right of its travel direction.
  function spawnCruiser() {
    const node = pickSpawnNode();
    if (!node) return null;
    const yaw = angleTo(node.x, node.z, player.position.x, player.position.z);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = fz;
    const rz = -fx;
    const x = node.x + rx * LANE_OFFSET;
    const z = node.z + rz * LANE_OFFSET;
    const rec = makeCruiser(x, z, yaw, 12);
    rec.ramAt = clock + 1.5;
    lastKnown.x = player.position.x;
    lastKnown.z = player.position.z;
    return rec;
  }

  // ---- cruisers driving at the player ------------------------------------------------------------
  const driveCtx = {
    colliders,
    bounds,
    cars: null,
    onImpact: (car, other, severity) => {
      if (severity > 9) car.damage((severity - 9) * 0.6);
    },
  };

  function stepCruiser(rec, dt) {
    const car = rec.car;
    const st = car.state;
    if (car.destroyed) {
      rec.deadT = (rec.deadT || 0) + dt;
      stepCar(car, dt, { throttle: 0, brake: 1, steer: 0, handbrake: 0 }, driveCtx);
      if (rec.deadT > 12) releaseCruiser(rec);
      return;
    }
    const p = player.position;
    const dx = p.x - st.pos.x;
    const dz = p.z - st.pos.z;
    const dist = Math.hypot(dx, dz);
    const speedAbs = Math.abs(st.speed);

    // Stuck recovery: a patrol car pinned on a kerb or a wall backs off, re-aims and tries again.
    // Without it one bad corner parks a pursuit car for the rest of the chase.
    if (speedAbs < 0.6) rec.stuckT = (rec.stuckT || 0) + dt;
    else rec.stuckT = 0;
    if (rec.stuckT > 2.2) {
      rec.stuckT = 0;
      rec.reverseT = 1.3;
      rec.nav = null;
    }
    if (rec.reverseT > 0) {
      rec.reverseT -= dt;
      const away = st.steer ? -Math.sign(st.steer) : 1;
      stepCar(car, dt, { throttle: -1, brake: 0, steer: away * 0.6, handbrake: 0 }, driveCtx);
      return;
    }

    // Two steering modes. Far away, out of sight, the car follows the street grid junction by
    // junction — a straight line to the player would put it through a block. Close and in the clear
    // it goes straight for him, which is where the ramming and the boxing happen.
    const canEngage = dist < POLICE.ENGAGE && (contact || !blocked(st.pos.x, st.pos.z, p.x, p.z));
    let tx = p.x;
    let tz = p.z;
    let corner = Infinity;
    let legYaw = st.yaw;

    if (canEngage) {
      tx = contact ? p.x : lastKnown.x;
      tz = contact ? p.z : lastKnown.z;
      if (contact && rec.wing > 0) {
        tx = p.x - Math.sin(player.heading) * POLICE.BOX_LEAD;
        tz = p.z - Math.cos(player.heading) * POLICE.BOX_LEAD;
      }
    } else {
      if (!rec.nav) rec.nav = { a: nearestNode(st.pos.x, st.pos.z), b: null };
      const nav = rec.nav;
      if (!nav.b) nav.b = nextNode(nav.a, nav.a) || nav.a;
      if (Math.hypot(nav.b.x - st.pos.x, nav.b.z - st.pos.z) < 10) {
        const n = nextNode(nav.a, nav.b);
        nav.a = nav.b;
        if (n) nav.b = n;
      }
      // aim at the junction, one lane to the right of the leg's direction
      legYaw = angleTo(nav.a.x, nav.a.z, nav.b.x, nav.b.z);
      tx = nav.b.x - Math.cos(legYaw) * LANE_OFFSET;
      tz = nav.b.z + Math.sin(legYaw) * LANE_OFFSET;

      // corner governor: a 20 m/s cruiser cannot turn into a 24 m street, so brake for the junction
      const dNode = Math.hypot(nav.b.x - st.pos.x, nav.b.z - st.pos.z);
      const after = dNode < 40 ? nextNode(nav.a, nav.b) : null;
      if (after) {
        const outYaw = angleTo(nav.b.x, nav.b.z, after.x, after.z);
        const turn = Math.abs(angleDelta(legYaw, outYaw));
        corner = turn > 0.6 ? 7 : turn > 0.22 ? 12 : Infinity;
      }
    }

    const wantYaw = angleTo(st.pos.x, st.pos.z, tx, tz);
    const dyaw = angleDelta(st.yaw, wantYaw);
    const steer = clamp(dyaw * 2.2, -1, 1);

    // speed: close the gap, then match, then try to hit; a cold trail is hunted at a crawl and
    // abandoned once the last known spot is reached
    const trail = Math.hypot(lastKnown.x - st.pos.x, lastKnown.z - st.pos.z);
    let want;
    if (canEngage) {
      want = contact
        ? (dist > 26 ? POLICE.RIDE_TOP : Math.max(6, dist * 1.4))
        : (trail < 10 ? 0 : POLICE.SEARCH_TOP);
    } else {
      want = contact ? POLICE.NAV_CRUISE : (trail < 12 ? 0 : POLICE.SEARCH_TOP);
    }
    if (contact && rec.wing > 0 && dist < 14) want = 34;
    if (Math.abs(dyaw) > 1.1) want = Math.min(want, 11);        // scrubbing off for a hard turn
    want = Math.min(want, corner);
    const ramming = contact && dist < POLICE.RAM_RANGE + 6 && Math.abs(dyaw) < 0.5 && clock > rec.ramAt;
    if (ramming) want = Math.min(POLICE.RIDE_TOP, Math.max(want, POLICE.RIDE_TOP));

    const err = want - speedAbs;
    const throttle = err > 0.5 ? 1 : 0;
    const brake = err < -2.5 ? Math.min(1, -err * 0.09) : 0;
    stepCar(car, dt, { throttle, brake, steer, handbrake: 0 }, driveCtx);

    // a ram that lands costs the player health, the car damage, and adds heat
    if (ramming && dist < POLICE.RAM_RANGE && speedAbs > 7) {
      rec.ramAt = clock + POLICE.RAM_COOLDOWN;
      addHeat(POLICE.HEAT_RAM);
      if (player.car && !player.onFoot) {
        player.car.damage(4.5);
        player.damage(5);
      } else {
        player.damage(9);
      }
      if (player.onFoot) player.velocity.set(dx / (dist || 1) * 4, 1.8, dz / (dist || 1) * 4);
      if (audio && audio.crash) audio.crash(0.6);
    }

    // a stopped cruiser close to a player on foot puts two officers out
    if (stars >= 3 && !rec.hasOfficers && contact && dist < POLICE.DISGORGE
        && Math.abs(st.speed) < 5.5 && officerList.length < officerQuota()) {
      rec.hasOfficers = true;
      const rx = Math.cos(st.yaw);
      const rz = -Math.sin(st.yaw);
      for (const s of [1, -1]) {
        if (officerList.length >= officerQuota()) break;
        spawnOfficer(st.pos.x + rx * s * 2.1, st.pos.z + rz * s * 2.1);
      }
    }
  }

  // ---- officers on foot --------------------------------------------------------------------------
  function officerQuota() {
    if (stars >= 5) return 5;
    if (stars === 4) return 4;
    if (stars === 3) return 3;
    return 0;
  }

  function spawnOfficer(x, z) {
    if (officerList.length >= officers.capacity) return null;
    const o = {
      x, z, y: streetLevel(x, z),
      yaw: angleTo(x, z, player.position.x, player.position.z),
      health: 55, alive: true,
      phase: rng() * Math.PI * 2, moving: false,
      burst: 0, burstT: 0, cool: 0.6 + rng() * 0.7,
      aiming: false,
      cover: null, coverT: 0,
    };
    officerList.push(o);
    return o;
  }

  function removeOfficer(o) {
    const i = officerList.indexOf(o);
    if (i >= 0) officerList.splice(i, 1);
  }

  // The player's own collision rule, applied to a walker: one axis at a time, step-up over kerbs,
  // bounds clamped, and the ground taken from the road graph (pads have no colliders).
  function moveOfficer(o, dx, dz) {
    const r = PLAYER.radius;
    const feet = o.y;
    const solidAt = (x, z) => {
      for (let i = 0; i < colliders.length; i += 1) {
        const c = colliders[i];
        if (c.maxX <= x - r || c.minX >= x + r || c.maxZ <= z - r || c.minZ >= z + r) continue;
        if (c.height !== undefined && c.height <= feet + PLAYER.stepUp) continue;
        return c;
      }
      return null;
    };
    if (dx) {
      const nx = o.x + dx;
      const c = solidAt(nx, o.z);
      if (c) o.x = dx > 0 ? c.minX - r - 1e-4 : c.maxX + r + 1e-4;
      else o.x = nx;
    }
    if (dz) {
      const nz = o.z + dz;
      const c = solidAt(o.x, nz);
      if (c) o.z = dz > 0 ? c.minZ - r - 1e-4 : c.maxZ + r + 1e-4;
      else o.z = nz;
    }
    o.x = clamp(o.x, bounds.minX + r, bounds.maxX - r);
    o.z = clamp(o.z, bounds.minZ + r, bounds.maxZ - r);
    o.y += (streetLevel(o.x, o.z) - o.y) * 0.25;
  }

  // The nearest solid that could actually stop a round aimed at the officer: a wall on the side he is
  // being shot from, not the one behind him.
  function findCover(o) {
    const p = player.position;
    const tx = p.x - o.x;
    const tz = p.z - o.z;
    let best = null;
    let bestD = POLICE.COVER_RADIUS;
    for (let i = 0; i < colliders.length; i += 1) {
      const c = colliders[i];
      if (c.height !== undefined && c.height < 1.5) continue;
      const cx = clamp(o.x, c.minX, c.maxX);
      const cz = clamp(o.z, c.minZ, c.maxZ);
      const d = Math.hypot(cx - o.x, cz - o.z);
      if (d < 0.15 || d > bestD) continue;
      // only a face on the shooter's side is cover
      if ((cx - o.x) * tx + (cz - o.z) * tz <= 0) continue;
      // and stop half a metre short of the wall, on the officer's side of it
      const back = 0.55 / d;
      bestD = d;
      best = { x: cx - (cx - o.x) * back, z: cz - (cz - o.z) * back };
    }
    return best;
  }

  function officerFire(o, dt) {
    const p = player.position;
    const dx = p.x - o.x;
    const dz = p.z - o.z;
    const dist = Math.hypot(dx, dz);
    const canSee = dist < POLICE.OFFICER_RANGE && !blocked(o.x, o.z, p.x, p.z);
    o.aiming = canSee;

    // Point blank on a man who has stopped: they put the gun away and make the arrest instead.
    // That is what turns a stand-off into BUSTED instead of another body on the pavement.
    if (player.onFoot && player.speed < 1.6 && dist < POLICE.ARREST_RADIUS) {
      o.burst = 0;
      o.cool = Math.max(o.cool, 0.8);
      return;
    }

    if (o.burst > 0) {
      o.burstT -= dt;
      if (o.burstT <= 0 && canSee) {
        o.burst -= 1;
        o.burstT = POLICE.BURST_GAP;
        const muzzle = { x: o.x + Math.sin(o.yaw) * -0.34, y: o.y + 1.36, z: o.z + Math.cos(o.yaw) * -0.34 };
        const chest = { x: p.x, y: p.y + 1.2, z: p.z };
        fx.muzzle(muzzle, 0xffc47a);
        const hitChance = clamp(POLICE.OFFICER_ACCURACY - dist * 0.011, 0.12, 0.62);
        if (rng() < hitChance) {
          fx.tracer(muzzle, chest, 0xffe2b4, 0.03);
          fx.spark(chest, 0xff7a5a);
          player.damage(POLICE.OFFICER_DAMAGE);
          if (audio && audio.hit) audio.hit(0.4);
        } else {
          const miss = { x: chest.x + (rng() - 0.5) * 1.8, y: chest.y + (rng() - 0.5) * 0.8, z: chest.z + (rng() - 0.5) * 1.8 };
          fx.tracer(muzzle, miss, 0xffe2b4, 0.03);
        }
        if (o.burst <= 0) {
          o.cool = POLICE.BURST_COOLDOWN + rng() * 0.8;
          // after a burst he reconsiders his cover; shot at, he keeps it
          if (!o.cover) o.cover = findCover(o);
        }
        if (audio && audio.gunshot) audio.gunshot(0.35);
      }
      return;
    }

    o.cool -= dt;
    if (o.cool <= 0 && canSee) {
      o.burst = POLICE.BURST_ROUNDS;
      o.burstT = 0;
    }
  }

  function stepOfficer(o, dt) {
    const p = player.position;
    const dx = p.x - o.x;
    const dz = p.z - o.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.4) o.yaw = angleTo(o.x, o.z, p.x, p.z);

    // move: to the cover point while he wants it, otherwise close to the standoff ring
    o.moving = false;
    let tx = null;
    let tz = null;
    if (o.cover && o.coverT > 0) {
      o.coverT -= dt;
      tx = o.cover.x;
      tz = o.cover.z;
    } else if (dist > POLICE.OFFICER_STANDOFF) {
      tx = p.x;
      tz = p.z;
    }
    if (tx !== null) {
      const mx = tx - o.x;
      const mz = tz - o.z;
      const md = Math.hypot(mx, mz);
      if (md > 0.6) {
        const sp = POLICE.OFFICER_SPEED * (dist > 24 ? 1 : 0.7);
        moveOfficer(o, (mx / md) * sp * dt, (mz / md) * sp * dt);
        o.moving = true;
        o.phase += Math.abs(sp * dt) * 4.4;
      } else if (o.cover) {
        o.cover = null;      // arrived: hold the position and shoot from it
      }
    }

    officerFire(o, dt);
  }

  // ---- heat and the level -----------------------------------------------------------------------
  function starsForHeat(h) {
    return clamp(Math.floor(h / POLICE.STAR_STEP), 0, 5);
  }

  function syncStars(next) {
    const clamped = clamp(next, 0, 5);
    if (clamped === stars) return stars;
    const up = clamped > stars;
    stars = clamped;
    heat = clamp(heat, stars * POLICE.STAR_STEP, POLICE.HEAT_MAX);
    if (stars === 0) heat = 0;
    if (hud && up && stars === 1) hud.toast('Policía: you have their attention');
    if (audio && audio.siren) audio.siren(stars > 0);
    if (stars >= 4 && clock - lastBlock > 25) placeRoadblock();
    return stars;
  }

  function addHeat(amount) {
    if (!(amount > 0)) return stars;
    heat = Math.min(POLICE.HEAT_MAX, heat + amount);
    return syncStars(starsForHeat(heat));
  }

  // A 4/5-star roadblock: one parked cruiser across the road ahead, officers behind it.
  function placeRoadblock() {
    const p = player.position;
    const yaw = player.heading;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let best = null;
    let bestD = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d < POLICE.BLOCK_AHEAD * 0.6 || d > POLICE.BLOCK_AHEAD * 1.4) continue;
      const ahead = ((n.x - p.x) * fx + (n.z - p.z) * fz) / (d || 1);
      if (ahead < 0.6) continue;
      if (Math.abs(d - POLICE.BLOCK_AHEAD) < bestD) { bestD = Math.abs(d - POLICE.BLOCK_AHEAD); best = n; }
    }
    if (!best) return;
    lastBlock = clock;
    const rec = makeCruiser(best.x, best.z, yaw + Math.PI / 2, 0);
    rec.blocked = true;
    for (let i = 0; i < 2 && officerList.length < officerQuota(); i += 1) {
      spawnOfficer(best.x + (i ? 2.2 : -2.2), best.z - 1.6);
    }
  }

  // ---- chase bookkeeping ------------------------------------------------------------------------
  function sighted() {
    const p = player.position;
    for (const rec of cruisers) {
      const c = rec.car;
      if (c.destroyed) continue;
      const d = Math.hypot(c.state.pos.x - p.x, c.state.pos.z - p.z);
      if (d > POLICE.SIGHT_CAR) continue;
      // a patrol car sees down the street it is on; a block between the two breaks the sighting,
      // which is what makes a corner worth taking
      if (d < 18 || !blocked(c.state.pos.x, c.state.pos.z, p.x, p.z)) return true;
    }
    for (const o of officerList) {
      if (!o.alive) continue;
      if (Math.hypot(o.x - p.x, o.z - p.z) < POLICE.SIGHT_FOOT && !blocked(o.x, o.z, p.x, p.z)) return true;
    }
    return false;
  }

  function nearestUnitDistance() {
    const p = player.position;
    let best = Infinity;
    for (const rec of cruisers) {
      best = Math.min(best, Math.hypot(rec.car.state.pos.x - p.x, rec.car.state.pos.z - p.z));
    }
    for (const o of officerList) best = Math.min(best, Math.hypot(o.x - p.x, o.z - p.z));
    return best;
  }

  function stepWanted(dt) {
    if (stars === 0) { sightTimer = 0; contactTimer = 0; starTimer = 0; return; }
    const seen = sighted();
    const near = nearestUnitDistance();
    if (seen) {
      sightTimer = 0;
      contactTimer = 0;
      starTimer = 0;
      return;
    }
    sightTimer += dt;
    if (near <= POLICE.ESCAPE_NEAR) { contactTimer = 0; starTimer = 0; return; }
    contactTimer += dt;
    if (sightTimer < POLICE.ESCAPE_SIGHT) return;

    // The trail is cold: heat bleeds at exactly one star per ESCAPE_STAR_T seconds, so a five-star
    // level takes half a minute of clean air to shake and the last star is gone soonest of all.
    starTimer += dt;
    heat = Math.max(0, heat - (POLICE.STAR_STEP / POLICE.ESCAPE_STAR_T) * dt);
    syncStars(starsForHeat(heat));
    if (stars === 0) {
      if (hud) hud.toast('You lost the Policía');
      if (audio && audio.siren) audio.siren(false);
      return;
    }
    void starTimer;

    // the sea: once they have lost sight, swimming out drops the level outright
    if (player.position.z < POLICE.WATER_Z && sightTimer > 2.5 && stars > 0) {
      heat = 0;
      syncStars(0);
      if (hud) hud.toast('The Policía will not follow you into the water');
    }
  }

  // ---- endings ------------------------------------------------------------------------------------
  function siteFor(kind) {
    // the authored anchor, snapped to the nearest legal spawn point so the feet land on a sidewalk
    let best = null;
    let bestAnchorD = Infinity;
    for (const s of RESPAWN_SITES) {
      if (s.kind !== kind) continue;
      const d = Math.hypot(s.x - player.position.x, s.z - player.position.z);
      if (d < bestAnchorD) { bestAnchorD = d; best = s; }
    }
    const site = best || RESPAWN_SITES[0];
    let point = { x: site.x, z: site.z, yaw: 0 };
    let bestD = Infinity;
    for (const s of spawnPoints) {
      const d = Math.hypot(s.x - site.x, s.z - site.z);
      if (d < bestD) { bestD = d; point = { x: s.x, z: s.z, yaw: s.yaw || 0 }; }
    }
    return { site, point };
  }

  function endChase(kind) {
    if (overlay) return;
    overlay = kind;
    overlayT = 0;
    const { site } = siteFor(kind === 'wasted' ? 'hospital' : 'station');
    if (hud && hud.banner) hud.banner(kind === 'wasted' ? 'WASTED' : 'BUSTED', site.name);
    if (audio && audio.siren) audio.siren(false);
    // the pursuit lets go: nobody keeps shooting at a body on the pavement
    for (const o of officerList.slice()) removeOfficer(o);
    for (const rec of cruisers.slice()) { if (!rec.staged) releaseCruiser(rec); }
    player.setActive(false);
  }

  function finishRespawn() {
    const kind = overlay;
    const { site, point } = siteFor(kind === 'wasted' ? 'hospital' : 'station');
    if (player.car) player.exitCar();
    player.teleport(point.x, point.z, point.yaw);
    player.health = 100;
    player.armour = 20;
    // a small bill, not a wipe: a floor plus a slice of what he was carrying
    const base = kind === 'wasted' ? POLICE.PENALTY_WASTED : POLICE.PENALTY_BUSTED;
    const cash = game ? (game.money || 0) : 0;
    const penalty = Math.max(base, Math.min(POLICE.PENALTY_CAP, Math.round(cash * POLICE.PENALTY_SHARE)));
    if (game) game.money = Math.max(0, cash - penalty);
    if (hud) {
      if (hud.clearBanner) hud.clearBanner();
      hud.toast(`${site.name}: patched up, $${penalty} less`);
    }
    heat = 0;
    stars = 0;
    sightTimer = 0;
    contactTimer = 0;
    starTimer = 0;
    overlay = null;
    player.setActive(true);
  }

  // ---- frame ---------------------------------------------------------------------------------------
  function setBar(rec, redOn, blueOn) {
    if (!rec.dress) return;
    const [blue, red] = rec.dress.bar;
    if (blue) blue.mat.color.setHex(SIREN_BLUE).multiplyScalar(0.25 + blueOn * 0.75);
    if (red) red.mat.color.setHex(SIREN_RED).multiplyScalar(0.25 + redOn * 0.75);
    rec.dress.halos[0].material.opacity = 0.94 * redOn;
    rec.dress.halos[1].material.opacity = 0.94 * blueOn;
  }

  function stepSiren(dt, still = false) {
    sirenPhase += dt * (2.2 + stars * 0.42);
    // a two-tone alternation: red hard on, blue hard off, then the other way, like a real bar
    const phase = sirenPhase % 1;
    let redOn = phase < 0.5 ? 1 : 0.10;
    let blueOn = phase < 0.5 ? 0.10 : 1;
    // a photographed still shows both discs lit, so the frame reads as a siren at a glance
    if (still) { redOn = 1; blueOn = 0.78; }
    let nearest = null;
    let bestD = Infinity;
    for (const rec of cruisers) {
      setBar(rec, redOn, blueOn);
      const d = Math.hypot(rec.car.state.pos.x - player.position.x, rec.car.state.pos.z - player.position.z);
      if (d < bestD) { bestD = d; nearest = rec; }
    }
    if (nearest && stars > 0) {
      sirenLight.position.set(nearest.car.state.pos.x, 1.95, nearest.car.state.pos.z);
      sirenLight.color.setHex(phase < 0.5 ? SIREN_RED : SIREN_BLUE);
      sirenLight.intensity = 7;
    } else {
      sirenLight.intensity = 0;
    }
  }

  function update(dt) {
    if (!dt || dt <= 0) return;
    clock += dt;

    if (overlay) {
      overlayT += dt;
      if (overlayT >= POLICE.OVERLAY) finishRespawn();
      officers.write([]);
      stepSiren(dt);
      return;
    }

    if (player.health <= 0) { endChase('wasted'); return; }

    // taking a civilian car where a uniform can see it is a crime
    const car = player.car;
    if (car && car !== lastCar && !player.onFoot) {
      const seenBy = nearestUnitDistance() < POLICE.SIGHT_CAR
        || officerList.some((o) => Math.hypot(o.x - player.position.x, o.z - player.position.z) < POLICE.SIGHT_FOOT);
      if (seenBy && car.key !== 'patrulla') addHeat(POLICE.HEAT_STEAL);
      else if (car.key === 'patrulla') addHeat(POLICE.HEAT_STEAL * 1.5);   // stealing a cruiser
    }
    lastCar = car;

    // who can see him this step decides whether the pair pursues or hunts a cold trail
    contact = stars > 0 && sighted();
    if (contact) { lastKnown.x = player.position.x; lastKnown.z = player.position.z; }

    spawnTimer -= dt;
    if (stars > 0 && cruisers.length < cruiserQuota() && spawnTimer <= 0) {
      const rec = spawnCruiser();
      spawnTimer = rec ? POLICE.SPAWN_COOLDOWN : 0.8;
    }
    // mark one of the pair as the wing car that cuts across
    let wingTaken = false;
    for (const rec of cruisers) {
      if (rec.staged) continue;
      if (!wingTaken && rec.wing === 0 && cruisers.length > 1) { rec.wing = 1; wingTaken = true; }
      else if (rec.wing === 0) rec.wing = -1;
    }

    for (const rec of cruisers.slice()) {
      if (rec.staged) continue;
      if (rec.car.driver === 'player') {          // Rafa took the cruiser: the pursuit drops that car
        releaseCruiser(rec);
        continue;
      }
      if (rec.blocked) {
        stepCar(rec.car, dt, { throttle: 0, brake: 1, steer: 0, handbrake: 0 }, driveCtx);
        continue;
      }
      stepCruiser(rec, dt);
      const d = Math.hypot(rec.car.state.pos.x - player.position.x, rec.car.state.pos.z - player.position.z);
      if (d > POLICE.DESPAWN) releaseCruiser(rec);
    }

    // cruiser against the player's car and against the traffic it shoves through
    const playerCar = player.car;
    const trafficCars = (traffic && traffic.cars) || [];
    for (const rec of cruisers.slice()) {
      if (rec.staged || rec.car.driver === 'player') continue;
      if (playerCar && !player.onFoot) {
        const d = Math.hypot(rec.car.state.pos.x - playerCar.state.pos.x, rec.car.state.pos.z - playerCar.state.pos.z);
        if (d < 9 && d > 0.01) {
          const closing = resolvePair(rec.car, playerCar);
          if (closing > 4) addHeat(POLICE.HEAT_RAM * 0.5);
        }
      }
      for (let i = 0; i < trafficCars.length; i += 1) {
        const other = trafficCars[i];
        if (!other || other.destroyed) continue;
        const dx = rec.car.state.pos.x - other.state.pos.x;
        const dz = rec.car.state.pos.z - other.state.pos.z;
        if (dx * dx + dz * dz > 36) continue;
        resolvePair(rec.car, other);
        other.syncTransform();
      }
      rec.car.syncTransform();
    }

    for (const o of officerList) stepOfficer(o, dt);
    officers.write(officerList);

    // busted: stopped in the middle of a ring of officers
    const near = officerList.reduce((n, o) => (o.alive
      && Math.hypot(o.x - player.position.x, o.z - player.position.z) < POLICE.BUSTED_RADIUS ? n + 1 : n), 0);
    const speed = player.onFoot ? player.speed : Math.abs((player.car && player.car.state.speed) || 0);
    if (stars >= 1 && near >= POLICE.BUSTED_MIN && speed < POLICE.BUSTED_SPEED && player.onFoot) {
      bustT += dt;
      if (bustT >= POLICE.BUSTED_HOLD) { bustT = 0; endChase('busted'); return; }
    } else {
      bustT = Math.max(0, bustT - dt * 2);
    }

    stepWanted(dt);
    stepSiren(dt);
    fx.update(dt);

    // a cleared level takes its units off the street: no pursuit survives a lost trail
    if (stars === 0) {
      for (const o of officerList.slice()) removeOfficer(o);
      for (const rec of cruisers.slice()) if (!rec.staged) releaseCruiser(rec);
      officers.write(officerList);
    }
  }

  function cruiserQuota() {
    if (stars >= 4) return 3;
    if (stars === 3) return 2;
    if (stars >= 1) return 1;
    return 0;
  }

  // ---- public surface ------------------------------------------------------------------------------
  const api = {
    root,
    get stars() { return stars; },
    get heat() { return heat; },
    get overlay() { return overlay; },
    get officers() { return officerList; },
    get cruisers() { return cruisers.map((r) => r.car); },
    get inChase() { return stars > 0; },

    update,
    addHeat,

    // A crime reported by another system: a shot fired, a body on the pavement.
    crime(kind) {
      if (kind === 'shot') return addHeat(POLICE.HEAT_SHOT);
      if (kind === 'ped') return addHeat(POLICE.HEAT_PED_KILL);
      if (kind === 'officer') return addHeat(POLICE.HEAT_OFFICER_KILL);
      if (kind === 'cruiser') return addHeat(POLICE.HEAT_CRUISER_HIT);
      return addHeat(POLICE.HEAT_SHOT);
    },

    // Combat's hit report. Returns true when the officer went down.
    damageOfficer(officer, amount) {
      if (!officer || !officer.alive) return false;
      officer.health -= amount;
      officer.cover = findCover(officer);
      officer.coverT = 3.0;
      if (officer.health <= 0) {
        officer.alive = false;
        removeOfficer(officer);
        addHeat(POLICE.HEAT_OFFICER_KILL);
        return true;
      }
      return false;
    },

    // Combat hit a cruiser's body: it takes chassis damage and the level goes up.
    hitCruiser(car, amount) {
      if (!car || car.destroyed) return;
      car.damage(amount);
      addHeat(POLICE.HEAT_CRUISER_HIT);
    },

    clear() {
      heat = 0;
      stars = 0;
      sightTimer = 0;
      contactTimer = 0;
      starTimer = 0;
      bustT = 0;
      for (const o of officerList.slice()) removeOfficer(o);
      for (const rec of cruisers.slice()) if (!rec.staged) releaseCruiser(rec);
      officers.write([]);
      if (audio && audio.siren) audio.siren(false);
    },

    // HUD: one dot per live unit.
    dots() {
      const out = [];
      for (const rec of cruisers) out.push({ x: rec.car.state.pos.x, z: rec.car.state.pos.z });
      for (const o of officerList) out.push({ x: o.x, z: o.z });
      return out;
    },

    // Shot staging: park a cruiser at a pose and hold it. The scene owns the geometry, the system
    // owns the light bar, the siren discs and the heat it implies.
    stageCruiser({ x, z, yaw, speed = 0, stars: wanted }) {
      const rec = makeCruiser(x, z, yaw, speed);
      rec.staged = true;
      if (wanted !== undefined) {
        stars = clamp(Math.round(wanted), 0, 5);
        heat = stars * POLICE.STAR_STEP;
        if (hud && hud.setStars) hud.setStars(stars);
      }
      // a still frame shows both colours lit; the two-tone pulse is for the played chase
      stepSiren(0, true);
      return rec.car;
    },

    setStars(n) {
      stars = clamp(Math.round(n), 0, 5);
      heat = stars * POLICE.STAR_STEP;
      return stars;
    },

    stats() {
      return { stars, heat, cruisers: cruisers.length, officers: officerList.length };
    },

    dispose() {
      for (const o of officerList.slice()) removeOfficer(o);
      for (const rec of cruisers.slice()) releaseCruiser(rec);
      officers.dispose();
      if (scene) scene.remove(root);
    },
  };

  officers.write([]);
  return api;
}
