// Costa Lume — the city builder: one seeded pass from the road grid to a walkable, drivable city.
//
// 9 x 9 blocks split by ten 24 m streets, three height bands of buildings, open plazas, a market,
// parks, street furniture, palms and the coast (boardwalk, sand, seawall, pier). Ocean is sky.js's.
// Draw calls are the constraint: every static box is pushed into one builder per material
// (makeBuilder/pushBox/finish) and merged into a single mesh, so more buildings cost vertices, not
// draws; palms, lamp posts and contact shadows are InstancedMesh. The whole city is 28 draw calls.
// Every solid box registers its collider where it is drawn, so art and collision cannot drift apart.
import * as THREE from 'three';
import {
  makeBuilder, pushBox, pushCylinder, finish, QUAD_TRIS,
} from './geometry.js';

// ---------------------------------------------------------------------------------------------
// Grid. cols blocks run west->east (x), rows run south->north (z).
//   street k  -> runs along z at x = streetLine(k)   (ids S0..S8)
//   avenue j  -> runs along x at z = rowLine(j)      (ids Z0..Z8)
// Avenida Sol (S4) and Calle Mercado (Z3) are the two main boulevards.
// z = -300 is the coast: boardwalk, sand, seawall, pier, then sky.js's ocean.
// ---------------------------------------------------------------------------------------------
const CFG = {
  cols: 9,
  rows: 9,
  block: 24,       // half-depth of a block (block slab is 2 * block)
  street: 24,      // carriageway width
  walk: 3.5,       // sidewalk ring width
  pad: 0.16,       // sidewalk height above asphalt
  kerb: 0.14,
  lot: 0.5,        // setback between lot line and building footprint
  mainX: 4,        // Avenida Sol, along z
  mainZ: 3,        // Calle Mercado, along x
  bay: 9,          // boardwalk depth
  sand: 62,        // beach depth
  pier: 66,        // pier length over the water
};

const PITCH = CFG.block * 2 + CFG.street;          // 72 m
const LINE0 = -(CFG.cols * PITCH) / 2;             // -324 m: first street centre
// ten lines close nine blocks: line k sits between block k - 1 and block k
const streetLine = (k) => LINE0 + k * PITCH;
const rowLine = (j) => LINE0 + j * PITCH;
const ROAD_MIN_X = streetLine(0) - CFG.street / 2;   // outer asphalt edge, west
const ROAD_MAX_X = streetLine(CFG.cols) + CFG.street / 2;
const ROAD_MIN_Z = rowLine(0) - CFG.street / 2;      // south (coast side)
const ROAD_MAX_Z = rowLine(CFG.rows) + CFG.street / 2;
const COAST_Z = ROAD_MIN_Z - 1.5;                  // boardwalk landward edge
const BAY_Z = COAST_Z - CFG.bay;
const SAND_Z = BAY_Z - CFG.sand;
const PIER_Z = SAND_Z - CFG.pier;

// district bands, south -> north, cut on the street centres themselves
const DISTRICTS = [
  { name: 'Playa Norte', minX: ROAD_MIN_X, maxX: ROAD_MAX_X, minZ: SAND_Z - 6, maxZ: streetLine(2) - CFG.street / 2 },
  { name: 'Mercado Viejo', minX: ROAD_MIN_X, maxX: ROAD_MAX_X, minZ: streetLine(2) - CFG.street / 2, maxZ: streetLine(4) - CFG.street / 2 },
  { name: 'Puerto Alto', minX: ROAD_MIN_X, maxX: ROAD_MAX_X, minZ: streetLine(4) - CFG.street / 2, maxZ: streetLine(7) - CFG.street / 2 },
  { name: 'Colinas Altas', minX: ROAD_MIN_X, maxX: ROAD_MAX_X, minZ: streetLine(7) - CFG.street / 2, maxZ: ROAD_MAX_Z },
];

const Y_PAD = CFG.pad;          // top of a sidewalk pad
const Y_BUILD = Y_PAD + 0.02;   // building base

export function buildCity(scene, rng, textures) {
  const b = () => makeBuilder();
  const ctx = {
    scene, rng, tex: textures,
    colliders: [], spawnPoints: [], streets: [], intersections: [], sidewalks: [],
    palms: [], lamps: [], neon: [], ao: [], blocks: [],
    g: {
      road: b(), roadMain: b(), lane: b(), cross: b(), walk: b(), plaza: b(), stone: b(), sand: b(),
      board: b(), foliage: b(), kerb: b(), tower: b(), roof: b(), tank: b(), balcony: b(), metal: b(),
      awning: b(), bench: b(), planter: b(), neon: b(), facade: [b(), b(), b(), b()],
    },
  };

  buildStreets(ctx);
  buildBlocks(ctx);
  buildStreetFurniture(ctx);
  buildBeach(ctx);
  buildSpawns(ctx);
  buildNeon(ctx);

  const mats = createMaterials(textures);
  const merge = (builder, material, name, opts = {}) => {
    if (!builder.pos.length) return null;
    const mesh = new THREE.Mesh(finish(builder), material);
    mesh.castShadow = opts.castShadow !== false;
    mesh.receiveShadow = opts.receiveShadow !== false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = name;
    scene.add(mesh);
    return mesh;
  };

  // one merged mesh per material: the whole city is these 24 meshes plus four instanced props
  const g = ctx.g;
  const flat = { castShadow: false };
  const parts = [
    ['road', 'city-road', flat], ['roadMain', 'city-road-main', flat], ['lane', 'city-lane-paint', flat],
    ['cross', 'city-crosswalk-paint', flat], ['walk', 'city-sidewalks', flat], ['kerb', 'city-kerbs', flat],
    ['plaza', 'city-plaza', flat], ['sand', 'city-beach', flat], ['board', 'city-boardwalk', flat],
    ['stone', 'city-seawall'], ['foliage', 'city-hedges'], ['tower', 'city-towers'], ['roof', 'city-roofs'],
    ['tank', 'city-water-tanks'], ['balcony', 'city-balconies'], ['metal', 'city-metalwork'],
    ['awning', 'city-awnings'], ['bench', 'city-benches'], ['planter', 'city-planters'],
    ['neon', 'city-neon-signs', flat],
  ];
  for (const [key, name, opts] of parts) merge(g[key], mats[key], name, opts);
  g.facade.forEach((builder, i) => merge(builder, mats.facade[i], `city-facades-${i}`));

  buildLamps(ctx, mats.metal);
  buildPalms(ctx, textures);
  buildContactShadows(ctx, textures);

  return {
    colliders: ctx.colliders,
    spawnPoints: ctx.spawnPoints,
    districts: DISTRICTS,
    roadGraph: { streets: ctx.streets, intersections: ctx.intersections, sidewalks: ctx.sidewalks },
    bounds: {
      minX: ROAD_MIN_X - 26, maxX: ROAD_MAX_X + 26,
      minZ: PIER_Z - CFG.pier * 0.5, maxZ: ROAD_MAX_Z + CFG.street,
    },
  };
}

// ---- Materials: one per merged builder; cloned repeats share the same canvas image ----
function tiled(map, sx, sy) {
  const t = map.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(sx, sy);
  t.needsUpdate = true;
  return t;
}

function createMaterials(tex) {
  const c = tex.colors;
  return {
    road: new THREE.MeshStandardMaterial({ map: tiled(tex.asphalt, 30, 30), roughness: 0.74, metalness: 0.05 }),
    roadMain: new THREE.MeshStandardMaterial({ map: tiled(tex.asphalt, 8, 30), roughness: 0.60, metalness: 0.10 }),
    lane: new THREE.MeshStandardMaterial({
      map: tiled(tex.lane, 1, 1), transparent: true, depthWrite: false, roughness: 0.82,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    cross: new THREE.MeshStandardMaterial({
      map: tex.crosswalk, transparent: true, depthWrite: false, roughness: 0.82,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }),
    walk: new THREE.MeshStandardMaterial({ map: tiled(tex.sidewalk, 12, 12), roughness: 0.92 }),
    kerb: new THREE.MeshStandardMaterial({ color: 0x9e9788, roughness: 0.9 }),
    plaza: new THREE.MeshStandardMaterial({ map: tiled(tex.sidewalk, 8, 8), color: 0xd8c9b0, roughness: 0.88 }),
    sand: new THREE.MeshStandardMaterial({ map: tiled(tex.sand, 9, 3), roughness: 0.96 }),
    board: new THREE.MeshStandardMaterial({ map: tiled(tex.boardwalk, 3, 1), roughness: 0.88 }),
    stone: new THREE.MeshStandardMaterial({ map: tiled(tex.roof, 3, 3), color: 0xb6ae9c, roughness: 0.95 }),
    foliage: new THREE.MeshStandardMaterial({ color: 0x5c7d3d, roughness: 0.95 }),
    facade: tex.facades.map((map) => new THREE.MeshStandardMaterial({ map, roughness: 0.86 })),
    tower: new THREE.MeshStandardMaterial({ map: tex.tower, roughness: 0.40, metalness: 0.24 }),
    roof: new THREE.MeshStandardMaterial({ map: tiled(tex.roof, 5, 5), roughness: 0.95 }),
    tank: new THREE.MeshStandardMaterial({ color: c.tank, roughness: 0.68, metalness: 0.26 }),
    balcony: new THREE.MeshStandardMaterial({ color: c.balcony, roughness: 0.82 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x474c50, roughness: 0.52, metalness: 0.55 }),
    awning: new THREE.MeshStandardMaterial({ color: 0xd0563c, roughness: 0.78, side: THREE.DoubleSide }),
    bench: new THREE.MeshStandardMaterial({ color: c.bench, roughness: 0.86 }),
    planter: new THREE.MeshStandardMaterial({ color: c.planter, roughness: 0.92 }),
    neon: new THREE.MeshBasicMaterial({
      map: tex.neon, transparent: true, alphaTest: 0.22, side: THREE.DoubleSide, toneMapped: true,
    }),
  };
}

// ---- Colliders and small geometry helpers ----
function pushCollider(ctx, minX, maxX, minZ, maxZ, height) {
  if (maxX <= minX || maxZ <= minZ) return;
  ctx.colliders.push({ minX, maxX, minZ, maxZ, height });
}

// vertical wall quad A->B in plan, y0..y1, outward normal on the left of A->B; UVs in metres/12 so
// the facade tile keeps its 4-floor rhythm whatever the wall length is.
function pushWall(b, ax, az, bx, bz, y0, y1, tile = 12) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 0.001;
  const nx = -dz / len;
  const nz = dx / len;
  const u = len / tile;
  const v = (y1 - y0) / tile;
  const verts = [
    [ax, y0, az, 0, 0], [bx, y0, bz, u, 0], [bx, y1, bz, u, v], [ax, y1, az, 0, v],
  ];
  for (const k of QUAD_TRIS) {
    const [x, y, z, uu, vv] = verts[k];
    b.pos.push(x, y, z);
    b.nor.push(nx, 0, nz);
    b.uv.push(uu, vv);
  }
}

// four outward walls of an axis-aligned footprint (+z, +x, -z, -x in that order)
function pushWalls(b, minX, maxX, minZ, maxZ, y0, y1, tile = 12) {
  pushWall(b, minX, maxZ, maxX, maxZ, y0, y1, tile);
  pushWall(b, maxX, maxZ, maxX, minZ, y0, y1, tile);
  pushWall(b, maxX, minZ, minX, minZ, y0, y1, tile);
  pushWall(b, minX, minZ, minX, maxZ, y0, y1, tile);
}

// one cell of the 4x4 neon atlas as a flat quad
function pushNeon(ctx, x, y, z, w, h, yaw, cell) {
  const b = ctx.g.neon;
  const col = cell % 4;
  const row = (cell / 4) | 0;
  const u0 = col / 4;
  const u1 = u0 + 0.25;
  const v1 = 1 - row / 4;
  const v0 = v1 - 0.25;
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const rx = cs * (w / 2);
  const rz = -sn * (w / 2);
  const hh = h / 2;
  const verts = [
    [x - rx, y - hh, z - rz, u0, v0], [x + rx, y - hh, z + rz, u1, v0],
    [x + rx, y + hh, z + rz, u1, v1], [x - rx, y + hh, z - rz, u0, v1],
  ];
  for (const k of QUAD_TRIS) {
    const [vx, vy, vz, uu, vv] = verts[k];
    b.pos.push(vx, vy, vz);
    b.nor.push(sn, 0, cs);
    b.uv.push(uu, vv);
  }
}

// ---- Streets: asphalt, dashes, crosswalks, raised sidewalk pads with kerbs ----
function buildStreets(ctx) {
  const g = ctx.g;
  const size = CFG.block * 2;
  const Y_ROAD = 0.05;
  const Y_PAINT = Y_ROAD + 0.012;

  pushBox(g.road, 0, Y_ROAD / 2, 0, ROAD_MAX_X - ROAD_MIN_X, Y_ROAD, ROAD_MAX_Z - ROAD_MIN_Z);
  // the two boulevards get a wetter, darker asphalt strip
  const mx = streetLine(CFG.mainX);
  const mz = rowLine(CFG.mainZ);
  pushBox(g.roadMain, mx, Y_ROAD / 2 + 0.001, 0, CFG.street, Y_ROAD + 0.002, ROAD_MAX_Z - ROAD_MIN_Z);
  pushBox(g.roadMain, 0, Y_ROAD / 2 + 0.001, mz, ROAD_MAX_X - ROAD_MIN_X, Y_ROAD + 0.002, CFG.street);

  const halfLane = CFG.street / 4;
  const dash = (x, z, len, axis) => {
    const step = 6.4;
    const n = Math.max(1, Math.floor(len / step));
    for (let i = 0; i < n; i += 1) {
      const t = -len / 2 + step * (i + 0.5);
      if (axis === 'z') pushBox(g.lane, x, Y_PAINT, z + t, 0.3, 0.01, 3.2);
      else pushBox(g.lane, x + t, Y_PAINT, z, 3.2, 0.01, 0.3);
    }
  };

  // ten street lines per axis: S0..S9 run along z, Z0..Z9 along x, closing nine blocks each way
  for (let k = 0; k <= CFG.cols; k += 1) {
    const x = streetLine(k);
    ctx.streets.push({
      id: `S${k}`, axis: 'z', centre: x, from: ROAD_MIN_Z, to: ROAD_MAX_Z,
      lanes: [{ offset: -halfLane, dir: -1 }, { offset: halfLane, dir: 1 }],
    });
    for (let j = 0; j < CFG.rows; j += 1) {
      const zc = rowLine(j) + CFG.street / 2 + CFG.block;
      dash(x - halfLane, zc, size - 6, 'z');
      dash(x + halfLane, zc, size - 6, 'z');
    }
  }
  for (let j = 0; j <= CFG.rows; j += 1) {
    const z = rowLine(j);
    ctx.streets.push({
      id: `Z${j}`, axis: 'x', centre: z, from: ROAD_MIN_X, to: ROAD_MAX_X,
      lanes: [{ offset: -halfLane, dir: 1 }, { offset: halfLane, dir: -1 }],
    });
    for (let k = 0; k < CFG.cols; k += 1) {
      const xc = streetLine(k) + CFG.street / 2 + CFG.block;
      dash(xc, z - halfLane, size - 6, 'x');
      dash(xc, z + halfLane, size - 6, 'x');
    }
  }

  for (let k = 0; k <= CFG.cols; k += 1) {
    for (let j = 0; j <= CFG.rows; j += 1) {
      ctx.intersections.push({ x: streetLine(k), z: rowLine(j), streets: [`S${k}`, `Z${j}`] });
    }
  }

  // crosswalk zebras: all four arms of the two boulevard crossings, and each junction along them
  const armZ = mz - (CFG.street / 2 + CFG.walk + 1.6);
  const armZ2 = mz + (CFG.street / 2 + CFG.walk + 1.6);
  const armX = mx - (CFG.street / 2 + CFG.walk + 1.6);
  const armX2 = mx + (CFG.street / 2 + CFG.walk + 1.6);
  for (let k = 0; k <= CFG.cols; k += 1) {
    const x = streetLine(k);
    pushBox(g.cross, x, Y_PAINT + 0.004, armZ, CFG.street, 0.01, 4.2);
    pushBox(g.cross, x, Y_PAINT + 0.004, armZ2, CFG.street, 0.01, 4.2);
  }
  for (let j = 0; j <= CFG.rows; j += 1) {
    const z = rowLine(j);
    pushBox(g.cross, armX, Y_PAINT + 0.004, z, 4.2, 0.01, CFG.street);
    pushBox(g.cross, armX2, Y_PAINT + 0.004, z, 4.2, 0.01, CFG.street);
  }

  // sidewalk pads: one per block, kerb ring, and a creature-width walk ring for the pedestrians
  const kerbY = Y_PAD + CFG.kerb / 2;
  for (let k = 0; k < CFG.cols; k += 1) {
    for (let j = 0; j < CFG.rows; j += 1) {
      const bx = streetLine(k) + CFG.street / 2 + CFG.block;
      const bz = rowLine(j) + CFG.street / 2 + CFG.block;
      pushBox(g.walk, bx, Y_PAD / 2, bz, size, Y_PAD, size);
      for (const s of [-1, 1]) {
        pushBox(g.kerb, bx + s * size / 2, kerbY, bz, 0.26, CFG.kerb, size);
        pushBox(g.kerb, bx, kerbY, bz + s * size / 2, size, CFG.kerb, 0.26);
      }
      const inner = size - CFG.walk * 2;
      ctx.blocks.push({
        k,
        j,
        x: bx,
        z: bz,
        inner,
        minX: bx - inner / 2,
        maxX: bx + inner / 2,
        minZ: bz - inner / 2,
        maxZ: bz + inner / 2,
        walkMinX: bx - size / 2,
        walkMaxX: bx + size / 2,
        walkMinZ: bz - size / 2,
        walkMaxZ: bz + size / 2,
      });
      const w = size / 2 - 1.7;
      ctx.sidewalks.push({
        width: CFG.walk - 1.2,
        points: [
          [bx - w, bz - w], [bx + w, bz - w], [bx + w, bz + w], [bx - w, bz + w],
        ],
      });
    }
  }
  ctx.size = size;
}

// ---- Blocks: lots, parks, plazas, parking; eight blocks stay open so the city breathes ----
function buildBlocks(ctx) {
  const SPECIAL = {
    '2,2': 'plaza',
    '6,1': 'park',
    '1,3': 'market',
    '7,4': 'parking',
    '3,5': 'park',
    '5,6': 'parking',
    '2,7': 'plaza',
    '6,8': 'towerPlaza',
  };
  for (const blk of ctx.blocks) {
    const kind = SPECIAL[`${blk.k},${blk.j}`] || 'built';
    buildBlock(ctx, blk, kind);
  }
}

function districtOf(blk) {
  if (blk.j <= 1) return 'playa';
  if (blk.j <= 3) return 'mercado';
  if (blk.j <= 6) return 'puerto';
  return 'colinas';
}

function buildBlock(ctx, blk, kind) {
  const d = districtOf(blk);
  if (kind === 'park') return buildPark(ctx, blk, d);
  if (kind === 'plaza') return buildPlaza(ctx, blk);
  if (kind === 'parking') return buildParking(ctx, blk);
  if (kind === 'market') return buildMarket(ctx, blk);
  if (kind === 'towerPlaza') return buildTowerPlaza(ctx, blk);
  for (const lot of splitLots(ctx.rng, blk)) {
    const w = lot.maxX - lot.minX;
    const dep = lot.maxZ - lot.minZ;
    if (w < 7 || dep < 7) continue;
    if (d === 'playa') buildHotel(ctx, lot);
    else if (d === 'colinas') buildTower(ctx, lot);
    else buildMidRise(ctx, lot, d === 'mercado');
  }
  return undefined;
}

// 1, 2 or 4 lots inside the buildable inner square, with a service alley between them
function splitLots(rng, blk) {
  const { minX: x0, maxX: x1, minZ: z0, maxZ: z1 } = blk;
  const r = rng();
  const gap = 2.8;
  if (r < 0.2) return [{ minX: x0, maxX: x1, minZ: z0, maxZ: z1 }];
  if (r < 0.6) {
    const t = 0.36 + rng() * 0.28;
    if (rng() < 0.5) {
      const m = z0 + (z1 - z0) * t;
      return [
        { minX: x0, maxX: x1, minZ: z0, maxZ: m - gap / 2 },
        { minX: x0, maxX: x1, minZ: m + gap / 2, maxZ: z1 },
      ];
    }
    const m = x0 + (x1 - x0) * t;
    return [
      { minX: x0, maxX: m - gap / 2, minZ: z0, maxZ: z1 },
      { minX: m + gap / 2, maxX: x1, minZ: z0, maxZ: z1 },
    ];
  }
  const mx = x0 + (x1 - x0) * (0.4 + rng() * 0.2);
  const mz = z0 + (z1 - z0) * (0.4 + rng() * 0.2);
  return [
    { minX: x0, maxX: mx - gap / 2, minZ: z0, maxZ: mz - gap / 2 },
    { minX: mx + gap / 2, maxX: x1, minZ: z0, maxZ: mz - gap / 2 },
    { minX: x0, maxX: mx - gap / 2, minZ: mz + gap / 2, maxZ: z1 },
    { minX: mx + gap / 2, maxX: x1, minZ: mz + gap / 2, maxZ: z1 },
  ];
}

// shared building envelope: walls into a material builder, roof slab, collider, AO footprint
function shell(ctx, lot, height, band) {
  const minX = lot.minX + CFG.lot;
  const maxX = lot.maxX - CFG.lot;
  const minZ = lot.minZ + CFG.lot;
  const maxZ = lot.maxZ - CFG.lot;
  if (maxX - minX < 5 || maxZ - minZ < 5) return null;
  const g = ctx.g;
  const y1 = Y_BUILD + height;
  if (band === 'tower') pushWalls(g.tower, minX, maxX, minZ, maxZ, Y_BUILD, y1, 13);
  else {
    const v = (ctx.rng() * 4) | 0;
    pushWalls(g.facade[v], minX, maxX, minZ, maxZ, Y_BUILD, y1, 12);
  }
  // a thin coping slab flush with the walls: a fat overhanging slab reads as a lid over the street
  pushBox(g.roof, (minX + maxX) / 2, y1 + 0.16, (minZ + maxZ) / 2, maxX - minX + 0.16, 0.32, maxZ - minZ + 0.16);
  pushCollider(ctx, minX, maxX, minZ, maxZ, y1);
  const info = {
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    sx: maxX - minX,
    sz: maxZ - minZ,
    minX,
    maxX,
    minZ,
    maxZ,
    top: y1,
  };
  ctx.ao.push(info);
  return info;
}

// pastel 3-5 storey hotels along Playa Norte: cornice, balconies, shutters come from the texture
function buildHotel(ctx, lot) {
  const rng = ctx.rng;
  const g = ctx.g;
  const storeys = 3 + ((rng() * 3) | 0);
  const info = shell(ctx, lot, storeys * 3.5, 'hotel');
  if (!info) return;
  const { cx, cz, sx, sz, top } = info;
  // a slim cornice, not a slab: 0.12 m proud of the wall, one storey band deep
  pushBox(g.balcony, cx, top + 0.42, cz, sx + 0.24, 0.34, sz + 0.24);
  // parapet blocks to break the roofline
  const n = 2 + ((rng() * 3) | 0);
  for (let i = 0; i < n; i += 1) {
    pushBox(g.roof, cx + (rng() - 0.5) * sx * 0.8, top + 0.8, cz + (rng() - 0.5) * sz * 0.8, 1.8, 0.8, 1.8);
  }
  // balconies on the two long faces, one per room bay, every other storey
  for (const s of [-1, 1]) {
    const bays = Math.max(2, Math.floor(sx / 4.4));
    for (let i = 0; i < bays; i += 1) {
      if (rng() < 0.25) continue;
      const bx = cx - sx / 2 + (sx / bays) * (i + 0.5);
      for (let f = 1; f < storeys; f += 1) {
        const y = Y_BUILD + f * 3.5;
        pushBox(g.balcony, bx, y, cz + s * (sz / 2 + 0.62), 2.5, 0.16, 1.3);
        pushBox(g.metal, bx, y + 0.5, cz + s * (sz / 2 + 1.2), 2.5, 0.9, 0.07);
      }
    }
  }
  // rooftop water tank + stair hut
  pushBox(g.tank, cx + sx * 0.2, top + 2.1, cz - sz * 0.2, 2.2, 2.2, 2.2);
  pushBox(g.roof, cx - sx * 0.24, top + 1.4, cz + sz * 0.18, 3.0, 2.4, 2.6);
}

// 6-12 storey mid-rise through Mercado Viejo and Puerto Alto
function buildMidRise(ctx, lot, mercado) {
  const rng = ctx.rng;
  const g = ctx.g;
  const storeys = 6 + ((rng() * 7) | 0);
  const floor = 3.15;
  const info = shell(ctx, lot, storeys * floor, 'mid');
  if (!info) return;
  const { cx, cz, sx, sz, top } = info;
  // setback upper tier
  if (rng() < 0.65) {
    const ix = (sx - 5) / 2;
    const iz = (sz - 5) / 2;
    pushWalls(g.facade[(rng() * 4) | 0], cx - ix, cx + ix, cz - iz, cz + iz, top + 0.4, top + 4.6, 12);
    pushBox(g.roof, cx, top + 4.72, cz, ix * 2 + 0.14, 0.28, iz * 2 + 0.14);
  }
  // balconies, two per face, two faces only
  for (const s of [-1, 1]) {
    for (let i = 0; i < 2; i += 1) {
      const bx = cx + (i ? 1 : -1) * sx * 0.24;
      for (let f = 1; f < storeys; f += 2) {
        const y = Y_BUILD + f * floor;
        pushBox(g.balcony, bx, y, cz + s * (sz / 2 + 0.6), sx * 0.3, 0.15, 1.2);
        pushBox(g.metal, bx, y + 0.45, cz + s * (sz / 2 + 1.15), sx * 0.3, 0.85, 0.07);
      }
    }
  }
  // rooftop water tanks, the Mercado Viejo silhouette
  const tanks = 1 + (rng() < 0.55 ? 1 : 0);
  for (let i = 0; i < tanks; i += 1) {
    const tx = cx + (rng() - 0.5) * (sx - 5);
    const tz = cz + (rng() - 0.5) * (sz - 5);
    pushBox(g.metal, tx, top + 0.55, tz, 0.14, 1.1, 0.14);
    pushBox(g.tank, tx, top + 2.1, tz, 2.0, 2.0, 2.0);
  }
  // awnings and neon on the Mercado facades
  if (mercado) {
    for (const s of [-1, 1]) {
      if (rng() < 0.35) continue;
      pushBox(g.awning, cx, Y_PAD + 3.1, cz + s * (sz / 2 + 1.15), sx * 0.72, 0.12, 2.3);
    }
    if (rng() < 0.8) {
      const s = rng() < 0.5 ? -1 : 1;
      ctx.neon.push({
        x: cx + (rng() - 0.5) * sx * 0.5,
        y: Y_PAD + 5.6 + rng() * 1.8,
        z: cz + s * (sz / 2 + 0.1),
        yaw: s > 0 ? 0 : Math.PI,
        cell: (rng() * 16) | 0,
      });
    }
  }
}

// 14-30 storey towers in Colinas Altas: retail plinth, glass shaft, crown mast
function buildTower(ctx, lot) {
  const rng = ctx.rng;
  const g = ctx.g;
  const storeys = 14 + ((rng() * 17) | 0);
  const floor = 3.25;
  const info = shell(ctx, lot, 6, 'tower');          // two storeys of retail under the shaft
  if (!info) return;
  const { cx, cz, sx, sz, top } = info;
  pushBox(g.facade[(rng() * 4) | 0], cx, Y_BUILD + 3.0, cz, sx + 1.7, 6.0, sz + 1.7);
  const ix = sx - 3.2;
  const iz = sz - 3.2;
  const cap = Y_BUILD + storeys * floor;             // 45.5 m .. 97.5 m
  pushWalls(g.tower, cx - ix / 2, cx + ix / 2, cz - iz / 2, cz + iz / 2, top, cap, 13);
  pushBox(g.roof, cx, cap + 0.2, cz, ix + 0.7, 0.5, iz + 0.7);
  pushBox(g.tank, cx, cap + 1.7, cz, 3.0, 2.4, 3.0);
  pushCylinder(g.metal,
    new THREE.Vector3(cx, cap + 2.9, cz),
    new THREE.Vector3(cx, cap + 11.0, cz), 0.2, 0.05, 6);
  pushCollider(ctx, cx - ix / 2, cx + ix / 2, cz - iz / 2, cz + iz / 2, cap);
}

function buildTowerPlaza(ctx, blk) {
  const rng = ctx.rng;
  const g = ctx.g;
  pushBox(g.plaza, blk.x, Y_PAD + 0.03, blk.z, blk.inner, 0.06, blk.inner);
  buildTower(ctx, {
    minX: blk.minX + 7, maxX: blk.maxX - 7, minZ: blk.minZ + 7, maxZ: blk.maxZ - 7,
  });
  for (let i = 0; i < 6; i += 1) {
    const x = blk.minX + 3 + rng() * (blk.inner - 6);
    const z = blk.minZ + 3 + rng() * (blk.inner - 6);
    if (x > blk.minX + 4 && x < blk.maxX - 4 && z > blk.minZ + 4 && z < blk.maxZ - 4) continue;
    pushPlanter(ctx, x, z, 1.5);
  }
}

function buildPark(ctx, blk, district) {
  const rng = ctx.rng;
  const g = ctx.g;
  pushBox(g.foliage, blk.x, Y_PAD + 0.06, blk.z, blk.inner, 0.12, blk.inner);
  // crossing paths
  pushBox(g.plaza, blk.x, Y_PAD + 0.14, blk.z, blk.inner, 0.05, 3.4);
  pushBox(g.plaza, blk.x, Y_PAD + 0.14, blk.z, 3.4, 0.05, blk.inner);
  // hedge ring, broken where the paths leave the block
  const half = blk.inner / 2 - 2.2;
  for (let t = -half; t <= half; t += 2.6) {
    if (Math.abs(t) < 3.6) continue;
    for (const s of [-1, 1]) {
      pushBox(g.foliage, blk.x + t, Y_PAD + 0.7, blk.z + s * half, 2.4, 1.05, 1.3);
      pushBox(g.foliage, blk.x + s * half, Y_PAD + 0.7, blk.z + t, 1.3, 1.05, 2.4);
    }
  }
  const palms = 5 + ((rng() * 4) | 0);
  for (let i = 0; i < palms; i += 1) {
    addPalm(ctx, blk.minX + 4 + rng() * (blk.inner - 8), blk.minZ + 4 + rng() * (blk.inner - 8), 8 + rng() * 5, rng);
  }
  for (let i = 0; i < 4; i += 1) {
    const x = blk.x + (rng() < 0.5 ? -1 : 1) * (blk.inner * 0.2 + rng() * blk.inner * 0.18);
    const z = blk.z + (i % 2 ? 2.8 : -2.8);
    pushBox(g.bench, x, Y_PAD + 0.62, z, 2.1, 0.16, 0.62);
    pushBox(g.metal, x, Y_PAD + 0.3, z, 0.1, 0.6, 0.55);
  }
  if (district === 'colinas') {
    // a small fountain at the crossing
    pushCylinder(g.planter, new THREE.Vector3(blk.x, Y_PAD, blk.z), new THREE.Vector3(blk.x, Y_PAD + 0.9, blk.z), 2.4, 2.2, 10);
    pushCollider(ctx, blk.x - 2.4, blk.x + 2.4, blk.z - 2.4, blk.z + 2.4, 1.2);
  }
}

function buildPlaza(ctx, blk) {
  const rng = ctx.rng;
  const g = ctx.g;
  pushBox(g.plaza, blk.x, Y_PAD + 0.03, blk.z, blk.inner, 0.06, blk.inner);
  // fountain ring
  const r = 4.0;
  const seg = 12;
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    pushBox(g.stone, blk.x + Math.cos(a) * r, Y_PAD + 0.35, blk.z + Math.sin(a) * r, 2.2, 0.7, 0.7, -a);
  }
  pushCylinder(g.planter, new THREE.Vector3(blk.x, Y_PAD, blk.z), new THREE.Vector3(blk.x, Y_PAD + 1.6, blk.z), 0.45, 0.28, 8);
  pushCollider(ctx, blk.x - r - 0.4, blk.x + r + 0.4, blk.z - r - 0.4, blk.z + r + 0.4, 1.0);
  // four stalls under the palms
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + 0.5;
    const x = blk.x + Math.cos(a) * blk.inner * 0.34;
    const z = blk.z + Math.sin(a) * blk.inner * 0.34;
    pushBox(g.bench, x, Y_PAD + 0.7, z, 2.6, 1.4, 2.1);
    pushBox(g.roof, x, Y_PAD + 1.55, z, 3.4, 0.18, 3.0);
    pushCollider(ctx, x - 1.3, x + 1.3, z - 1.05, z + 1.05, 1.7);
    pushPlanter(ctx, blk.x + Math.cos(a + 0.55) * blk.inner * 0.45, blk.z + Math.sin(a + 0.55) * blk.inner * 0.45, 1.3);
  }
  for (let i = 0; i < 4; i += 1) {
    addPalm(ctx, blk.x + (rng() - 0.5) * blk.inner * 0.8, blk.z + (rng() - 0.5) * blk.inner * 0.8, 7 + rng() * 4, rng);
  }
}

// the market square: aisles of stalls with striped canopies, crates, a tall neon front
function buildMarket(ctx, blk) {
  const rng = ctx.rng;
  const g = ctx.g;
  pushBox(g.plaza, blk.x, Y_PAD + 0.03, blk.z, blk.inner, 0.06, blk.inner);
  const rows = 3;
  const cols = 3;
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      const x = blk.minX + blk.inner * (0.2 + 0.3 * i);
      const z = blk.minZ + blk.inner * (0.2 + 0.3 * j);
      pushBox(g.bench, x, Y_PAD + 0.5, z, 3.0, 1.0, 2.2);
      pushBox(g.awning, x, Y_PAD + 1.55, z, 3.6, 0.16, 2.8);
      pushCollider(ctx, x - 1.5, x + 1.5, z - 1.1, z + 1.1, 1.6);
    }
  }
  for (let i = 0; i < 5; i += 1) {
    addPalm(ctx, blk.minX + 3 + rng() * (blk.inner - 6), blk.minZ + 3 + rng() * (blk.inner - 6), 9 + rng() * 4, rng);
  }
  // crates and a neon board on the north kerb
  for (let i = 0; i < 6; i += 1) {
    pushBox(g.bench, blk.minX + rng() * blk.inner, Y_PAD + 0.35, blk.maxZ - 2.5 - rng() * 2, 1.0, 0.7, 1.0);
  }
  ctx.neon.push({ x: blk.x, y: Y_PAD + 7.5, z: blk.maxZ + 0.2, yaw: 0, cell: 3 });
  ctx.neon.push({ x: blk.maxX + 0.2, y: Y_PAD + 6.5, z: blk.z, yaw: Math.PI / 2, cell: 10 });
}

function buildParking(ctx, blk) {
  const rng = ctx.rng;
  const g = ctx.g;
  pushBox(g.road, blk.x, Y_PAD + 0.02, blk.z, blk.inner, 0.05, blk.inner);
  const cols = 5;
  for (let i = 0; i <= cols; i += 1) {
    const x = blk.minX + (blk.inner / cols) * i;
    pushBox(g.lane, x, Y_PAD + 0.05, blk.z - blk.inner * 0.2, 0.2, 0.01, blk.inner * 0.34);
    pushBox(g.lane, x, Y_PAD + 0.05, blk.z + blk.inner * 0.2, 0.2, 0.01, blk.inner * 0.34);
  }
  // low wall on the two street sides
  const t = 0.4;
  for (const s of [-1, 1]) {
    pushBox(g.stone, blk.x + s * blk.inner / 2, Y_PAD + 0.45, blk.z, t, 0.85, blk.inner);
    pushCollider(ctx, blk.x + s * blk.inner / 2 - t, blk.x + s * blk.inner / 2 + t, blk.minZ, blk.maxZ, 0.95);
  }
  pushCollider(ctx, blk.minX, blk.maxX, blk.minZ, blk.minZ + t, 0.95);
  pushCollider(ctx, blk.minX, blk.maxX, blk.maxZ - t, blk.maxZ, 0.95);
  for (let i = 0; i < 3; i += 1) {
    addPalm(ctx, blk.minX + 4 + rng() * (blk.inner - 8), blk.minZ + 2.5, 8 + rng() * 2, rng);
  }
}

function pushPlanter(ctx, x, z, r) {
  const g = ctx.g;
  pushCylinder(g.planter, new THREE.Vector3(x, Y_PAD, z), new THREE.Vector3(x, Y_PAD + 0.75, z), r, r * 0.92, 8);
  pushCylinder(g.foliage, new THREE.Vector3(x, Y_PAD + 0.7, z), new THREE.Vector3(x, Y_PAD + 1.3, z), r * 0.78, r * 0.55, 7);
  pushCollider(ctx, x - r, x + r, z - r, z + r, Y_PAD + 0.8);
}

// ---- Street furniture along both boulevards: palms, lamps, benches, planters, bus stops ----
function buildStreetFurniture(ctx) {
  const rng = ctx.rng;
  const g = ctx.g;
  const mx = streetLine(CFG.mainX);
  const mz = rowLine(CFG.mainZ);
  const kerb = CFG.street / 2 + 1.7;      // centre of the boulevard sidewalk, measured from the street
  const clearZ = (z) => {
    const j = Math.round((z - rowLine(0)) / PITCH);
    return Math.abs(z - rowLine(Math.max(0, Math.min(CFG.rows, j)))) > CFG.street / 2 + 3;
  };
  const clearX = (x) => {
    const k = Math.round((x - streetLine(0)) / PITCH);
    return Math.abs(x - streetLine(Math.max(0, Math.min(CFG.cols, k)))) > CFG.street / 2 + 3;
  };

  // Avenida Sol: palms, lamp posts and benches alternating down both kerbs, every 13 m
  let n = 0;
  for (let z = ROAD_MIN_Z + 6; z < ROAD_MAX_Z - 6; z += 13, n += 1) {
    if (!clearZ(z)) continue;
    for (const s of [-1, 1]) {
      if (n % 2 === 0) addPalm(ctx, mx + s * kerb, z + s * 2.4, 9 + rng() * 5, rng);
      else ctx.lamps.push({ x: mx + s * (kerb - 0.3), z: z + s * 5.5, yaw: s > 0 ? Math.PI : 0 });
      if (n % 4 === 3) pushBox(g.bench, mx + s * (kerb - 1.5), Y_PAD + 0.62, z, 0.62, 0.16, 2.1);
    }
  }
  // Calle Mercado
  let m = 0;
  for (let x = ROAD_MIN_X + 6; x < ROAD_MAX_X - 6; x += 13, m += 1) {
    if (!clearX(x)) continue;
    for (const s of [-1, 1]) {
      if (m % 2 === 0) addPalm(ctx, x + s * 2.4, mz + s * kerb, 9 + rng() * 5, rng);
      else ctx.lamps.push({ x: x + s * 5.5, z: mz + s * (kerb - 0.3), yaw: s > 0 ? -Math.PI / 2 : Math.PI / 2 });
      if (m % 4 === 1) pushBox(g.bench, x, Y_PAD + 0.62, mz + s * (kerb - 1.5), 2.1, 0.16, 0.62);
    }
  }

  // planters down the middle of the boulevards, every few blocks
  for (let z = ROAD_MIN_Z + 18; z < ROAD_MAX_Z - 18; z += 36) {
    if (!clearZ(z)) continue;
    pushPlanter(ctx, mx - kerb + 0.1, z, 1.2);
    pushPlanter(ctx, mx + kerb - 0.1, z + 18, 1.2);
  }
  for (let x = ROAD_MIN_X + 18; x < ROAD_MAX_X - 18; x += 36) {
    if (!clearX(x)) continue;
    pushPlanter(ctx, x, mz - kerb + 0.1, 1.2);
    pushPlanter(ctx, x + 18, mz + kerb - 0.1, 1.2);
  }

  // three bus stops on Avenida Sol: shelter, roof, bench, sign
  const stops = [-62, 116, 200];
  for (const z of stops) {
    const x = mx - (CFG.street / 2 + 2.4);
    pushBox(g.metal, x, Y_PAD + 1.3, z - 3.2, 1.3, 2.6, 0.14);
    pushBox(g.roof, x + 0.35, Y_PAD + 2.7, z, 2.4, 0.16, 7.0);
    pushBox(g.metal, x, Y_PAD + 1.2, z + 3.2, 1.3, 2.4, 0.14);
    pushBox(g.bench, x + 0.6, Y_PAD + 0.55, z, 0.5, 0.14, 4.6);
    pushBox(g.metal, x + 0.2, Y_PAD + 2.9, z, 0.1, 0.4, 6.4);
    pushCollider(ctx, x - 0.7, x + 0.75, z - 3.4, z + 3.4, Y_PAD + 2.8);
  }
}

// a palm goes into the instance list and gets a trunk collider
function addPalm(ctx, x, z, height, rng) {
  ctx.palms.push({
    x,
    z,
    h: height,
    lean: (rng() - 0.5) * 0.22,
    yaw: rng() * Math.PI * 2,
    scale: 0.85 + rng() * 0.3,
  });
  pushCollider(ctx, x - 0.42, x + 0.42, z - 0.42, z + 0.42, height);
}

// ---- The coast: boardwalk with railings and kiosks, sand, low seawall, pier on stilts ----
function buildBeach(ctx) {
  const rng = ctx.rng;
  const g = ctx.g;
  const x0 = ROAD_MIN_X - 14;
  const x1 = ROAD_MAX_X + 14;

  // sand from the boardwalk to the water
  pushBox(g.sand, (x0 + x1) / 2, 0.06, (BAY_Z + SAND_Z) / 2, x1 - x0, 0.12, BAY_Z - SAND_Z);
  // a low dune berm at the back of the sand
  pushBox(g.sand, (x0 + x1) / 2, 0.4, BAY_Z - 6, x1 - x0, 0.8, 12);

  buildBoardwalk(ctx, x0, x1);
  buildPier(ctx);

  // low seawall at the water's edge, broken by the pier
  const wallZ = SAND_Z + 0.6;
  for (const seg of [[x0, -12], [12, x1]]) {
    const len = seg[1] - seg[0];
    pushBox(g.stone, (seg[0] + seg[1]) / 2, 0.55, wallZ, len, 1.1, 1.4);
    pushBox(g.stone, (seg[0] + seg[1]) / 2, 1.15, wallZ, len, 0.18, 1.7);
    pushCollider(ctx, seg[0], seg[1], wallZ - 0.7, wallZ + 0.7, 1.2);
  }

  // beach dressing: parasols, loungers, a lifeguard hut
  for (let i = 0; i < 14; i += 1) {
    const x = x0 + 20 + rng() * (x1 - x0 - 40);
    const z = BAY_Z - 12 - rng() * (CFG.sand - 18);
    pushCylinder(g.metal, new THREE.Vector3(x, 0.15, z), new THREE.Vector3(x, 2.5, z), 0.07, 0.06, 5);
    pushCylinder(g.awning, new THREE.Vector3(x, 2.5, z), new THREE.Vector3(x, 2.85, z), 1.9, 0.25, 8);
    pushBox(g.bench, x + 1.5, 0.35, z + 1.2, 0.9, 0.2, 2.0);
  }
  const hutX = x0 + (x1 - x0) * 0.62;
  const hutZ = BAY_Z - 20;
  pushBox(g.bench, hutX, 1.1, hutZ, 4.2, 2.2, 3.6);
  pushBox(g.roof, hutX, 2.4, hutZ, 5.2, 0.24, 4.6);
  pushCollider(ctx, hutX - 2.1, hutX + 2.1, hutZ - 1.8, hutZ + 1.8, 2.4);

  // palms along the sand behind the boardwalk
  for (let x = x0 + 10; x < x1 - 10; x += 22) {
    addPalm(ctx, x, BAY_Z - 4.5, 10 + rng() * 5, rng);
  }
}

function buildBoardwalk(ctx, x0, x1) {
  const rng = ctx.rng;
  const g = ctx.g;
  // deck in 12 m planks so the boardwalk texture keeps its scale
  const step = 12;
  for (let x = x0; x < x1; x += step) {
    const w = Math.min(step, x1 - x);
    pushBox(g.board, x + w / 2, Y_PAD + 0.4, COAST_Z - CFG.bay / 2, w, 0.16, CFG.bay);
  }
  // kerb between street and boardwalk, with two gaps for the beach stairs
  for (const seg of [[x0, -14], [14, x1]]) {
    pushBox(g.kerb, (seg[0] + seg[1]) / 2, Y_PAD + 0.52, COAST_Z - 0.3, seg[1] - seg[0], 0.24, 0.5);
  }
  // stair runs down to the sand, aligned with the gaps
  for (const x of [-9, 9]) {
    for (let i = 0; i < 3; i += 1) {
      pushBox(g.board, x, Y_PAD + 0.26 - i * 0.13, COAST_Z - CFG.bay - 1 - i * 1.1, 26, 0.14, 1.2);
    }
  }
  // seaward railing: posts + two rails, one collider per 12 m run
  const railZ = COAST_Z - CFG.bay + 0.4;
  for (let x = x0; x < x1; x += 3) {
    if (Math.abs(x) < 14) continue;
    pushBox(g.metal, x, Y_PAD + 1.0, railZ, 0.09, 1.1, 0.09);
  }
  for (let x = x0; x < x1; x += step) {
    const w = Math.min(step, x1 - x);
    const cx = x + w / 2;
    if (Math.abs(cx) < 14 + step / 2) continue;
    pushBox(g.metal, cx, Y_PAD + 1.5, railZ, w, 0.09, 0.1);
    pushBox(g.metal, cx, Y_PAD + 0.95, railZ, w, 0.07, 0.07);
    pushCollider(ctx, x, x + w, railZ - 0.2, railZ + 0.2, Y_PAD + 1.6);
  }
  // kiosks: three shacks selling fish, coffee, boat trips
  for (const kx of [x0 + 60, x0 + 210, x1 - 90]) {
    const kz = COAST_Z - CFG.bay * 0.5;
    pushBox(g.bench, kx, Y_PAD + 1.1, kz, 4.4, 2.0, 3.0);
    pushBox(g.awning, kx, Y_PAD + 2.25, kz + 0.6, 5.4, 0.16, 4.2);
    pushBox(g.roof, kx, Y_PAD + 2.5, kz - 0.9, 5.0, 0.2, 1.6);
    pushBox(g.metal, kx, Y_PAD + 1.2, kz + 1.7, 3.6, 0.1, 0.6);
    pushCollider(ctx, kx - 2.2, kx + 2.2, kz - 1.5, kz + 1.5, Y_PAD + 2.4);
    addPalm(ctx, kx + 8, COAST_Z - 1.5, 9 + rng() * 3, rng);
    ctx.lamps.push({ x: kx - 7, z: COAST_Z - 2.0, yaw: Math.PI / 2 });
  }
  // palms along the landward edge of the deck
  for (let x = x0 + 12; x < x1 - 12; x += 17) {
    addPalm(ctx, x, COAST_Z - 1.4, 9 + rng() * 4, rng);
  }
}

function buildPier(ctx) {
  const rng = ctx.rng;
  const g = ctx.g;
  const w = 14;
  const endZ = PIER_Z;
  // deck: planked, broken into segments for texture scale
  for (let z = SAND_Z - 2; z > endZ; z -= 8) {
    const len = Math.min(8, z - endZ);
    if (len <= 0.2) break;
    pushBox(g.board, 0, Y_PAD + 0.9, z - len / 2, w, 0.22, len);
  }
  // stilts, alternating pairs, plus cross bracing every 16 m
  for (let z = SAND_Z - 6; z > endZ; z -= 6) {
    for (const x of [-w / 2 + 0.8, w / 2 - 0.8]) {
      pushCylinder(g.metal, new THREE.Vector3(x, -1.2, z), new THREE.Vector3(x, Y_PAD + 0.85, z), 0.22, 0.18, 6);
    }
    pushBox(g.metal, 0, Y_PAD + 0.55, z, w, 0.18, 0.18);
  }
  // railings both sides
  for (let z = SAND_Z - 4; z > endZ; z -= 3) {
    for (const x of [-w / 2 + 0.2, w / 2 - 0.2]) {
      pushBox(g.metal, x, Y_PAD + 1.9, z, 0.1, 1.6, 0.1);
    }
  }
  for (const x of [-w / 2 + 0.2, w / 2 - 0.2]) {
    const len = SAND_Z - 4 - endZ;
    pushBox(g.metal, x, Y_PAD + 2.65, SAND_Z - 4 - len / 2, 0.12, 0.1, len);
    pushCollider(ctx, x - 0.2, x + 0.2, endZ, SAND_Z - 4, Y_PAD + 2.7);
  }
  // end platform, hut and lamp
  pushBox(g.board, 0, Y_PAD + 1.0, endZ - 5, 26, 0.24, 13);
  for (const x of [-12, 12]) {
    for (const z of [endZ - 0.5, endZ - 10]) {
      pushCylinder(g.metal, new THREE.Vector3(x, -1.2, z), new THREE.Vector3(x, Y_PAD + 0.95, z), 0.24, 0.2, 6);
    }
  }
  for (const x of [-12.6, 12.6]) {
    pushBox(g.metal, x, Y_PAD + 1.9, endZ - 5, 0.12, 1.7, 13);
    pushCollider(ctx, x - 0.2, x + 0.2, endZ - 11.5, endZ + 1.5, Y_PAD + 2.8);
  }
  pushBox(g.metal, 0, Y_PAD + 1.9, endZ - 11.4, 25.4, 1.7, 0.12);
  pushCollider(ctx, -12.7, 12.7, endZ - 11.6, endZ - 11.2, Y_PAD + 2.8);
  const hz = endZ - 6;
  pushBox(g.bench, 5.5, Y_PAD + 2.3, hz, 5.0, 2.6, 4.2);
  pushBox(g.awning, 5.5, Y_PAD + 3.8, hz, 6.4, 0.2, 5.4);
  pushBox(g.roof, 5.5, Y_PAD + 4.1, hz, 5.6, 0.24, 4.6);
  pushCollider(ctx, 3.0, 8.0, hz - 2.1, hz + 2.1, Y_PAD + 4.0);
  addPalm(ctx, -8, endZ - 6, 8 + rng() * 2, rng);
  ctx.lamps.push({ x: -8, z: endZ - 1.5, yaw: -Math.PI / 2 });
  ctx.lamps.push({ x: 0, z: SAND_Z - 2.5, yaw: 0 });
}

// ---- Spawn points: 21 legal street positions, 16 of them on the boulevard sidewalks ----
function buildSpawns(ctx) {
  const mx = streetLine(CFG.mainX);
  const mz = rowLine(CFG.mainZ);
  const offX = mx + CFG.street / 2 + 1.9;
  for (let i = 0; i < 8; i += 1) {
    const z = ROAD_MIN_Z + 40 + i * 62;
    const s = i % 2 ? 1 : -1;
    ctx.spawnPoints.push({ x: mx + s * (CFG.street / 2 + 1.9), z, yaw: s > 0 ? Math.PI / 2 : -Math.PI / 2 });
  }
  for (let i = 0; i < 8; i += 1) {
    const x = ROAD_MIN_X + 40 + i * 62;
    const s = i % 2 ? 1 : -1;
    ctx.spawnPoints.push({ x, z: mz + s * (CFG.street / 2 + 1.9), yaw: s > 0 ? Math.PI : 0 });
  }
  // the coast and the two far ends of the boulevards, so a scripted scene can start anywhere
  ctx.spawnPoints.push({ x: offX, z: COAST_Z - CFG.bay / 2, yaw: Math.PI / 2 });
  ctx.spawnPoints.push({ x: 0, z: BAY_Z - 14, yaw: Math.PI });
  ctx.spawnPoints.push({ x: 0, z: PIER_Z - 4, yaw: Math.PI });
  ctx.spawnPoints.push({ x: streetLine(2) + CFG.block, z: mz + CFG.street / 2 + 1.9, yaw: Math.PI });
  ctx.spawnPoints.push({ x: streetLine(7) + CFG.block, z: mz - CFG.street / 2 - 1.9, yaw: 0 });
}

// ---- Instanced props: one InstancedMesh per repeated shape (palms, lamp posts, AO blobs) ----
function buildPalms(ctx, textures) {
  const count = ctx.palms.length;
  if (!count) return;
  // trunk: unit-height tapered cylinder, instanced with the palm's height as scale
  const tb = makeBuilder();
  pushCylinder(tb, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.06, 1, 0), 0.115, 0.075, 6);
  pushCylinder(tb, new THREE.Vector3(0, 0.92, 0), new THREE.Vector3(0, 1.02, 0), 0.09, 0.05, 6);
  const trunkGeo = finish(tb);

  // crown: nine fronds fanning out and drooping, one quad each, textured with the frond canvas.
  // The crown is authored with its base at local y = 0 so an instance can sit straight on the trunk top.
  const fb = makeBuilder();
  const segs = 9;
  const L = 5.4;
  const W = 2.4;
  for (let i = 0; i < segs; i += 1) {
    const a = (i / segs) * Math.PI * 2 + 0.3;
    const tilt = 0.30 + (i % 3) * 0.13;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    const cy = Math.cos(tilt);
    const sy = Math.sin(tilt);
    // frond axis r lifts off the horizontal by `tilt`, width axis u stays horizontal
    const rx = cosA * cy;
    const rz = sinA * cy;
    const ux = -sinA;
    const uz = cosA;
    const bx = 0;
    const by = (i % 2) * 0.07;
    const bz = 0;
    let nx = -cosA * sy;
    let ny = cy;
    let nz = -sinA * sy;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const hw = W / 2;
    const verts = [
      [bx - ux * hw, by, bz - uz * hw, 0, 0],
      [bx + rx * L - ux * hw, by + sy * L, bz + rz * L - uz * hw, 1, 0],
      [bx + rx * L + ux * hw, by + sy * L, bz + rz * L + uz * hw, 1, 1],
      [bx + ux * hw, by, bz + uz * hw, 0, 1],
    ];
    for (const k of QUAD_TRIS) {
      const [vx, vy, vz, uu, vv] = verts[k];
      fb.pos.push(vx, vy, vz);
      fb.nor.push(nx, ny, nz);
      fb.uv.push(uu, vv);
    }
  }
  // a solid crown centre: the boot of old fronds, wide enough to read as the hub the fronds fan from
  pushCylinder(fb, new THREE.Vector3(0, -0.16, 0), new THREE.Vector3(0, 0.34, 0), 0.34, 0.13, 7);
  const frondGeo = finish(fb);

  const trunkMat = new THREE.MeshStandardMaterial({ color: textures.colors.trunk, roughness: 0.94 });
  const frondMat = new THREE.MeshStandardMaterial({
    map: textures.frond, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide,
    roughness: 0.86, color: 0xd8e8c8,
  });

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  const crowns = new THREE.InstancedMesh(frondGeo, frondMat, count);
  const dummy = new THREE.Object3D();
  const baseY = 0.10;          // sunk a few cm into the sidewalk pad, so no trunk hovers over it
  ctx.palms.forEach((p, i) => {
    const tilt = p.lean * 0.5;
    const st = Math.sin(tilt);
    const ct = Math.cos(tilt);
    dummy.position.set(p.x, baseY, p.z);
    dummy.rotation.set(0, p.yaw, tilt);
    dummy.scale.set(p.scale, p.h, p.scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    // the trunk's own top (local 0.06, 1) after scale+lean, then the crown is set down on it
    const topX = p.x + (0.06 * p.scale * ct - p.h * st);
    const topY = baseY + p.h * ct;
    const crownScale = p.scale * (0.85 + p.h * 0.02);
    dummy.position.set(topX, topY + crownScale * 0.02, p.z);
    dummy.rotation.set(0, p.yaw, 0);
    dummy.scale.setScalar(crownScale);
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);
  });
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  trunks.castShadow = true;
  crowns.castShadow = true;
  crowns.receiveShadow = false;
  trunks.name = 'city-palm-trunks';
  crowns.name = 'city-palm-crowns';
  ctx.scene.add(trunks);
  ctx.scene.add(crowns);
}

function buildLamps(ctx, metalMat) {
  const count = ctx.lamps.length;
  if (!count) return;
  const b = makeBuilder();
  pushCylinder(b, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.45, 0), 0.22, 0.18, 7);
  pushCylinder(b, new THREE.Vector3(0, 0.45, 0), new THREE.Vector3(0, 7.0, 0), 0.11, 0.08, 6);
  pushBox(b, 0.9, 7.15, 0, 1.9, 0.14, 0.14);
  pushBox(b, 1.8, 6.95, 0, 0.8, 0.22, 0.42);
  const geo = finish(b);
  const mesh = new THREE.InstancedMesh(geo, metalMat, count);
  const dummy = new THREE.Object3D();
  ctx.lamps.forEach((l, i) => {
    dummy.position.set(l.x, Y_PAD, l.z);
    dummy.rotation.set(0, l.yaw, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    pushCollider(ctx, l.x - 0.2, l.x + 0.2, l.z - 0.2, l.z + 0.2, Y_PAD + 7.2);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.name = 'city-lamp-posts';
  ctx.scene.add(mesh);
}

function buildContactShadows(ctx, textures) {
  const count = ctx.ao.length;
  if (!count) return;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: textures.ao, transparent: true, depthWrite: false, opacity: 0.42, color: 0x000000,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const dummy = new THREE.Object3D();
  ctx.ao.forEach((a, i) => {
    dummy.position.set(a.cx, Y_PAD + 0.09, a.cz);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(a.sx * 1.45, 1, a.sz * 1.45);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 1;
  mesh.name = 'city-contact-shadows';
  ctx.scene.add(mesh);
}

function buildNeon(ctx) {
  for (const s of ctx.neon) pushNeon(ctx, s.x, s.y, s.z, 3.4, 3.0, s.yaw, s.cell);
}
