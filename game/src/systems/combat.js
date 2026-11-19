// Costa Lume — Rafa's guns: weapon data, the hitscan, recoil and the pickups a street can hold.
//
// Weapons are data, not code paths: fists, a 12-round pistol and a 30-round SMG, each with damage,
// rate, spread, range, magazine, reserve and reload time. `1`/`2`/`3` switch, the left button fires
// (held fire is the SMG's business), the right button aims over the shoulder through player.setAiming(),
// and `R` reloads. The HUD's weapon and ammo lines read `weapon` / `ammo` from here, mirrored by main.js.
//
// A shot is one ray from the eye. It is tested against the officers police.js owns, the pedestrians
// traffic.js owns, the civilian and police cars, and the city's solid boxes — nearest hit wins, so a
// wall in front of a pedestrian stops the round. Hits put dust in the air, metal throws sparks, and the
// tracer is drawn by systems/effects.js. Every shot adds heat on the police side and scatters the
// walkers inside FLEE_RADIUS through traffic.fleeFrom().
//
// Pickups stand in the world as small glowing crates — cash, health, armour, ammo — seeded onto the
// boulevard sidewalks and a few mission spots. Walking over one collects it with a HUD toast and starts
// a respawn timer, so the street keeps paying out.
import * as THREE from 'three';
import { createEffects, softDiscTexture } from './effects.js';

// ---------------------------------------------------------------------------------------------
// Weapon table. interval/rate are seconds; spread is radians of cone half-angle at the muzzle.
// ---------------------------------------------------------------------------------------------
export const WEAPONS = {
  fists: {
    name: 'Fists', slot: 1, melee: true,
    damage: 24, interval: 0.42, range: 2.2, spread: 0, bloom: 0, kick: 0.02,
    mag: 0, reserve: 0, reload: 0,
  },
  pistol: {
    name: 'Pistol', slot: 2, melee: false,
    damage: 26, interval: 0.24, range: 110, spread: 0.010, bloom: 0.010, kick: 0.045,
    mag: 12, reserve: 48, reload: 1.25,
  },
  smg: {
    name: 'SMG', slot: 3, melee: false,
    damage: 14, interval: 0.075, range: 80, spread: 0.026, bloom: 0.013, kick: 0.022,
    mag: 30, reserve: 120, reload: 1.9,
  },
};

export const WEAPON_ORDER = ['fists', 'pistol', 'smg'];

export const PICKUPS = {
  cash: { colour: 0x9fe36b, halo: 0x9fe36b, label: 'cash' },
  health: { colour: 0xf0664a, halo: 0xff8a6a, label: 'health' },
  armour: { colour: 0x5ec8f0, halo: 0x7fd8ff, label: 'armour' },
  ammo: { colour: 0xe8b96b, halo: 0xffd27a, label: 'ammo' },
};

const FLEE_RADIUS = 22;        // pedestrians inside this scatter when a shot goes off
const FLEE_HOLD = 2.8;
const PICKUP_REACH = 1.25;     // metres: walking this close collects
const PICKUP_RESPAWN = 42;     // seconds
const BLOOM_DECAY = 2.6;
const RECOIL_RECOVER = 7.5;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Ray vs sphere, y included: distance along the ray to the near surface, or -1.
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox;
  const ly = cy - oy;
  const lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return -1;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2 = r * r;
  if (d2 > r2) return -1;
  const thc = Math.sqrt(r2 - d2);
  const t0 = tca - thc;
  return t0 >= 0 ? t0 : tca + thc;
}

// Ray vs the city's solid boxes: a 2D slab test in plan, gated by the box height. -1 is a miss.
function rayBoxDistance(o, d, c, maxT) {
  let t0 = 0;
  let t1 = maxT;
  for (let axis = 0; axis < 2; axis += 1) {
    const org = axis ? o.z : o.x;
    const dir = axis ? d.z : d.x;
    const lo = axis ? c.minZ : c.minX;
    const hi = axis ? c.maxZ : c.maxX;
    if (Math.abs(dir) < 1e-8) {
      if (org < lo || org > hi) return -1;
      continue;
    }
    let a = (lo - org) / dir;
    let b = (hi - org) / dir;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  if (c.height !== undefined && o.y + d.y * t0 > c.height) return -1;   // over the roof
  if (t0 < 0.12) return -1;                                             // the muzzle is inside it
  return t0;
}

export function createCombat({ scene, camera, player, police, traffic, hud, rng, audio, city, game }) {
  const colliders = (city && city.colliders) || [];
  const effects = createCombatEffects(scene);

  const state = {
    weapon: 'fists',
    aiming: false,
    reloadT: 0,
    cooldown: 0,
    bloom: 0,
    recoil: 0,
    firing: false,
    mags: {
      pistol: WEAPONS.pistol.mag,
      smg: WEAPONS.smg.mag,
    },
    reserves: {
      pistol: WEAPONS.pistol.reserve,
      smg: WEAPONS.smg.reserve,
    },
    kills: 0,
    shots: 0,
  };

  // ---- mission targets --------------------------------------------------------------------------
  // systems/missions.js registers one provider: a function returning the hit spheres of whatever it
  // is fielding right now (Vela guards). The trace below treats them like any other body, so a shot
  // at a guard is the same raycast a shot at an officer is, and nothing here knows about missions.
  const targetProviders = [];

  // ---- pickups ----------------------------------------------------------------------------------
  const pickups = [];
  const crateGeo = new THREE.BoxGeometry(0.34, 0.34, 0.34);
  const crateMat = new THREE.MeshStandardMaterial({
    roughness: 0.45, metalness: 0.15, emissiveIntensity: 1.15, transparent: false,
  });
  const crates = new THREE.InstancedMesh(crateGeo, crateMat, 16);
  crates.name = 'pickups';
  crates.castShadow = false;
  crates.frustumCulled = false;
  if (scene) scene.add(crates);

  const disc = softDiscTexture();
  const halos = [];
  for (let i = 0; i < 16; i += 1) {
    const mat = new THREE.SpriteMaterial({
      map: disc, color: 0xffffff, transparent: true, opacity: 0.6,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
    });
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(1.15);
    s.visible = false;
    if (scene) scene.add(s);
    halos.push(s);
  }

  // Seed the street: every other legal spawn point gets a crate, plus the three mission spots the
  // design uses for drops. rng keeps the layout identical for a given seed.
  const SPOTS = [
    { kind: 'cash', x: -22, z: -108 },       // the Mercado drop
    { kind: 'health', x: -49.9, z: -172 },   // Playa Norte kerb
    { kind: 'ammo', x: -22.1, z: -48 },      // Avenida Sol, north walk
  ];
  const order = ['cash', 'health', 'armour', 'ammo'];
  const points = (city && city.spawnPoints) || [];
  for (let i = 0; i < points.length && pickups.length < 13; i += 2) {
    const p = points[i];
    const kind = order[(pickups.length + 1) % order.length];
    pickups.push(makePickup(kind, p.x + (rng() - 0.5) * 0.8, p.z + (rng() - 0.5) * 0.8));
  }
  for (const s of SPOTS) pickups.push(makePickup(s.kind, s.x, s.z));

  function makePickup(kind, x, z) {
    return {
      kind, x, z, y: 0.42,
      active: true, timer: 0, phase: rng() * Math.PI * 2,
      spin: rng() * Math.PI,
    };
  }

  // ---- weapon bookkeeping -------------------------------------------------------------------------
  function spec() { return WEAPONS[state.weapon] || WEAPONS.fists; }

  function ammoOf() {
    const w = spec();
    if (w.melee) return null;
    return { mag: state.mags[state.weapon], reserve: state.reserves[state.weapon] };
  }

  // `silent` is for the shot scenes: they dress the HUD without a toast landing in the frame.
  function select(key, silent = false) {
    const next = WEAPONS[key] ? key : null;
    if (!next || next === state.weapon) return state.weapon;
    state.weapon = next;
    state.reloadT = 0;
    state.cooldown = 0.12;
    state.bloom = 0;
    if (!silent && hud && hud.toast && !WEAPONS[next].melee) hud.toast(`Equipped: ${WEAPONS[next].name}`);
    return state.weapon;
  }

  function startReload() {
    const w = spec();
    if (w.melee || state.reloadT > 0) return false;
    const key = state.weapon;
    if (state.mags[key] >= w.mag || state.reserves[key] <= 0) return false;
    state.reloadT = w.reload;
    return true;
  }

  function finishReload() {
    const w = spec();
    const key = state.weapon;
    if (w.melee) return;
    const need = w.mag - state.mags[key];
    const take = Math.min(need, state.reserves[key]);
    state.mags[key] += take;
    state.reserves[key] -= take;
    if (audio && audio.reload) audio.reload();
  }

  // ---- aiming ---------------------------------------------------------------------------------------
  // The camera the player rig has already placed: yaw on .y, pitch on .x (YXZ), so the ray is the
  // camera's own forward vector, which is exactly where the reticle sits.
  const _fwd = new THREE.Vector3();
  const _origin = new THREE.Vector3();
  const _muzzle = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _end = new THREE.Vector3();

  function cameraForward(out) {
    if (!camera) { out.set(0, 0, -1); return out; }
    return camera.getWorldDirection(out);
  }

  function setAiming(on) {
    const next = !!on && player.onFoot;   // the over-shoulder aim is a walking stance
    if (next === state.aiming) return;
    state.aiming = next;
    if (player.setAiming) player.setAiming(next);
  }

  // ---- the shot --------------------------------------------------------------------------------------
  // Nearest thing the ray meets: a pedestrian, an officer, a car body or a wall.
  function traceShot(origin, dir, maxDist) {
    let best = { t: maxDist, kind: null, obj: null };
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;

    const officers = (police && police.officers) || [];
    for (const o of officers) {
      if (!o.alive) continue;
      const t = raySphere(ox, oy, oz, dir.x, dir.y, dir.z, o.x, o.y + 1.05, o.z, 0.46);
      if (t >= 0 && t < best.t) best = { t, kind: 'officer', obj: o };
    }

    for (const provider of targetProviders) {
      const list = provider();
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        if (!e || e.alive === false) continue;
        const radius = Number(e.radius) > 0 ? Number(e.radius) : 0.5;
        const t = raySphere(ox, oy, oz, dir.x, dir.y, dir.z, e.x, (e.y || 0) + 1.0, e.z, radius);
        if (t >= 0 && t < best.t) best = { t, kind: 'target', obj: e };
      }
    }

    const peds = (traffic && traffic.pedestrians) || [];
    for (const p of peds) {
      const t = raySphere(ox, oy, oz, dir.x, dir.y, dir.z, p.x, (p.y || 0) + 1.0, p.z, 0.42);
      if (t >= 0 && t < best.t) best = { t, kind: 'ped', obj: p };
    }

    const cars = [];
    for (const c of (traffic && traffic.cars) || []) if (!c.destroyed) cars.push(c);
    for (const c of (police && police.cruisers) || []) if (!c.destroyed) cars.push(c);
    for (const c of cars) {
      const t = raySphere(ox, oy, oz, dir.x, dir.y, dir.z, c.state.pos.x, 0.78, c.state.pos.z, c.width * 0.62);
      if (t >= 0 && t < best.t) best = { t, kind: 'car', obj: c };
    }

    for (let i = 0; i < colliders.length; i += 1) {
      const t = rayBoxDistance(origin, dir, colliders[i], best.t);
      if (t >= 0 && t < best.t) best = { t, kind: 'wall', obj: colliders[i] };
    }
    return best;
  }

  function fire() {
    if (state.cooldown > 0 || state.reloadT > 0) return false;
    const w = spec();
    if (w.melee) return punch();

    const key = state.weapon;
    if (state.mags[key] <= 0) {
      if (!startReload() && audio && audio.dry) audio.dry();
      return false;
    }

    state.mags[key] -= 1;
    state.cooldown = w.interval;
    state.shots += 1;

    // muzzle: just ahead of the eye and to the right, so the flash reads in a third-person frame
    cameraForward(_fwd);
    _right.set(_fwd.z, 0, -_fwd.x).normalize();
    _muzzle.copy(camera ? camera.position : player.position)
      .addScaledVector(_fwd, 0.62)
      .addScaledVector(_right, 0.17);
    _muzzle.y -= 0.12;

    // spread: the weapon's cone plus whatever the trigger has bloomed
    const cone = w.spread + state.bloom;
    const jx = (rng() - 0.5) * 2 * cone;
    const jy = (rng() - 0.5) * 2 * cone;
    const dir = {
      x: _fwd.x + _right.x * jx,
      y: _fwd.y + jy,
      z: _fwd.z + _right.z * jx,
    };
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    dir.x /= len; dir.y /= len; dir.z /= len;

    _origin.copy(camera ? camera.position : player.position);
    const hit = traceShot(_origin, dir, w.range);
    _end.set(_origin.x + dir.x * hit.t, _origin.y + dir.y * hit.t, _origin.z + dir.z * hit.t);

    effects.tracer(_muzzle, _end, 0xffe6b0, 0.035);
    effects.muzzle({ x: _muzzle.x, y: _muzzle.y, z: _muzzle.z }, 0xffc98a);

    if (hit.kind === 'officer') {
      effects.puff(_end, 0.5, 0xe4d6bd);
      if (police && police.damageOfficer) police.damageOfficer(hit.obj, w.damage);
      if (audio && audio.hit) audio.hit(0.5);
    } else if (hit.kind === 'target') {
      effects.puff(_end, 0.5, 0xe4d6bd);
      if (typeof hit.obj.hit === 'function') hit.obj.hit(w.damage);
      if (audio && audio.hit) audio.hit(0.6);
    } else if (hit.kind === 'ped') {
      effects.puff(_end, 0.55, 0xd8cbb6);
      killPedestrian(hit.obj);
    } else if (hit.kind === 'car') {
      effects.spark(_end, 0xffc46a);
      const car = hit.obj;
      car.damage(w.damage * 0.55);
      if (car.police && police && police.hitCruiser) police.hitCruiser(car, w.damage * 0.55);
      if (audio && audio.hit) audio.hit(0.25);
    } else if (hit.kind === 'wall') {
      effects.puff(_end, 0.45, 0xcfc4b0);
      if (rng() < 0.35) effects.spark(_end, 0xffd08a);
    }

    // heat, recoil, bloom, noise
    if (police && police.crime) police.crime('shot');
    if (traffic && traffic.fleeFrom) traffic.fleeFrom(_muzzle, FLEE_RADIUS, FLEE_HOLD);
    state.bloom = Math.min(0.11, state.bloom + w.bloom);
    state.recoil = Math.min(0.16, state.recoil + w.kick);
    if (audio && audio.gunshot) audio.gunshot(w.melee ? 0.2 : 1);
    return true;
  }

  // Fists: a short swing, a shove, and no tracer.
  function punch() {
    state.cooldown = WEAPONS.fists.interval;
    cameraForward(_fwd);
    const reach = WEAPONS.fists.range;
    _origin.copy(camera ? camera.position : player.position);
    const hit = traceShot(_origin, _fwd, reach);
    if (hit.kind === 'officer' && police && police.damageOfficer) {
      police.damageOfficer(hit.obj, WEAPONS.fists.damage);
      effects.puff({ x: _origin.x + _fwd.x * reach, y: _origin.y - 0.2, z: _origin.z + _fwd.z * reach }, 0.3, 0xe4d6bd);
      if (audio && audio.hit) audio.hit(0.3);
    } else if (hit.kind === 'target') {
      if (typeof hit.obj.hit === 'function') hit.obj.hit(WEAPONS.fists.damage);
      effects.puff({ x: _origin.x + _fwd.x * reach, y: _origin.y - 0.2, z: _origin.z + _fwd.z * reach }, 0.3, 0xe4d6bd);
      if (audio && audio.hit) audio.hit(0.3);
    } else if (hit.kind === 'ped') {
      killPedestrian(hit.obj);
    }
    if (police && police.crime) police.crime('shot');   // a brawl draws the same attention
    return true;
  }

  // A pedestrian taken out of the crowd: the array is traffic.js's, so the removal is announced to it.
  function killPedestrian(ped) {
    state.kills += 1;
    if (traffic && typeof traffic.removeWalker === 'function') traffic.removeWalker(ped);
    else if (traffic && Array.isArray(traffic.pedestrians)) {
      const i = traffic.pedestrians.indexOf(ped);
      if (i >= 0) traffic.pedestrians.splice(i, 1);
      if (traffic.refresh) traffic.refresh();
    }
    if (police && police.crime) police.crime('ped');
    if (audio && audio.hit) audio.hit(0.4);
  }

  // ---- pickups in the world ------------------------------------------------------------------------
  const _m4 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _pos = new THREE.Vector3();
  const _scale = new THREE.Vector3(1, 1, 1);

  function stepPickups(dt) {
    const p = player.position;
    let visible = 0;
    for (const pick of pickups) {
      if (!pick.active) {
        pick.timer -= dt;
        if (pick.timer <= 0) pick.active = true;
        continue;
      }
      pick.phase += dt * 1.6;
      const bob = Math.sin(pick.phase) * 0.07;
      const y = pick.y + bob;
      const halo = halos[visible];
      if (visible < halos.length) {
        halo.visible = true;
        halo.position.set(pick.x, y + 0.05, pick.z);
        halo.material.color.setHex(PICKUPS[pick.kind].halo);
        halo.material.opacity = 0.42 + 0.18 * Math.sin(pick.phase * 1.7);
      }
      _pos.set(pick.x, y, pick.z);
      _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pick.phase * 0.8);
      _m4.compose(_pos, _q, _scale);
      crates.setMatrixAt(visible, _m4);
      crates.setColorAt(visible, new THREE.Color(PICKUPS[pick.kind].colour));
      visible += 1;

      if (Math.hypot(p.x - pick.x, p.z - pick.z) < PICKUP_REACH && Math.abs(p.y - pick.y) < 2.2) {
        collect(pick);
      }
    }
    for (let i = visible; i < crates.count; i += 1) {
      _m4.makeScale(0, 0, 0);
      crates.setMatrixAt(i, _m4);
    }
    for (let i = visible; i < halos.length; i += 1) halos[i].visible = false;
    crates.instanceMatrix.needsUpdate = true;
    if (crates.instanceColor) crates.instanceColor.needsUpdate = true;
  }

  function collect(pick) {
    pick.active = false;
    pick.timer = PICKUP_RESPAWN;
    const kind = pick.kind;
    if (kind === 'cash') {
      const amount = 60 + Math.round(rng() * 140);
      if (game) game.money = (game.money || 0) + amount;
      if (hud) hud.toast(`+$${amount} picked up`);
    } else if (kind === 'health') {
      player.health = Math.min(100, player.health + 25);
      if (hud) hud.toast('Health +25');
    } else if (kind === 'armour') {
      player.armour = Math.min(100, player.armour + 25);
      if (hud) hud.toast('Armour +25');
    } else {
      state.reserves.pistol = Math.min(WEAPONS.pistol.reserve, state.reserves.pistol + 18);
      state.reserves.smg = Math.min(WEAPONS.smg.reserve, state.reserves.smg + 45);
      if (hud) hud.toast('Ammo restocked');
    }
    if (audio && audio.pickup) audio.pickup(kind);
  }

  // ---- input -----------------------------------------------------------------------------------------
  function onKeyDown(e) {
    if (!player.active) return;
    if (e.code === 'Digit1') { select('fists'); return; }
    if (e.code === 'Digit2') { select('pistol'); return; }
    if (e.code === 'Digit3') { select('smg'); return; }
    if (e.code === 'KeyR' && player.onFoot) startReload();
  }

  function onMouseDown(e) {
    if (!player.active) return;
    if (e.button === 0) { state.firing = true; fire(); return; }
    if (e.button === 2) { setAiming(true); return; }
  }

  function onMouseUp(e) {
    if (e.button === 0) state.firing = false;
    if (e.button === 2) setAiming(false);
  }

  function onBlur() {
    state.firing = false;
    setAiming(false);
  }

  function onContextMenu(e) {
    if (e && e.preventDefault) e.preventDefault();
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('contextmenu', onContextMenu);
  }

  // ---- frame -------------------------------------------------------------------------------------------
  function update(dt) {
    if (!dt || dt <= 0) return;
    const w = spec();
    if (state.cooldown > 0) state.cooldown = Math.max(0, state.cooldown - dt);
    if (state.reloadT > 0) {
      state.reloadT -= dt;
      if (state.reloadT <= 0) { state.reloadT = 0; finishReload(); }
    }
    state.bloom = Math.max(0, state.bloom - BLOOM_DECAY * dt * (state.aiming ? 1.5 : 1));

    // held fire: the SMG keeps talking, the pistol and fists need a fresh click
    if (state.firing && !w.melee && w.interval < 0.12) fire();

    // recoil kick: the rig has already written the camera this frame, so the kick is an offset that
    // decays back to zero instead of a value the next frame would have to undo
    if (state.recoil > 0.0005) {
      if (camera) {
        camera.rotation.x += state.recoil * (state.aiming ? 0.55 : 0.8);
        camera.position.y -= state.recoil * 0.35;
      }
      state.recoil *= Math.exp(-RECOIL_RECOVER * dt);
    } else {
      state.recoil = 0;
    }

    // aiming pulls the rig in; player.js owns the camera, this only asks
    if (state.aiming && (!player.active || !player.onFoot)) setAiming(false);

    stepPickups(dt);
    effects.update(dt);
  }

  const api = {
    get weapon() { return state.weapon; },
    get weaponName() { return spec().name; },
    get ammo() { return ammoOf(); },
    get aiming() { return state.aiming; },
    get reloading() { return state.reloadT > 0; },
    get shotsFired() { return state.shots; },
    get kills() { return state.kills; },
    get pickups() { return pickups; },

    select,
    fire,
    reload: startReload,
    setAiming,
    update,
    effects,

    // Missions hand in a provider that lists their hit spheres; the ray meets them like bodies.
    registerTargets(provider) {
      if (typeof provider === 'function' && !targetProviders.includes(provider)) targetProviders.push(provider);
      return targetProviders.length;
    },

    // Stage scenes and missions place their own crates.
    addPickup(kind, x, z) {
      const pick = makePickup(PICKUPS[kind] ? kind : 'ammo', x, z);
      pickups.push(pick);
      return pick;
    },

    // Both weapons' totals, for a save file: {pistol, smg} rounds carried.
    ammoSummary() {
      return {
        pistol: state.mags.pistol + state.reserves.pistol,
        smg: state.mags.smg + state.reserves.smg,
      };
    },

    // A loaded save restores what the player was carrying, magazines included.
    restoreAmmo(ammo) {
      if (!ammo || typeof ammo !== 'object') return;
      for (const key of ['pistol', 'smg']) {
        const spec = WEAPONS[key];
        const total = Math.max(0, Math.round(Number(ammo[key]) || 0));
        state.reserves[key] = Math.min(spec.reserve, total);
        state.mags[key] = Math.min(spec.mag, total);
      }
    },

    // Fill the reserve: a mission reward, a shop, a save file.
    giveAmmo(weapon, rounds) {
      if (!WEAPONS[weapon] || WEAPONS[weapon].melee) return;
      state.reserves[weapon] = Math.min(WEAPONS[weapon].reserve, state.reserves[weapon] + rounds);
    },

    dispose() {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('blur', onBlur);
        window.removeEventListener('contextmenu', onContextMenu);
      }
      if (scene) {
        scene.remove(crates);
        for (const h of halos) scene.remove(h);
      }
      crates.dispose();
      crateGeo.dispose();
      crateMat.dispose();
      for (const h of halos) h.material.dispose();
      effects.dispose();
    },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------
// The combat effects are the shared pool in systems/effects.js; this wrapper only owns the scene
// reference so dispose() has something to take back out.
// ---------------------------------------------------------------------------------------------
function createCombatEffects(scene) {
  const fx = createEffects(scene);
  const dispose = () => {
    if (scene) scene.remove(fx.group);
    fx.group.traverse((o) => {
      if (o.isMesh && o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m && m.dispose) m.dispose();
      }
    });
    if (fx.light) fx.light.dispose();
  };
  return { ...fx, dispose };
}
