// Costa Lume — traffic and street life.
//
// Two populations, both seeded and deterministic, both cheap to draw:
//
//   Cars. About twenty AI drivers on the city's lane graph. The graph is not a new description of
//   the city: it is read off city.roadGraph.intersections (the junctions) and the streets that
//   join them, so a change to the grid in city.js moves the traffic with it. Each car aims at a
//   corner waypoint computed from its lane (right-hand traffic: the lane sits right of travel),
//   steers with the shared arcade physics in entities/vehicles.js, and picks a new direction at
//   every junction. Distance keeping is a braking curve against the nearest body ahead, walkers
//   get out of the way of nothing and cars stop for the player standing in the road; junctions
//   are reserved, so a queue forms at the stop line instead of two streams passing through each
//   other. A car that falls far behind the camera is lifted to a lane ahead of it, which is what
//   keeps the street busy without simulating a whole city.
//
//   Pedestrians. About fifty walkers on the sidewalk rings and the boardwalk, each looping the
//   perimeter of a block so corners come for free, with a stride driven by distance walked, idle
//   clusters that stand together for a few seconds, and a flee state that runs away from a threat
//   point (a car passing close, or fleeFrom() when stage 3 fires a gun).
//
// Draw calls: pedestrians are seven InstancedMeshes (torso, two legs, two arms, head, hair) with
// per-instance colour, so fifty figures cost seven draws. Cars come from vehicles.js, which shares
// every geometry and material across brands and paints.
import * as THREE from 'three';
import { createCar, stepCar, resolvePair, BRANDS, PAINT_HEX } from '../entities/vehicles.js';

const SIDEWALK_Y = 0.16;         // city.js pad height: peds stand on it, cars stay at 0
const LANE_NEAR = 3.0;           // inner lane, beside the centre line
const LANE_FAR = 9.0;            // outer lane, beside the kerb
const STOP_MARGIN = 6.5;         // how far short of a junction a yielding car waits
const CRUISE_MIN = 8.5;
const CRUISE_MAX = 13.5;
const SAFE_GAP = 4.6;            // bumper-to-bumper distance a car holds at rest
const DESPAWN_BEHIND = 165;
const SPAWN_AHEAD = 135;

// ---------------------------------------------------------------------------------------------
// Lane graph, read off the road grid
// ---------------------------------------------------------------------------------------------
function buildGraph(city) {
  const graph = (city && city.roadGraph) || {};
  const nodes = [];
  const byKey = new Map();
  const add = (x, z) => {
    const key = `${x.toFixed(1)}|${z.toFixed(1)}`;
    let n = byKey.get(key);
    if (!n) {
      n = { x, z, key, next: [] };
      byKey.set(key, n);
      nodes.push(n);
    }
    return n;
  };
  for (const ix of graph.intersections || []) add(ix.x, ix.z);

  // neighbours: consecutive junctions along each row (constant z) and column (constant x)
  const rows = new Map();
  const cols = new Map();
  for (const n of nodes) {
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
  return { nodes, edges: [] };
}

// Right-hand side of a travel direction on the ground plane.
function rightOf(dx, dz) {
  return { x: dz, z: -dx };
}

function unit(ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l, len: l };
}

// The corner point a car aims at when it reaches node b coming from a and leaving toward c:
// the turn apex sits one junction-radius along the new direction, offset into the new lane.
function cornerPoint(a, b, c, laneOff) {
  const inDir = unit(a.x, a.z, b.x, b.z);
  const outDir = unit(b.x, b.z, c.x, c.z);
  const straight = inDir.x * outDir.x + inDir.z * outDir.z > 0.9;
  const r = rightOf(outDir.x, outDir.z);
  const ahead = straight ? 0 : 7.5;
  return {
    x: b.x + outDir.x * ahead + r.x * laneOff,
    z: b.z + outDir.z * ahead + r.z * laneOff,
  };
}

// ---------------------------------------------------------------------------------------------
// Pedestrian parts: one instanced mesh per joint. Each limb hangs from its own joint (the geometry
// is translated down by half its length), so rotation.x swings a leg from the hip and an arm from
// the shoulder, and every figure's feet land on the pad instead of floating at hip height.
// ---------------------------------------------------------------------------------------------
function pedGeometry() {
  return {
    torso: new THREE.BoxGeometry(0.42, 0.56, 0.25),
    leg: new THREE.BoxGeometry(0.15, 0.90, 0.18).translate(0, -0.45, 0),
    arm: new THREE.BoxGeometry(0.11, 0.52, 0.13).translate(0, -0.26, 0),
    head: new THREE.BoxGeometry(0.21, 0.22, 0.22),
    hair: new THREE.BoxGeometry(0.215, 0.07, 0.225),
  };
}

export function startTraffic(city, scene, rng, options = {}) {
  const graph = buildGraph(city);
  const colliders = (city && city.colliders) || [];
  const bounds = (city && city.bounds) || { minX: -420, maxX: 420, minZ: -520, maxZ: 420 };
  const cars = [];
  const pedestrians = [];
  const intersections = (city && city.roadGraph && city.roadGraph.intersections) || [];
  const blocks = (city && city.roadGraph && city.roadGraph.sidewalks) || [];
  const streets = (city && city.roadGraph && city.roadGraph.streets) || [];
  const reserved = new Map();       // node -> car that has claimed the junction box

  const carCount = options.cars === undefined ? 20 : options.cars;
  const pedCount = options.pedestrians === undefined ? 50 : options.pedestrians;

  const ctx = {
    colliders,
    bounds,
    cars,
    onImpact: null,
  };

  // ---- one AI driver -------------------------------------------------------------------------
  function makeDriver(car) {
    return {
      car,
      cruise: CRUISE_MIN + rng() * (CRUISE_MAX - CRUISE_MIN),
      lane: rng() < 0.55 ? LANE_NEAR : LANE_FAR,
      // nav: the two nodes the car is between, and the one after
      a: null, b: null, c: null,
      wp: { x: 0, z: 0 },
      stuck: 0,
      wander: rng() * Math.PI * 2,
      base: 0,
    };
  }

  function pickNext(a, b) {
    const options = b.next.filter((n) => n !== a);
    if (!options.length) return a;
    if (!a) return options[(rng() * options.length) | 0];
    // prefer going straight, then a right turn, so the traffic reads as a city and not a pinball
    const inDir = unit(a.x, a.z, b.x, b.z);
    const scored = options.map((n) => {
      const out = unit(b.x, b.z, n.x, n.z);
      const dot = inDir.x * out.x + inDir.z * out.z;
      const cross = inDir.x * out.z - inDir.z * out.x;
      let w = dot > 0.9 ? 3.2 : (cross > 0 ? 1.25 : 0.75);      // straight, then right, then left
      w *= 0.7 + rng() * 0.6;
      return { n, w };
    });
    let total = 0;
    for (const s of scored) total += s.w;
    let r = rng() * total;
    for (const s of scored) {
      r -= s.w;
      if (r <= 0) return s.n;
    }
    return scored[scored.length - 1].n;
  }

  // Place a driver on a random junction edge, heading somewhere.
  function seedNav(d, nodeA, nodeB) {
    d.a = nodeA || null;
    d.b = nodeB || null;
    d.c = nodeB ? pickNext(nodeA, nodeB) : null;
    aimNav(d);
  }

  function advanceNav(d) {
    d.a = d.b;
    d.b = d.c;
    d.c = d.b ? pickNext(d.a, d.b) : null;
    aimNav(d);
  }

  // Point the driver at the corner of the junction it is approaching, and remember how long that
  // segment is so the aim can never be judged "lost" just because a block is 72 m deep.
  function aimNav(d) {
    if (!d.b || !d.c) return;
    const p = cornerPoint(d.a, d.b, d.c, d.lane);
    d.wp.x = p.x;
    d.wp.z = p.z;
    d.segLen = d.a ? Math.hypot(d.b.x - d.a.x, d.b.z - d.a.z) : 72;
  }

  const BRAND_POOL = ['viento', 'viento', 'viento', 'lagarto', 'abeja', 'abeja', 'tiburon', 'faro', 'marea'];

  function spawnDriverCar(nearX, nearZ) {
    const brand = BRAND_POOL[(rng() * BRAND_POOL.length) | 0];
    const hex = PAINT_HEX[(rng() * PAINT_HEX.length) | 0];
    const car = createCar(brand, hex, { x: nearX, z: nearZ, yaw: 0, driver: 'ai' });
    car.ai = makeDriver(car);
    placeOnRandomLane(car, car.ai, nearX, nearZ);
    car.group.visible = true;
    scene.add(car.group);
    cars.push(car);
    return car;
  }

  // Tuck a car onto a lane near (x, z): pick the nearest junction, take an edge, aim at its corner.
  function placeOnRandomLane(car, d, x, z) {
    let bestA = null;
    let bestB = null;
    let bestD = Infinity;
    for (const n of graph.nodes) {
      if (Math.abs(n.x - x) > 260 || Math.abs(n.z - z) > 260) continue;
      for (const m of n.next) {
        const mx = (n.x + m.x) / 2;
        const mz = (n.z + m.z) / 2;
        const dist = Math.hypot(mx - x, mz - z);
        if (dist < bestD) { bestD = dist; bestA = n; bestB = m; }
      }
    }
    if (!bestA) return;
    seedNav(d, bestA, bestB);
    const aim = d.wp;
    const from = { x: bestA.x, z: bestA.z };
    const dir = unit(from.x, from.z, bestB.x, bestB.z);
    const r = rightOf(dir.x, dir.z);
    // sit partway along the edge and in the lane, facing the corner
    const t = 0.25 + rng() * 0.4;
    const px = from.x + dir.x * dir.len * t + r.x * d.lane;
    const pz = from.z + dir.z * dir.len * t + r.z * d.lane;
    car.setPose(px, pz, Math.atan2(-dir.x, -dir.z));
    car.state.speed = d.cruise * 0.6;
    car.state.vel.set(-Math.sin(car.state.yaw) * d.cruise * 0.6, 0, -Math.cos(car.state.yaw) * d.cruise * 0.6);
    car.syncTransform();
    void aim;
  }

  // ---- spawn the fleet ------------------------------------------------------------------------
  for (let i = 0; i < carCount; i += 1) {
    // spread the fleet around the two boulevards, where the shots look
    const street = streets[(rng() * streets.length) | 0];
    const along = street ? street.from + (street.to - street.from) * rng() : 0;
    const x = street ? (street.axis === 'z' ? street.centre : along) : (rng() - 0.5) * 600;
    const z = street ? (street.axis === 'z' ? along : street.centre) : (rng() - 0.5) * 600;
    spawnDriverCar(x, z);
  }

  // ---- pedestrians ---------------------------------------------------------------------------
  const PALETTE = {
    shirt: [0xe2603f, 0x3f8f8a, 0xe8c96a, 0xd9dbe0, 0x7a5fa8, 0x4f7d3a, 0xf0f0e2, 0x2f6ea8, 0xc4553a, 0x6c8fa8],
    trousers: [0x2f3742, 0x4a4038, 0x2b3a4a, 0x6b6357, 0x8a8578],
    skin: [0xa8744e, 0x8a5a38, 0xc79367, 0x6d4128, 0xd8a878],
    hair: [0x231d19, 0x12100f, 0x4a3324, 0xa89a86, 0x6b3f2a],
  };
  const pick = (list) => list[(rng() * list.length) | 0];

  // perimeter walk of one block, so the walker turns every corner without a path solver
  function blockPath(blk) {
    const pts = blk.points || [];
    if (pts.length < 4) return null;
    const inset = 0.9;
    const cx = (pts[0][0] + pts[2][0]) / 2;
    const cz = (pts[0][1] + pts[2][1]) / 2;
    const out = pts.map(([x, z]) => {
      const dx = x - cx;
      const dz = z - cz;
      const l = Math.hypot(dx, dz) || 1;
      return { x: x - (dx / l) * inset, z: z - (dz / l) * inset };
    });
    out.push({ ...out[0] });
    return out;
  }

  function pathLength(path) {
    let t = 0;
    for (let i = 0; i + 1 < path.length; i += 1) t += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
    return t;
  }

  function makeWalker(opts) {
    const path = opts.path;
    if (!path || path.length < 2) return null;
    const total = pathLength(path);
    const ped = {
      x: 0, z: 0, yaw: 0,
      path,
      total,
      s: opts.s === undefined ? rng() * total : opts.s,
      dir: opts.dir === undefined ? (rng() < 0.5 ? 1 : -1) : opts.dir,
      speed: 0.95 + rng() * 0.55,
      phase: rng() * Math.PI * 2,
      idle: opts.idle === undefined ? 0 : opts.idle,
      idleFor: 0,
      flee: 0,
      fleeDir: { x: 0, z: 0 },
      shirt: opts.shirt === undefined ? pick(PALETTE.shirt) : opts.shirt,
      trousers: opts.trousers === undefined ? pick(PALETTE.trousers) : opts.trousers,
      skin: opts.skin === undefined ? pick(PALETTE.skin) : opts.skin,
      hair: opts.hair === undefined ? pick(PALETTE.hair) : opts.hair,
      y: opts.y === undefined ? SIDEWALK_Y : opts.y,
      scale: opts.scale === undefined ? 0.94 + rng() * 0.12 : opts.scale,
    };
    samplePath(ped, 0);
    pedestrians.push(ped);
    return ped;
  }

  // position + heading at distance s around the loop
  function samplePath(ped, ds) {
    const path = ped.path;
    let s = ped.s;
    for (let guard = 0; guard < 8; guard += 1) {
      if (s >= 0) break;
      s += ped.total;
    }
    s %= ped.total;
    let acc = 0;
    for (let i = 0; i + 1 < path.length; i += 1) {
      const a = path[i];
      const b = path[i + 1];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      if (s <= acc + seg || i === path.length - 2) {
        const t = seg > 1e-4 ? Math.min(1, Math.max(0, (s - acc) / seg)) : 0;
        ped.x = a.x + (b.x - a.x) * t;
        ped.z = a.z + (b.z - a.z) * t;
        ped.yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
        return;
      }
      acc += seg;
    }
    void ds;
  }

  // Spawn the crowd where the shots look: blocks within ~120 m of either boulevard first, so the
  // sidewalks the camera actually sees carry the walkers, then the rest of the city fills in.
  const hot = [];
  for (const blk of blocks) {
    blk.__x = (blk.points[0][0] + blk.points[2][0]) / 2;
    blk.__z = (blk.points[0][1] + blk.points[2][1]) / 2;
    if (Math.abs(blk.__x + 36) < 120 || Math.abs(blk.__z + 108) < 120) hot.push(blk);
  }
  for (let i = 0; i < pedCount; i += 1) {
    const pool = hot.length && rng() < 0.62 ? hot : blocks;
    const blk = pool[(rng() * pool.length) | 0];
    if (!blk) break;
    const path = blockPath(blk);
    if (!path) continue;
    // one walker in six starts idle, so small groups form where they spawned
    const idle = rng() < 0.18 ? 2 + rng() * 6 : 0;
    makeWalker({ path, idle });
  }

  // boardwalk promenade: a long loop along the deck, so the beach reads as busy from the boulevard
  const boardZ = -305.5;
  for (let i = 0; i < 9; i += 1) {
    const x0 = -230 + rng() * 300;
    const len = 40 + rng() * 70;
    makeWalker({
      path: [
        { x: x0, z: boardZ }, { x: x0 + len, z: boardZ },
        { x: x0 + len, z: boardZ - 3.2 }, { x: x0, z: boardZ - 3.2 },
        { x: x0, z: boardZ },
      ],
      idle: rng() < 0.3 ? 2 + rng() * 5 : 0,
    });
  }

  // ---- pedestrian instancing -------------------------------------------------------------------
  const pgeo = pedGeometry();
  const pmat = {
    cloth: new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0.02 }),
    skin: new THREE.MeshStandardMaterial({ roughness: 0.72, metalness: 0.02 }),
    hair: new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0.0 }),
  };
  const peds = {
    capacity: 0,
    meshes: null,
    dummy: new THREE.Object3D(),
  };

  function buildPedMeshes(capacity) {
    if (peds.meshes) {
      for (const m of peds.meshes) {
        scene.remove(m);
        m.dispose();
      }
    }
    const mk = (geo, mat, name) => {
      const m = new THREE.InstancedMesh(geo, mat, capacity);
      m.name = `ped-${name}`;
      m.castShadow = true;
      m.receiveShadow = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    peds.meshes = {
      torso: mk(pgeo.torso, pmat.cloth, 'torso'),
      legL: mk(pgeo.leg, pmat.cloth, 'leg-l'),
      legR: mk(pgeo.leg, pmat.cloth, 'leg-r'),
      armL: mk(pgeo.arm, pmat.skin, 'arm-l'),
      armR: mk(pgeo.arm, pmat.skin, 'arm-r'),
      head: mk(pgeo.head, pmat.skin, 'head'),
      hair: mk(pgeo.hair, pmat.hair, 'hair'),
    };
    for (const m of Object.values(peds.meshes)) {
      m.userData.colour = new THREE.Color();
    }
    peds.capacity = capacity;
  }

  const _m = new THREE.Matrix4();
  const _t = new THREE.Matrix4();
  const _r = new THREE.Matrix4();

  function writeInstances() {
    const need = pedestrians.length;
    if (!peds.meshes || need > peds.capacity) buildPedMeshes(Math.max(8, Math.ceil(need * 1.25) + 8));
    const M = peds.meshes;
    const d = peds.dummy;
    const col = new THREE.Color();
    for (let i = 0; i < peds.capacity; i += 1) {
      const p = pedestrians[i];
      if (!p) {
        d.position.set(0, -50, 0);
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(0.001);
        d.updateMatrix();
        for (const m of Object.values(M)) m.setMatrixAt(i, d.matrix);
        continue;
      }
      // stride: one full cycle per 1.5 m walked, so the cadence follows the walk speed
      const gait = p.flee > 0 ? 1.15 : 0.62;
      const swing = Math.sin(p.phase) * gait;
      const bob = Math.abs(Math.cos(p.phase)) * 0.02 * (p.flee > 0 ? 1.6 : 1);

      const place = (mesh, ox, oy, oz, rx, sx = 1) => {
        d.position.set(p.x, p.y + bob, p.z);
        d.rotation.set(0, p.yaw + Math.PI, 0);
        d.scale.setScalar(p.scale);
        d.updateMatrix();
        _t.copy(d.matrix);
        // local offset then joint rotation about x
        _m.makeTranslation(ox, oy, oz);
        _r.makeRotationX(rx);
        _t.multiply(_m);
        _t.multiply(_r);
        mesh.setMatrixAt(i, _t);
        void sx;
      };

      // Joint heights for a 1.76 m figure: hip 0.90, shoulder 1.44, head 1.59. With the limbs
      // hanging from their pivots the soles sit on p.y, which is the sidewalk pad.
      place(M.torso, 0, 1.18, 0, 0);
      place(M.legL, -0.10, 0.90, 0, swing);
      place(M.legR, 0.10, 0.90, 0, -swing);
      place(M.armL, -0.28, 1.44, 0, -swing * 0.8);
      place(M.armR, 0.28, 1.44, 0, swing * 0.8);
      place(M.head, 0, 1.59, 0, 0);
      place(M.hair, 0, 1.725, 0, 0);

      M.torso.setColorAt(i, col.setHex(p.shirt));
      M.legL.setColorAt(i, col.setHex(p.trousers));
      M.legR.setColorAt(i, col.setHex(p.trousers));
      M.armL.setColorAt(i, col.setHex(p.skin));
      M.armR.setColorAt(i, col.setHex(p.skin));
      M.head.setColorAt(i, col.setHex(p.skin));
      M.hair.setColorAt(i, col.setHex(p.hair));
    }
    for (const m of Object.values(M)) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  // ---- update ----------------------------------------------------------------------------------
  let time = 0;

  // The nearest body in front of a car in its own lane, plus the gap to it.
  function aheadGap(car, eye) {
    const st = car.state;
    const fx = -Math.sin(st.yaw);
    const fz = -Math.cos(st.yaw);
    const rx = fz;
    const rz = -fx;
    let gap = Infinity;
    for (const other of cars) {
      if (other === car) continue;
      const dx = other.state.pos.x - st.pos.x;
      const dz = other.state.pos.z - st.pos.z;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 0.2 || ahead > 26) continue;
      const lateral = Math.abs(dx * rx + dz * rz);
      if (lateral > 2.4) continue;
      const d = ahead - (other.length + car.length) * 0.5;
      if (d < gap) gap = d;
    }
    if (eye) {
      // the player on foot is a body in the road too
      const dx = eye.x - st.pos.x;
      const dz = eye.z - st.pos.z;
      const ahead = dx * fx + dz * fz;
      const lateral = Math.abs(dx * rx + dz * rz);
      if (ahead > 0.2 && ahead < 20 && lateral < 2.2) {
        const d = ahead - car.length * 0.5 - 0.4;
        if (d < gap) gap = d;
      }
    }
    return gap;
  }

  // Is the junction ahead of this car already claimed, or full?
  function junctionBlocked(car, d) {
    if (!d.b) return false;
    const dist = Math.hypot(d.b.x - car.state.pos.x, d.b.z - car.state.pos.z);
    if (dist > 30) return false;
    const holder = reserved.get(d.b);
    if (holder && holder !== car) {
      if (dist < 17) return true;            // somebody is in the box: wait at the line
      reserved.delete(d.b);                  // stale claim, far enough away to forget
    }
    if (dist < STOP_MARGIN + 6) reserved.set(d.b, car);
    return false;
  }

  // A claim dies with its holder's distance: this is what stops a junction being held for ever.
  function releaseClaims() {
    if (!reserved.size) return;
    for (const [node, holder] of reserved) {
      if (holder.destroyed) { reserved.delete(node); continue; }
      const d = Math.hypot(node.x - holder.state.pos.x, node.z - holder.state.pos.z);
      if (d > 17) reserved.delete(node);
    }
  }

  function stepDriver(car, d, dt, eye) {
    const st = car.state;
    // waypoint bookkeeping
    const dx = d.wp.x - st.pos.x;
    const dz = d.wp.z - st.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 4.2) advanceNav(d);

    const aimYaw = Math.atan2(-dx, -dz);
    let dyaw = aimYaw - st.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const steer = Math.max(-1, Math.min(1, dyaw * 1.9));

    // speed: the cruise, cut by the corner ahead and by whatever is in front
    const corner = Math.abs(dyaw) > 0.25 ? 0.62 : 1;
    let want = d.cruise * corner;
    const gap = aheadGap(car, eye);
    if (gap < 26) {
      const target = Math.max(0, (gap - SAFE_GAP) * 0.95);
      if (target < want) want = target;
    }
    if (junctionBlocked(car, d) && gap > 8) want = 0;

    const err = want - st.speed;
    const throttle = err > 0.4 ? Math.min(1, err * 0.34) : 0;
    const brake = err < -0.6 ? Math.min(1, -err * 0.22) : 0;

    stepCar(car, dt, { throttle, brake, steer, handbrake: 0 }, ctx);

    // a car shoved off its lane gets its waypoint re-aimed rather than driving into a wall
    if (dist > (d.segLen || 72) + 26) advanceNav(d);

    // stuck detection: no progress for long enough and it is lifted back into the flow
    if (Math.abs(st.speed) < 0.35 && gap > 12) d.stuck += dt;
    else d.stuck = 0;
    return d.stuck;
  }

  function relocate(car, d, view) {
    const fx = -Math.sin(view.yaw || 0);
    const fz = -Math.cos(view.yaw || 0);
    const px = view.x + fx * (55 + rng() * 50) + (rng() - 0.5) * 60;
    const pz = view.z + fz * (55 + rng() * 50) + (rng() - 0.5) * 60;
    placeOnRandomLane(car, d, px, pz);
    d.stuck = 0;
  }

  function stepTraffic(dt, view) {
    if (!dt || dt <= 0) return;
    time += dt;
    const eye = view || null;
    releaseClaims();

    // cars
    for (const car of cars) {
      const d = car.ai;
      if (!d) continue;
      if (car.destroyed) {
        // a wreck in a running lane jams the street for ever; after a moment it is cleared away
        d.wreckT = (d.wreckT || 0) + dt;
        stepCar(car, dt, { throttle: 0, brake: 1, steer: 0, handbrake: 0 }, ctx);
        if (d.wreckT > 9 && eye) {
          d.wreckT = 0;
          car.health = 100;
          car.destroyed = false;
          car.driver = 'ai';
          if (car.smoke && car.smoke.mesh) {
            for (const p of car.smoke.puffs) { p.life = 0; p.mesh.visible = false; }
          }
          relocate(car, d, eye);
        }
      } else if (car.driver === 'ai') {
        const stuck = stepDriver(car, d, dt, eye);
        if (stuck > 6 && eye) relocate(car, d, eye);
      } else if (car.driver !== 'player') {
        // parked: held on the brakes. A car the player has taken is stepped by player.js, and
        // stepping it here as well would brake it out from under him.
        stepCar(car, dt, { throttle: 0, brake: 1, steer: 0, handbrake: 0 }, ctx);
      }
    }
    // car against car: one pass, pairs only
    for (let i = 0; i < cars.length; i += 1) {
      const a = cars[i];
      for (let j = i + 1; j < cars.length; j += 1) {
        const b = cars[j];
        const dx = a.state.pos.x - b.state.pos.x;
        const dz = a.state.pos.z - b.state.pos.z;
        if (dx * dx + dz * dz > 64) continue;      // 8 m broad phase
        resolvePair(a, b);
        a.syncTransform();
        b.syncTransform();
      }
    }

    // despawn far behind the camera, respawn ahead: the street stays busy with 20 bodies
    if (eye) {
      for (const car of cars) {
        const d = car.ai;
        if (!d) continue;
        const dx = car.state.pos.x - eye.x;
        const dz = car.state.pos.z - eye.z;
        const dist = Math.hypot(dx, dz);
        if (dist > DESPAWN_BEHIND + SPAWN_AHEAD) {
          relocate(car, d, eye);
          continue;
        }
        const fx = -Math.sin(eye.yaw || 0);
        const fz = -Math.cos(eye.yaw || 0);
        const behind = dx * fx + dz * fz;
        if (dist > 80 && behind < -DESPAWN_BEHIND * 0.55) relocate(car, d, eye);
      }
    }

    // pedestrians
    for (const p of pedestrians) {
      if (p.flee > 0) {
        p.flee -= dt;
        p.x += p.fleeDir.x * 3.6 * dt;
        p.z += p.fleeDir.z * 3.6 * dt;
        p.yaw = Math.atan2(-p.fleeDir.x, -p.fleeDir.z);
        p.phase += 3.6 * dt * 4.4;
        // when the panic ends, walk back to the nearest point on the loop
        if (p.flee <= 0) {
          let best = Infinity;
          for (const q of p.path) {
            const dd = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
            if (dd < best) best = dd;
          }
        }
        continue;
      }
      if (p.idle > 0) {
        p.idle -= dt;
        p.phase += dt * 0.6;
        continue;
      }
      if (p.idleFor > 0) {
        p.idleFor -= dt;
        p.phase += dt * 0.5;
        continue;
      }
      // idle clusters: a walker standing still for a few seconds is a group when others are by
      if (rng() < 0.0016) p.idleFor = 1.6 + rng() * 3.4;
      const move = p.speed * dt * p.dir;
      p.s += move;
      if (p.s < 0) p.s += p.total;
      if (p.s > p.total) p.s -= p.total;
      samplePath(p, move);
      p.phase += Math.abs(move) * 4.2;
    }

    writeInstances();
  }

  // Flee: everything inside the radius runs directly away from the point. Stage 3's gunfire and
  // a car passing close both come through here.
  function fleeFrom(point, radius = 14, hold = 2.6) {
    if (!point) return 0;
    let n = 0;
    for (const p of pedestrians) {
      const dx = p.x - point.x;
      const dz = p.z - point.z;
      const d = Math.hypot(dx, dz);
      if (d > radius || d < 1e-3) continue;
      p.flee = Math.max(p.flee, hold);
      p.fleeDir.x = dx / d;
      p.fleeDir.z = dz / d;
      n += 1;
    }
    return n;
  }

  // A car passing close makes the walkers scatter; called from the car step so it costs nothing
  // while traffic is calm.
  function scareCars() {
    for (const car of cars) {
      const sp = Math.abs(car.state.speed);
      if (sp < 6) continue;
      for (const p of pedestrians) {
        if (p.flee > 0) continue;
        const dx = p.x - car.state.pos.x;
        const dz = p.z - car.state.pos.z;
        if (dx * dx + dz * dz < 22) {
          const d = Math.hypot(dx, dz) || 1;
          p.flee = 1.5;
          p.fleeDir.x = dx / d;
          p.fleeDir.z = dz / d;
        }
      }
    }
  }

  function addWalker(opts) {
    return makeWalker(opts);
  }

  // A walker taken out of the crowd — a bullet, a car, a mission. The record leaves the list and the
  // instance buffers are rewritten, so the figure is gone on the next frame and not a ghost slot.
  function removeWalker(ped) {
    const i = pedestrians.indexOf(ped);
    if (i < 0) return false;
    pedestrians.splice(i, 1);
    writeInstances();
    return true;
  }

  function stats() {
    return {
      cars: cars.length,
      pedestrians: pedestrians.length,
      drawCalls: peds.meshes ? Object.keys(peds.meshes).length : 0,
      time,
    };
  }

  // seed the instanced buffers now, so the first frame already has walkers standing about
  writeInstances();

  // A couple of drivers look at the player: this is what the HUD and stage 3 read.
  return {
    cars,
    pedestrians,
    ctx,
    graph,
    update(dt, view) {
      scareCars();
      stepTraffic(dt, view);
    },
    fleeFrom,
    addWalker,
    removeWalker,
    stats,
    // Flush the pedestrian instance buffers. addWalker() only appends to the crowd; a caller that
    // poses walkers without stepping the simulation (the screenshot scenes) flushes them here.
    refresh() {
      writeInstances();
    },
    get count() { return cars.length; },
    relocate,
    reserveCount: () => reserved.size,
  };
}
