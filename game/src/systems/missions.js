// Costa Lume — the story: five jobs for Mira Solano, their markers, guards, fail/retry and rewards.
//
// A mission is data: an ordered list of steps, each one kind of objective the street can already
// answer — get in a car, reach a spot on foot or on wheels, put down N Vela guards, shake a wanted
// level. The runtime below owns only three things: which step is live, the beacon the player walks
// toward, and the four guards a 'kill' step spawns. Everything else is the systems that already
// exist: player.js moves Rafa, combat.js traces his bullets, police.js answers his crimes.
//
// Coordinates are on the boulevards: the east walk of Avenida Sol (x ~ -22), the west walk, the
// asphalt of Calle Mercado and the coast road. Every marker sits on a sidewalk band or open asphalt
// the player can walk or drive to, never inside a building collider.
import * as THREE from 'three';
import { makeBuilder, pushBox, finish } from '../world/geometry.js';
import { mulberry32 } from '../util/rng.js';

const GOLD = 0xe8b96b;
// every guard's timing comes from here, so the same fight replays the same way
const rng = mulberry32(0x51a7c0de);
const GUARD_BODY = 0x6d2b33;
const GUARD_TRIM = 0x2c1a1d;
const CESAR_BODY = 0x3b2a4d;

// The chain. `heat` is the wanted level the job starts with (0 for a quiet one).
export const MISSIONS = [
  {
    id: 'first-fare',
    title: 'First Fare',
    brief: 'Mira needs a car moved off the Playa Norte strip before the Vela crew finds it.',
    heat: 0,
    reward: 350,
    start: { x: -22.1, z: -234, yaw: Math.PI },
    steps: [
      { kind: 'car', label: 'Steal a car — any set of wheels on the boulevard' },
      {
        kind: 'reach', label: 'Drive it to the Mercado drop', x: -22.1, z: -158, r: 9, car: true,
      },
    ],
  },
  {
    id: 'promenade-shake',
    title: 'Promenade Shake',
    brief: 'Three stallholders on the Playa Norte promenade owe Mira. Collect, on foot.',
    heat: 0,
    reward: 450,
    start: { x: -22.1, z: -306, yaw: 0 },
    steps: [
      { kind: 'reach', label: 'Collect at the first stall', x: -22.1, z: -306, r: 4.5, foot: true, stall: true },
      { kind: 'reach', label: 'Collect at the second stall', x: -22.1, z: -280, r: 4.5, foot: true, stall: true },
      { kind: 'reach', label: 'Collect at the third stall', x: -22.1, z: -254, r: 4.5, foot: true, stall: true },
    ],
  },
  {
    id: 'harbour-run',
    title: 'Harbour Run',
    brief: 'Crates for the pier. The patrol picked up the tip, so drive fast and lose them after.',
    heat: 2,
    reward: 600,
    start: { x: -22.1, z: -158, yaw: 0 },
    steps: [
      { kind: 'car', label: 'Get a car and load up' },
      { kind: 'reach', label: 'Run the crates to the pier gate', x: 0, z: -330, r: 12, car: true },
      { kind: 'escape', label: 'Lose the police before they box you in' },
    ],
  },
  {
    id: 'the-ledger',
    title: 'The Ledger',
    brief: 'The Vela crew keeps its books at the Mercado. Four guards, one ledger, no witnesses.',
    heat: 0,
    reward: 800,
    start: { x: -236.5, z: -72, yaw: -Math.PI / 2 },
    steps: [
      { kind: 'reach', label: 'Meet the contact at the Mercado market', x: -236.5, z: -72, r: 7, foot: true },
      {
        kind: 'kill', label: 'Take out the Vela guards', count: 4,
        ring: [
          { x: -248, z: -88 }, { x: -248, z: -72 }, { x: -248, z: -56 }, { x: -256, z: -64 },
        ],
      },
      { kind: 'reach', label: 'Grab the ledger from the stall', x: -236.5, z: -72, r: 4, foot: true },
    ],
  },
  {
    id: 'last-sunset',
    title: 'Last Sunset',
    brief: 'Cesar Vela is at the Colinas lookout with three men. Mira wants the debt closed tonight.',
    heat: 0,
    reward: 1200,
    start: { x: -22.1, z: 200, yaw: Math.PI },
    steps: [
      { kind: 'reach', label: 'Drive up to Colinas Altas', x: -22.1, z: 200, r: 9 },
      {
        kind: 'kill', label: 'Take down Cesar and his crew', count: 4, cesar: true,
        ring: [
          { x: -44, z: 194 }, { x: -44, z: 210 }, { x: -32, z: 194 }, { x: -32, z: 210 },
        ],
      },
      { kind: 'escape', label: 'Lose the heat and get out of Colinas', escape: 2 },
    ],
  },
];

// =============================================================================================
// Prop and guard geometry, built once
// =============================================================================================
function guardParts() {
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  return {
    torso: box(0.62, 0.78, 0.36),
    hips: box(0.5, 0.24, 0.32),
    head: box(0.28, 0.3, 0.28),
    arm: box(0.16, 0.62, 0.18),
    leg: box(0.2, 0.86, 0.22),
    gun: box(0.44, 0.09, 0.1),
  };
}

export function createMissions({
  scene, city, player, hud, police, combat, audio, game = null,
  onComplete = null, onFail = null, onAdvance = null,
}) {
  const colliders = (city && city.colliders) || [];
  const root = new THREE.Group();
  root.name = 'mission-props';
  if (scene) scene.add(root);

  const parts = guardParts();
  const matBody = new THREE.MeshStandardMaterial({ color: GUARD_BODY, roughness: 0.82 });
  const matTrim = new THREE.MeshStandardMaterial({ color: GUARD_TRIM, roughness: 0.7 });
  const matSkin = new THREE.MeshStandardMaterial({ color: 0xc49a7c, roughness: 0.85 });
  const matCesar = new THREE.MeshStandardMaterial({ color: CESAR_BODY, roughness: 0.6, metalness: 0.15 });
  const matGold = new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.4, metalness: 0.4 });

  // ---- beacon: a gold disc on the ground and a soft column you can see down the boulevard ----
  const beacon = new THREE.Group();
  beacon.name = 'mission-beacon';
  const discGeo = new THREE.RingGeometry(1.5, 1.9, 32);
  const discMat = new THREE.MeshBasicMaterial({
    color: GOLD, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false,
  });
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.06;
  const colGeo = new THREE.CylinderGeometry(0.55, 1.5, 22, 14, 1, true);
  const colMat = new THREE.MeshBasicMaterial({
    color: GOLD, transparent: true, opacity: 0.12, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const column = new THREE.Mesh(colGeo, colMat);
  column.position.y = 11;
  beacon.add(disc, column);
  beacon.visible = false;
  root.add(beacon);

  let beaconPhase = 0;

  // ---- stall props for the promenade job (one merged mesh per material) ----------------------
  let stallGroup = null;
  const stallWood = new THREE.MeshStandardMaterial({ color: 0x7a5433, roughness: 0.9 });
  const stallCloth = new THREE.MeshStandardMaterial({ color: 0x37a3a0, roughness: 0.95 });

  function clearStalls() {
    if (!stallGroup) return;
    root.remove(stallGroup);
    stallGroup.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    stallGroup = null;
  }

  function buildStalls(points) {
    clearStalls();
    if (!points.length) return;
    const wood = makeBuilder();
    const cloth = makeBuilder();
    for (const p of points) {
      // a counter, two posts and a striped awning, set back from the kerb so the walk stays clear
      pushBox(wood, p.x, 0.55, p.z, 2.6, 1.0, 1.4);
      pushBox(wood, p.x - 1.2, 1.15, p.z, 0.12, 2.3, 0.12);
      pushBox(wood, p.x + 1.2, 1.15, p.z, 0.12, 2.3, 0.12);
      pushBox(cloth, p.x, 2.35, p.z, 3.1, 0.12, 2.0);
      pushBox(cloth, p.x, 2.05, p.z + 1.02, 3.1, 0.34, 0.1);
    }
    stallGroup = new THREE.Group();
    stallGroup.name = 'mission-stalls';
    const wm = new THREE.Mesh(finish(wood), stallWood);
    const cm = new THREE.Mesh(finish(cloth), stallCloth);
    for (const m of [wm, cm]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      stallGroup.add(m);
    }
    root.add(stallGroup);
  }

  // ---- guards --------------------------------------------------------------------------------
  const guards = [];
  let killed = 0;
  let killTarget = 0;

  function makeGuard(spec, cesar = false) {
    const g = new THREE.Group();
    const torso = new THREE.Mesh(parts.torso, cesar ? matCesar : matBody);
    torso.position.y = 1.16;
    const hips = new THREE.Mesh(parts.hips, matTrim);
    hips.position.y = 0.72;
    const head = new THREE.Mesh(parts.head, matSkin);
    head.position.y = 1.71;
    const armL = new THREE.Mesh(parts.arm, cesar ? matCesar : matBody);
    armL.position.set(-0.39, 1.14, 0);
    const armR = new THREE.Mesh(parts.arm, cesar ? matCesar : matBody);
    armR.position.set(0.39, 1.14, 0);
    const legL = new THREE.Mesh(parts.leg, matTrim);
    legL.position.set(-0.16, 0.43, 0);
    const legR = new THREE.Mesh(parts.leg, matTrim);
    legR.position.set(0.16, 0.43, 0);
    const gun = new THREE.Mesh(parts.gun, cesar ? matGold : matTrim);
    gun.position.set(0.4, 1.12, -0.3);
    g.add(torso, hips, head, armL, armR, legL, legR, gun);
    g.position.set(spec.x, 0, spec.z);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    root.add(g);
    return {
      x: spec.x, z: spec.z, group: g,
      health: cesar ? 180 : 90, maxHealth: cesar ? 180 : 90,
      alive: true, cesar: !!cesar, fireT: 0.6 + rng() * 0.7, flash: 0,
      walkPhase: 0,
    };
  }

  function spawnGuards(step) {
    clearGuards();
    const ring = Array.isArray(step.ring) ? step.ring : [];
    killed = 0;
    killTarget = step.count || ring.length;
    ring.forEach((p, i) => {
      const cesar = !!step.cesar && i === ring.length - 1;
      guards.push(makeGuard(p, cesar));
    });
  }

  function clearGuards() {
    for (const g of guards) {
      root.remove(g.group);
    }
    guards.length = 0;
    killed = 0;
    killTarget = 0;
  }

  function damageGuard(guard, amount) {
    if (!guard || !guard.alive) return false;
    guard.health -= amount;
    guard.flash = 0.12;
    if (guard.health <= 0) {
      guard.alive = false;
      guard.group.visible = false;
      killed += 1;
      if (audio && audio.hit) audio.hit(0.7);
      if (hud && hud.toast) {
        hud.toast(guard.cesar ? 'Cesar Vela is down' : `Vela guard down (${killed}/${killTarget})`);
      }
      return true;
    }
    return false;
  }

  // combat.js asks this for every shot: a flat list of hit spheres the ray can meet.
  function guardTargets() {
    const out = [];
    for (const g of guards) {
      if (!g.alive) continue;
      out.push({
        x: g.x, y: 0.9, z: g.z, radius: 0.62, alive: true,
        kind: 'guard',
        hit: (dmg) => damageGuard(g, dmg),
      });
    }
    return out;
  }

  function stepGuards(dt) {
    if (!guards.length) return;
    const px = player.position.x;
    const pz = player.position.z;
    for (const g of guards) {
      if (!g.alive) continue;
      if (g.flash > 0) g.flash = Math.max(0, g.flash - dt);
      const dx = px - g.x;
      const dz = pz - g.z;
      const d = Math.hypot(dx, dz) || 1;
      const toward = Math.atan2(dx, dz);
      g.group.rotation.y = toward;
      if (d > 3.4) {
        const speed = g.cesar ? 2.2 : 2.7;
        const nx = g.x + (dx / d) * speed * dt;
        const nz = g.z + (dz / d) * speed * dt;
        if (!blocked(nx, nz)) { g.x = nx; g.z = nz; }
        g.walkPhase += dt * 6;
        g.group.position.y = Math.abs(Math.sin(g.walkPhase)) * 0.05;
      }
      g.group.position.x = g.x;
      g.group.position.z = g.z;

      g.fireT -= dt;
      if (g.fireT <= 0 && d < 34) {
        g.fireT = (g.cesar ? 1.1 : 1.5) + rng() * 0.4;
        fireAtPlayer(g, d);
      }
    }
  }

  function fireAtPlayer(g, d) {
    const px = player.position.x;
    const pz = player.position.z;
    const from = { x: g.x, y: 1.15, z: g.z };
    const to = { x: px, y: player.position.y + 1.1, z: pz };
    // a tracer for the eye, then the roll: nearer and more accurate, further and wilder
    if (combat && combat.effects && combat.effects.tracer) {
      combat.effects.tracer(
        new THREE.Vector3(from.x, from.y, from.z),
        new THREE.Vector3(to.x, to.y, to.z),
        0xffd08a, 0.03,
      );
    }
    if (audio && audio.gunshot) audio.gunshot(0.35);
    const chance = d < 12 ? 0.75 : d < 24 ? 0.5 : 0.3;
    if (rng() < chance) {
      const dmg = (g.cesar ? 9 : 6) * (0.7 + rng() * 0.6);
      player.damage(dmg);
      if (audio && audio.hit) audio.hit(0.3);
    }
    if (combat && combat.effects && combat.effects.puff) {
      combat.effects.puff(new THREE.Vector3(to.x, to.y, to.z), 0.3, 0xcfc4b0);
    }
  }

  // Guards keep to open ground: the same collider list the player walks against, so one never
  // walks into a market stall or a hotel wall.
  function blocked(x, z) {
    const r = 0.45;
    for (let i = 0; i < colliders.length; i += 1) {
      const c = colliders[i];
      if (c.height !== undefined && c.height < 0.9) continue;
      if (x + r > c.minX && x - r < c.maxX && z + r > c.minZ && z - r < c.maxZ) return true;
    }
    return false;
  }

  // ---- mission state -------------------------------------------------------------------------
  let index = 0;
  let step = 0;
  let running = false;
  let failed = false;
  let finished = false;
  let escapeArmed = false;
  let completed = [];
  let missionTimer = 0;

  const mission = () => MISSIONS[index] || null;
  const stepNow = () => {
    const m = mission();
    return m ? m.steps[step] : null;
  };

  function beginStep() {
    const s = stepNow();
    if (!s) return;
    escapeArmed = false;
    if (s.kind === 'kill') spawnGuards(s);
    else clearGuards();
    // an escape step with a number on it starts the pursuit the player then has to shake
    if (s.kind === 'escape' && s.escape && police && police.setStars) police.setStars(s.escape);
    if (s.stall) {
      const m = mission();
      buildStalls(m.steps.filter((x) => x.stall).map((x) => ({ x: x.x, z: x.z })));
    } else {
      clearStalls();
    }
  }

  function setBeacon(s) {
    if (!s || s.kind === 'car' || s.kind === 'escape' || s.kind === 'kill') {
      beacon.visible = false;
      return;
    }
    const x = Number.isFinite(s.x) ? s.x : player.position.x;
    const z = Number.isFinite(s.z) ? s.z : player.position.z;
    beacon.position.set(x, 0, z);
    beacon.visible = true;
    beacon.scale.setScalar(s.r && s.r > 6 ? 1.35 : 1);
  }

  function objectiveText() {
    const m = mission();
    const s = stepNow();
    if (!m || !s) return 'Free roam — Costa Lume is yours';
    if (s.kind === 'kill') return `${s.label} (${killed}/${killTarget})`;
    return s.label;
  }

  function publish() {
    const m = mission();
    const s = stepNow();
    if (!game) return;
    if (!m) {
      game.mission = { id: 'free-roam', title: 'Costa Lume', objective: 'Free roam — the story is done', marker: null };
      return;
    }
    game.mission = {
      id: m.id,
      title: m.title,
      objective: objectiveText(),
      marker: s && Number.isFinite(s.x) ? { x: s.x, z: s.z } : null,
    };
  }

  function advance() {
    const s = stepNow();
    const m = mission();
    if (!s || !m) return;
    if (step + 1 < m.steps.length) {
      step += 1;
      beginStep();
      setBeacon(stepNow());
      publish();
      if (hud && hud.toast) hud.toast(`Objective: ${objectiveText()}`);
      if (onAdvance) onAdvance(snapshot());
      return;
    }
    finishMission();
  }

  function finishMission() {
    const m = mission();
    if (!m) return;
    const reward = m.reward || 0;
    if (game) game.money = (game.money || 0) + reward;
    if (!completed.includes(m.id)) completed.push(m.id);
    clearGuards();
    clearStalls();
    beacon.visible = false;
    running = false;
    if (hud && hud.toast) hud.toast(`Mission complete: ${m.title}  +$${reward}`);
    if (audio && audio.missionComplete) audio.missionComplete();
    if (onComplete) onComplete(snapshot());
    index += 1;
    if (index >= MISSIONS.length) {
      finished = true;
      publish();
      if (hud && hud.banner) hud.banner('SUNSET', 'Costa Lume — story complete, free roam');
      return;
    }
    // the next job starts at once, with its first marker on the map
    step = 0;
    failed = false;
    running = true;
    beginStep();
    setBeacon(stepNow());
    publish();
    if (hud && hud.toast) hud.toast(`New job: ${MISSIONS[index].title}`);
  }

  function fail(reason) {
    if (!running || failed) return;
    failed = true;
    if (hud && hud.banner) hud.banner('MISSION FAILED', `${reason} — Enter to retry`);
    if (audio && audio.missionFail) audio.missionFail();
    clearGuards();
    if (onFail) onFail({ index, reason });
  }

  function start(i = 0, opts = {}) {
    index = Math.max(0, Math.min(MISSIONS.length - 1, Math.round(Number(i) || 0)));
    completed = Array.isArray(opts.completed) ? opts.completed.slice(0, 16) : [];
    step = 0;
    failed = false;
    finished = false;
    running = true;
    missionTimer = 0;
    const m = mission();
    if (!m) return;
    if (opts.teleport !== false) {
      const at = m.start || m.steps[0];
      if (at && Number.isFinite(at.x)) player.teleport(at.x, at.z, at.yaw || 0);
    }
    if (police) {
      if (police.clear) police.clear();
      if (m.heat) police.setStars(m.heat);
    }
    if (opts.step && opts.step > 0 && opts.step < m.steps.length) step = opts.step;
    beginStep();
    setBeacon(stepNow());
    publish();
    if (hud && hud.toast) hud.toast(`Mission: ${m.title}`);
  }

  // Resume from a validated save: the job, the step inside it, and the finished flag. The player is
  // placed by main.js from the same save, so this never teleports.
  function restore(snap) {
    if (!snap || typeof snap !== 'object') return false;
    const at = Math.max(0, Math.min(MISSIONS.length, Math.round(Number(snap.mission) || 0)));
    completed = Array.isArray(snap.completed) ? snap.completed.filter((s) => typeof s === 'string').slice(0, 16) : [];
    if (snap.finished || at >= MISSIONS.length) {
      index = MISSIONS.length - 1;
      finished = true;
      running = false;
      step = 0;
      failed = false;
      clearGuards();
      clearStalls();
      beacon.visible = false;
      publish();
      return true;
    }
    start(at, { completed, teleport: false, step: Math.round(Number(snap.step) || 0) });
    return true;
  }

  function retry() {
    if (finished) return false;
    const m = mission();
    if (!m) return false;
    if (player.health < 100) player.health = 100;
    if (player.armour < 30) player.armour = 30;
    start(index, { completed, teleport: true });
    if (hud && hud.clearBanner) hud.clearBanner();
    return true;
  }

  function update(dt) {
    if (!dt || dt <= 0) return;
    beaconPhase += dt;
    if (beacon.visible) {
      beacon.rotation.y = beaconPhase * 0.6;
      discMat.opacity = 0.62 + Math.sin(beaconPhase * 2.4) * 0.22;
      column.material.opacity = 0.09 + Math.sin(beaconPhase * 1.7) * 0.035;
    }
    stepGuards(dt);
    if (!running || failed || finished) return;
    missionTimer += dt;
    const s = stepNow();
    if (!s) return;

    // a wasted Rafa fails the job he is on
    if (player.health <= 0) { fail('Rafa went down'); return; }

    const px = player.position.x;
    const pz = player.position.z;
    const inCar = !!player.car && !player.onFoot;

    if (s.kind === 'car') {
      if (inCar) advance();
    } else if (s.kind === 'reach') {
      const d = Math.hypot(px - s.x, pz - s.z);
      const carOk = s.car ? inCar : true;
      const footOk = s.foot ? !inCar : true;
      if (d <= (s.r || 6) && carOk && footOk) advance();
    } else if (s.kind === 'kill') {
      if (killed >= killTarget) advance();
      else publish();
    } else if (s.kind === 'escape') {
      const stars = police ? police.stars : 0;
      if (stars > 0) escapeArmed = true;
      if (escapeArmed && stars === 0) advance();
    }
  }

  // ---- save / load ---------------------------------------------------------------------------
  function snapshot() {
    return { mission: index, step, completed: completed.slice(), finished };
  }

  // points the map and the minimap draw: the live step plus the ones after it
  function route() {
    const m = mission();
    if (!m || finished) return [];
    const out = [];
    for (let i = step; i < m.steps.length; i += 1) {
      const s = m.steps[i];
      if (s && Number.isFinite(s.x) && Number.isFinite(s.z)) {
        out.push({ x: s.x, z: s.z, label: s.label, current: i === step });
      }
    }
    return out;
  }

  return {
    root,
    get index() { return index; },
    get step() { return step; },
    get mission() { return mission(); },
    get objective() { return objectiveText(); },
    get running() { return running; },
    get failed() { return failed; },
    get finished() { return finished; },
    get completed() { return completed.slice(); },
    get killed() { return killed; },
    get killTarget() { return killTarget; },
    get guards() { return guards; },

    start,
    restore,
    retry,
    update,
    publish,
    fail,
    snapshot,
    route,
    guardTargets,
    // a mission ends where the story ends; the pause menu reads this for the save block
    get summary() {
      return {
        index, step, finished,
        title: mission() ? mission().title : 'Free roam',
        done: completed.length,
        total: MISSIONS.length,
      };
    },
  };
}
