// Costa Lume — Rafa Duarte on foot, and at the wheel.
//
// createPlayer({ scene, camera, city, dom }) builds a stylised 1.8 m figure out of boxes, drives it with
// camera-relative WASD input, resolves circle-vs-AABB collisions against city.colliders (one axis at a
// time so walls slide, with a step-up allowance for kerb-height solids) and owns the third-person
// camera: over the right shoulder, 3 m back and ~1.6 m up, spring follow with a small lag, a speed
// FOV widen while sprinting, and a sweep that pulls the rig in when a wall sits between player and lens.
//
// Driving lives here too. setTraffic() hands over the car pool; F takes the nearest car within 4 m,
// hides the figure, and swaps the rig for a chase camera that springs behind the car and leads it
// with look-ahead, or — on C — a hood camera welded to the nose. The chassis itself is stepped by
// entities/vehicles.js stepCar(), so the player's car and the AI cars share one physics feel. F again
// steps Rafa out on whichever side of the car is not the road, with the car's ground clearance
// checked against city.colliders first.
//
// The game reads: object, position, velocity, health, armour, onFoot, car, cameraMode (plus speed /
// walking / sprinting / heading for the HUD and the audio). Stage 3 writes health and armour and
// calls damage(); respawn rules stay in main.js. No Math.random, no network, no files, no textures.
//
// Yaw convention (shared with the camera and every car): yaw 0 looks down -Z, forward is
// (-sin yaw, 0, -cos yaw), the direction Object3D.getWorldDirection reports. The figure's boxes are
// modelled facing local +Z, so the group carries yaw + PI: the player faces where the camera looks.
import * as THREE from 'three';
import { SUN_DIR } from '../world/sky.js';
import { stepCar, nearestCar } from './vehicles.js';

// Tuning (metres, seconds).
export const PLAYER = {
  height: 1.8, eye: 1.62, radius: 0.32,
  walk: 4.2, run: 7.2, accel: 28, decel: 20, overSpeedDrag: 7,  // m/s, m/s^2; drag bleeds a sprint
  turnRate: 11,       // body yaw chase rate
  jump: 5.4,          // m/s -> ~0.97 m rise
  gravity: 15,
  stepUp: 0.18,       // kerb height: anything lower is walked over, not blocked
  maxSlice: 0.35,     // longest move resolved in one pass; longer moves are split (no tunnelling)
  airControl: 0.34,
  camBack: 3.0, camAnchorY: 1.45, camShoulder: 0.72,  // behind, orbit height at the chest, over-shoulder
  camLagXZ: 18, camLagY: 10, camRadius: 0.28,
  camHide: 0.55,      // hide the figure when the lens is squeezed closer than this
  fovSprint: 6,       // degrees added at full sprint
  // aiming down the barrel (systems/combat.js asks for this): tighter rig, narrower lens, slower feet
  aimBack: 2.05, aimShoulder: 0.62, aimAnchorY: 1.50, aimFov: -11, aimSpeed: 0.55,
  pitchMin: -0.72, pitchMax: 0.95,
  hipY: 0.95,
  // driving: chase rig behind the car, hood cam welded to the nose
  carReach: 4.0,          // F reaches a car this far away
  chaseBack: 7.4, chaseUp: 2.95, chaseLead: 5.5,
  chaseLag: 6.5, chaseLagY: 5.0,
  hoodUp: 1.02, hoodFwd: 0.9,
  drivePitchMin: -0.55, drivePitchMax: 0.30,
  fovDrive: 9,            // degrees added at the car's top speed
  exitGap: 2.3,           // how far beside the car Rafa steps out
  hitRecover: 0.85,       // seconds of stagger after a car clips him
};

const KEYMAP = {
  KeyW: 'forward', KeyA: 'left', KeyS: 'back', KeyD: 'right',
  Space: 'jump', ShiftLeft: 'shift', ShiftRight: 'shift',
};

// A second requestPointerLock while one is pending is a console error in Chrome; one slot is enough.
let lockPending = false;

export function createPlayer({ scene, camera, city, dom }) {
  const canvas = dom || (typeof document !== 'undefined' ? document.body : null);
  const doc = (canvas && canvas.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  const view = (camera && camera.isPerspectiveCamera) ? camera : null;
  const colliders = city && Array.isArray(city.colliders) ? city.colliders : [];
  const bounds = (city && city.bounds) || { minX: -420, maxX: 420, minZ: -420, maxZ: 620 };
  const fovBase = view ? view.fov : 62;

  // ---- state the game touches -------------------------------------------------------------
  const position = new THREE.Vector3(0, 0, 0);   // feet, the figure group's origin
  const velocity = new THREE.Vector3();          // m/s, horizontal + vertical
  const keys = { forward: 0, back: 0, left: 0, right: 0, jump: 0, shift: 0 };
  const state = {
    active: false, onFoot: true, onGround: true, sprint: false,
    yaw: 0,                 // look/facing heading
    camYaw: 0,
    camPitch: -0.06,
    speed: 0,               // horizontal speed, m/s
    step: 0,                // distance walked, drives the cycle phase
    distance: 0,            // total distance
    t: 0, idle: 0,
    sway: 0, glance: 0,     // eased idle amplitudes
    land: 0,                // 0..1 landing squash, decays
    airTime: 0,
    fov: fovBase,
    car: null,              // the Car the player is holding, if any
    cameraMode: 'chase',    // chase | hood
    aiming: false,          // over-shoulder stance, set by systems/combat.js
    stun: 0,                // seconds of knock-back left
    shake: 0,               // camera shake from a collision
    driveYaw: 0,            // smoothed car heading the chase rig follows
  };

  const figure = buildFigure();
  const object = figure.group;
  object.position.copy(position);
  if (scene) scene.add(object);

  // The car pool comes from systems/traffic.js through setTraffic(); the player never spawns traffic.
  let traffic = null;
  const carsOf = () => (traffic && Array.isArray(traffic.cars) ? traffic.cars : []);

  // camera scratch, allocated once
  const anchor = new THREE.Vector3();
  const ideal = new THREE.Vector3();
  const smoothed = new THREE.Vector3();
  const rayDir = new THREE.Vector3();
  const wish = new THREE.Vector3();
  const facing = new THREE.Vector3();
  const towardSun = new THREE.Vector3(-SUN_DIR.x, 0, -SUN_DIR.z).normalize();
  let snapCam = true;

  placeFigure(0);

  // ==============================================================================================
  // Ground and collision
  // ==============================================================================================

  // Highest solid top under the player's circle that is no more than one step above the feet, else the
  // street (y = 0) or the sand strip south of the last road (y = 0.12). city.js draws its sidewalk pads
  // without colliders, so in practice this returns the street; the rule is what lets a 0.18 m kerb be
  // walked up rather than blocking when a pad does carry a collider.
  function groundHeight(x, z, feetY) {
    const r = PLAYER.radius;
    let g = 0;
    for (let i = 0; i < colliders.length; i += 1) {
      const c = colliders[i];
      const h = c.height;
      if (h === undefined || h <= g || h > feetY + PLAYER.stepUp) continue;
      if (x + r <= c.minX || x - r >= c.maxX || z + r <= c.minZ || z - r >= c.maxZ) continue;
      g = h;
    }
    if (g === 0 && z < -302) g = 0.12;
    return g;
  }

  // First solid the circle would penetrate, ignoring anything low enough to step over.
  function solidAt(x, z, feetY) {
    const r = PLAYER.radius;
    for (let i = 0; i < colliders.length; i += 1) {
      const c = colliders[i];
      if (c.maxX <= x - r || c.minX >= x + r || c.maxZ <= z - r || c.minZ >= z + r) continue;
      if (c.height !== undefined && c.height <= feetY + PLAYER.stepUp) continue;
      return c;
    }
    return null;
  }

  // One axis at a time: a diagonal into a wall keeps the other axis, so the player slides along it.
  function resolveCollisions(dx, dz) {
    const r = PLAYER.radius;
    const feetY = position.y;
    if (dx) {
      const ox = position.x;
      const nx = ox + dx;
      const c = solidAt(nx, position.z, feetY);
      // clamp only when the face is ahead of us; if we already overlap, walk out instead of snapping
      const bound = c ? (dx > 0 ? c.minX - r - 1e-4 : c.maxX + r + 1e-4) : 0;
      if (c && (dx > 0 ? bound >= ox - 1e-3 : bound <= ox + 1e-3)) {
        position.x = bound;
        if (velocity.x * dx > 0) velocity.x = 0;
      } else {
        position.x = nx;
      }
    }
    if (dz) {
      const oz = position.z;
      const nz = oz + dz;
      const c = solidAt(position.x, nz, feetY);
      const bound = c ? (dz > 0 ? c.minZ - r - 1e-4 : c.maxZ + r + 1e-4) : 0;
      if (c && (dz > 0 ? bound >= oz - 1e-3 : bound <= oz + 1e-3)) {
        position.z = bound;
        if (velocity.z * dz > 0) velocity.z = 0;
      } else {
        position.z = nz;
      }
    }
    if (position.x < bounds.minX + r) { position.x = bounds.minX + r; velocity.x = 0; }
    if (position.x > bounds.maxX - r) { position.x = bounds.maxX - r; velocity.x = 0; }
    if (position.z < bounds.minZ + r) { position.z = bounds.minZ + r; velocity.z = 0; }
    if (position.z > bounds.maxZ - r) { position.z = bounds.maxZ - r; velocity.z = 0; }
  }

  // A long step (sprint plus a frame hitch) is cut into slices shorter than any street prop, each one
  // re-testing the colliders, so nothing tunnels through a lamp post or a palm trunk.
  function moveWithCollision(dx, dz) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return 0;
    const slices = Math.min(12, Math.max(1, Math.ceil(len / PLAYER.maxSlice)));
    let sx = dx / slices;
    let sz = dz / slices;
    let travelled = 0;
    for (let i = 0; i < slices; i += 1) {
      const mx = position.x;
      const mz = position.z;
      resolveCollisions(sx, sz);
      travelled += Math.hypot(position.x - mx, position.z - mz);
      if (Math.abs(position.x - mx) < Math.abs(sx) * 0.5) sx = 0;   // wall on x: slide on z
      if (Math.abs(position.z - mz) < Math.abs(sz) * 0.5) sz = 0;
      if (!sx && !sz) break;
    }
    return travelled;
  }

  // ==============================================================================================
  // Cars: take one, drive it, step out
  // ==============================================================================================

  // Is this spot asphalt? Read off the street graph so the exit checker never invents a road.
  function onRoadway(x, z) {
    const graph = (city && city.roadGraph) || {};
    for (const s of graph.streets || []) {
      const half = 12.2;         // 24 m carriageway
      if (s.axis === 'z') {
        if (Math.abs(x - s.centre) <= half && z >= s.from && z <= s.to) return true;
      } else if (Math.abs(z - s.centre) <= half && x >= s.from && x <= s.to) return true;
    }
    return false;
  }

  function carAt(x, z, reach) {
    const list = carsOf();
    if (!list.length) return null;
    const hit = nearestCar(list, x, z, reach);
    if (hit && hit.driver === null) return hit;      // parked: fair game
    if (hit && hit.driver === 'ai') return hit;      // steal it out of traffic, GTA-style
    return hit;
  }

  function tryEnterCar() {
    const car = carAt(position.x, position.z, PLAYER.carReach);
    if (!car || car.destroyed) return false;
    doEnterCar(car);
    return true;
  }

  function doEnterCar(car) {
    if (!car || car.destroyed) return false;
    if (car.driver === 'player') return false;
    state.car = car;
    car.driver = 'player';
    car.ai = null;
    state.onFoot = false;
    state.cameraMode = 'chase';
    state.driveYaw = car.state.yaw;
    state.camYaw = car.state.yaw;
    state.camPitch = -0.05;
    velocity.set(0, 0, 0);
    object.visible = false;
    snapCam = true;
    // A car taken out of traffic becomes the player's: no AI is left steering it.
    if (car.lightsOn === false) car.lightsOn = true;
    return true;
  }

  // Step Rafa out on the side of the car that is not the traffic lane and not a wall.
  function doExitCar() {
    const car = state.car;
    if (!car) return false;
    const yaw = car.state.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = fz;
    const rz = -fx;
    const candidates = [];
    for (const s of [1, -1]) {
      const px = car.state.pos.x + rx * s * PLAYER.exitGap;
      const pz = car.state.pos.z + rz * s * PLAYER.exitGap;
      const blocked = solidAt(px, pz, 0.2);
      candidates.push({
        x: px,
        z: pz,
        s,
        score: (blocked ? -100 : 0) + (onRoadway(px, pz) ? -10 : 0),
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    const spot = candidates[0];
    car.driver = null;
    car.state.speed = 0;
    car.state.vel.set(0, 0, 0);
    car.refreshLamps();
    state.car = null;
    state.onFoot = true;
    state.stun = 0;
    position.set(spot.x, groundHeight(spot.x, spot.z, 0.2), spot.z);
    velocity.set(0, 0, 0);
    state.onGround = true;
    state.idle = 0;
    object.visible = true;
    placeFigure(yaw);
    updateCamera(1 / 60);
    void fx;
    void fz;
    return true;
  }

  // ---- driving, one fixed step ------------------------------------------------------------------
  const driveCtrl = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  const carCtx = { colliders, bounds, cars: null, onImpact: null };

  function stepDriving(dt) {
    const car = state.car;
    if (!car) {
      state.onFoot = true;
      return;
    }
    const fwd = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
    const side = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const allowed = state.active && state.stun <= 0;
    driveCtrl.throttle = allowed ? fwd : 0;
    driveCtrl.brake = allowed && fwd < 0 && car.state.speed > 0.6 ? 1 : 0;
    if (driveCtrl.brake) driveCtrl.throttle = 0;
    // steer > 0 turns left; A is left, D is right
    driveCtrl.steer = allowed ? -side : 0;
    driveCtrl.handbrake = allowed && keys.jump ? 1 : 0;

    carCtx.cars = carsOf();
    carCtx.onImpact = (c, other, severity) => {
      if (severity > 3) state.shake = Math.min(1, state.shake + severity * 0.03);
      if (severity > 14) applyDamage((severity - 14) * 1.6);
    };
    stepCar(car, dt, driveCtrl, carCtx);

    // the player rides in the car: position, heading and speed follow the chassis
    position.set(car.state.pos.x, 0, car.state.pos.z);
    state.yaw = car.state.yaw;
    state.speed = Math.abs(car.state.speed);
    state.onGround = true;
    state.stun = Math.max(0, state.stun - dt);
    state.shake = Math.max(0, state.shake - dt * 1.8);
    if (car.destroyed) doExitCar();
  }

  // A car that clips Rafa on foot knocks him back; he is never pushed through a wall by it.
  function checkCarHit(dt) {
    const list = carsOf();
    if (!list.length) return;
    for (const car of list) {
      const sp = Math.abs(car.state.speed);
      if (sp < 3.5) continue;
      const dx = position.x - car.state.pos.x;
      const dz = position.z - car.state.pos.z;
      const reach = car.width * 0.62 + PLAYER.radius;
      if (Math.abs(dx) > car.length * 0.6 + reach || Math.abs(dz) > car.length * 0.6 + reach) continue;
      // transform into the car's frame: a hit needs him alongside the hull, not at the corners
      const fx = -Math.sin(car.state.yaw);
      const fz = -Math.cos(car.state.yaw);
      const along = dx * fx + dz * fz;
      const across = dx * fz - dz * fx;
      if (Math.abs(along) > car.length * 0.52 || Math.abs(across) > reach) continue;
      const nx = dx / (Math.hypot(dx, dz) || 1);
      const nz = dz / (Math.hypot(dx, dz) || 1);
      const push = Math.min(9, sp * 0.55);
      velocity.x = nx * push + fx * sp * 0.35;
      velocity.z = nz * push + fz * sp * 0.35;
      velocity.y = 2.4;
      state.stun = PLAYER.hitRecover;
      state.onGround = false;
      state.shake = Math.min(1, state.shake + 0.5);
      applyDamage(sp * 1.5);
      return;
    }
    void dt;
  }

  function applyDamage(amount) {
    if (!(amount > 0)) return;
    let left = amount;
    if (state.car && state.car.health > 0) { /* the car takes its own share in stepCar */ }
    if (player.armour > 0) {
      const absorb = Math.min(player.armour, left * 0.6);
      player.armour -= absorb;
      left -= absorb;
    }
    player.health = Math.max(0, player.health - left);
  }

  // ==============================================================================================
  // Input — listeners are installed once and act only while setActive(true)
  // ==============================================================================================
  function releaseKeys() {
    for (const k of Object.keys(keys)) keys[k] = 0;
  }

  function onKeyDown(e) {
    if (state.active && e.code === 'KeyF') {
      if (state.onFoot) tryEnterCar();
      else doExitCar();
      return;
    }
    if (state.active && e.code === 'KeyC' && !state.onFoot) {
      state.cameraMode = state.cameraMode === 'chase' ? 'hood' : 'chase';
      snapCam = true;
      return;
    }
    // input that arrives while the world is paused (Esc, the map, a menu) is dropped, not banked:
    // otherwise a W held over the pause screen walks Rafa the moment the game resumes
    if (!state.active) return;
    const k = KEYMAP[e.code];
    if (!k) return;
    keys[k] = 1;
    if (e.code === 'Space' && e.preventDefault) e.preventDefault();
  }

  function onKeyUp(e) {
    const k = KEYMAP[e.code];
    if (k) keys[k] = 0;
  }

  function onMouseMove(e) {
    if (!state.active) return;
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    if (!dx && !dy) return;
    state.camYaw -= dx * 0.0022;                       // unbounded: yaw wraps naturally
    state.camPitch = clamp(state.camPitch - dy * 0.0019, PLAYER.pitchMin, PLAYER.pitchMax);
  }

  // Losing the lock is expected (menu, alt-tab) and must never throw or stall the sim: drop held keys so
  // the player does not walk into a wall behind the pause screen.
  function onPointerLockChange() {
    if (doc && doc.pointerLockElement !== canvas) releaseKeys();
  }

  function onPointerLockError() {
    lockPending = false;
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }
  if (doc && doc.addEventListener) {
    doc.addEventListener('mousemove', onMouseMove);
    doc.addEventListener('pointerlockchange', onPointerLockChange);
    doc.addEventListener('pointerlockerror', onPointerLockError);
  }

  // ==============================================================================================
  // Physics, one fixed step
  // ==============================================================================================
  function stepPhysics(dt) {
    const fwd = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
    const side = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const canAct = state.active && state.stun <= 0;
    const moving = canAct && (fwd !== 0 || side !== 0);
    state.sprint = canAct && !!keys.shift && state.stun <= 0 && !state.aiming;
    if (state.stun > 0) state.stun = Math.max(0, state.stun - dt);
    state.shake = Math.max(0, state.shake - dt * 1.8);
    const cruise = (state.sprint ? PLAYER.run : PLAYER.walk) * (state.aiming ? PLAYER.aimSpeed : 1);

    // wish direction, turned from the camera yaw into the ground plane
    wish.set(0, 0, 0);
    if (moving) {
      const sy = Math.sin(state.camYaw);
      const cy = Math.cos(state.camYaw);
      wish.x = -sy * fwd + cy * side;
      wish.z = -cy * fwd - sy * side;
      const l = Math.hypot(wish.x, wish.z) || 1;
      wish.x /= l;
      wish.z /= l;
    }

    // horizontal: accelerate toward the wish speed, brake when idle, let a sprint bleed off
    const sp = Math.hypot(velocity.x, velocity.z);
    const grip = state.onGround ? 1 : PLAYER.airControl;
    if (moving) {
      const tx = wish.x * cruise;
      const tz = wish.z * cruise;
      const dx = tx - velocity.x;
      const dz = tz - velocity.z;
      const d = Math.hypot(dx, dz);
      const a = PLAYER.accel * grip * dt;
      if (d <= a || d < 1e-5) {
        velocity.x = tx;
        velocity.z = tz;
      } else {
        velocity.x += (dx / d) * a;
        velocity.z += (dz / d) * a;
      }
      // the body turns toward travel rather than snapping: atan2(-x, -z) is the look yaw of that vector
      state.yaw = angleLerp(state.yaw, Math.atan2(-wish.x, -wish.z), 1 - Math.exp(-PLAYER.turnRate * dt));
    } else if (sp > 1e-5) {
      let ns = sp - PLAYER.decel * grip * dt;
      if (sp > PLAYER.walk) ns -= PLAYER.overSpeedDrag * dt;
      if (ns < 0) ns = 0;
      velocity.x = (velocity.x / sp) * ns;
      velocity.z = (velocity.z / sp) * ns;
    }

    if (state.active && keys.jump && state.onGround && state.stun <= 0) {
      velocity.y = PLAYER.jump;
      state.onGround = false;
      state.airTime = 0;
    }
    velocity.y -= PLAYER.gravity * dt;

    // horizontal first (collision reads the current footing), then vertical and the ground snap
    const moved = moveWithCollision(velocity.x * dt, velocity.z * dt);
    checkCarHit(dt);
    position.y += velocity.y * dt;

    const gy = groundHeight(position.x, position.z, Math.max(position.y, 0));
    const gap = position.y - gy;
    if (velocity.y <= 0 && (gap <= 0.001 || (state.onGround && gap <= PLAYER.stepUp))) {
      if (!state.onGround) state.land = Math.min(1, Math.max(0.25, -velocity.y / 9));
      else if (gap > 0.02) state.land = Math.max(state.land, 0.2);   // stepped off a kerb
      position.y = gy;
      velocity.y = 0;
      state.onGround = true;
      state.airTime = 0;
    } else if (velocity.y > 0 || gap > PLAYER.stepUp) {
      state.onGround = false;
      state.airTime += dt;
    }

    // bookkeeping the animation, HUD and audio read
    state.speed = Math.hypot(velocity.x, velocity.z);
    state.step += moved;
    state.distance += moved;
    state.idle = moving || state.speed > 0.25 ? 0 : state.idle + dt;
    state.land = Math.max(0, state.land - dt * 5);
  }

  // ==============================================================================================
  // Camera: over the right shoulder, spring follow, sweep against city.colliders
  // ==============================================================================================
  function updateCamera(dt) {
    if (!state.onFoot && state.car) {
      driveCamera(dt);
      return;
    }

    // sprint FOV: eased, so the widen reads as a breath rather than a snap
    if (view) {
      const t = clamp((state.speed - PLAYER.walk) / (PLAYER.run - PLAYER.walk), 0, 1);
      const target = state.aiming ? fovBase + PLAYER.aimFov : fovBase + PLAYER.fovSprint * t;
      state.fov += (target - state.fov) * (1 - Math.exp(-5 * dt));
      if (Math.abs(view.fov - state.fov) > 0.01) {
        view.fov = state.fov;
        view.updateProjectionMatrix();
      }
    }

    const cy = Math.cos(state.camYaw);
    const sy = Math.sin(state.camYaw);
    const cp = Math.cos(state.camPitch);
    const sp = Math.sin(state.camPitch);

    // orbit anchor at chest height; the lens sits behind it along -forward, shifted to the right
    const back = state.aiming ? PLAYER.aimBack : PLAYER.camBack;
    const shoulder = state.aiming ? PLAYER.aimShoulder : PLAYER.camShoulder;
    anchor.set(position.x, position.y + (state.aiming ? PLAYER.aimAnchorY : PLAYER.camAnchorY), position.z);
    const fx = -sy * cp;
    const fy = sp;
    const fz = -cy * cp;
    ideal.set(
      anchor.x - fx * back + cy * shoulder,
      anchor.y - fy * back + shoulder * 0.1,
      anchor.z - fz * back - sy * shoulder,
    );

    // sweep anchor -> ideal and pull in at the first wall
    rayDir.subVectors(ideal, anchor);
    const full = rayDir.length() || 1e-5;
    rayDir.divideScalar(full);
    let hit = full;
    for (let i = 0; i < colliders.length; i += 1) {
      const t = rayBox(anchor, rayDir, colliders[i], full, PLAYER.camRadius);
      if (t >= 0 && t < hit) hit = t;
    }
    if (hit < full) {
      // pull in to the face and stop there: a hard minimum distance would push the lens into the wall
      ideal.sub(anchor).multiplyScalar(Math.max(0.03, (hit - 0.08) / full)).add(anchor);
    }

    // spring: the rig lags a little, faster on the ground plane so strafing does not swim
    if (snapCam) {
      smoothed.copy(ideal);
      snapCam = false;
    } else {
      const kxz = 1 - Math.exp(-PLAYER.camLagXZ * dt);
      const ky = 1 - Math.exp(-PLAYER.camLagY * dt);
      smoothed.x += (ideal.x - smoothed.x) * kxz;
      smoothed.z += (ideal.z - smoothed.z) * kxz;
      smoothed.y += (ideal.y - smoothed.y) * ky;
    }

    // squeezed against a wall the lens ends up inside the figure; hide him rather than see his skull
    if (state.onFoot) object.visible = smoothed.distanceTo(anchor) > PLAYER.camHide;

    // aim straight from yaw/pitch so the mouse never lags; the position springs behind it
    if (view) {
      view.position.copy(smoothed);
      view.rotation.order = 'YXZ';
      view.rotation.set(state.camPitch, state.camYaw, 0, 'YXZ');
      view.rotation.z = 0;
    }
  }

  // Chase cam: the rig trails the car, lags on a spring, and aims at a look-ahead point so the car
  // sits low in frame and the road fills the view. Hood cam welds itself just above the bonnet.
  const carFwd = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const lookSmooth = new THREE.Vector3();
  const chasePos = new THREE.Vector3();

  function driveCamera(dt) {
    const car = state.car;
    if (!car) return;
    const topSpeed = (car.spec && car.spec.top) || 40;
    const speedN = clamp(Math.abs(car.state.speed) / topSpeed, 0, 1);

    // the rig's yaw follows the car and yields to the mouse: a free look that recentres itself
    const followK = 1 - Math.exp(-PLAYER.chaseLag * 0.55 * dt);
    state.camYaw = angleLerp(state.camYaw, car.state.yaw, followK);
    state.camPitch = clamp(state.camPitch, PLAYER.drivePitchMin, PLAYER.drivePitchMax);

    carFwd.set(-Math.sin(car.state.yaw), 0, -Math.cos(car.state.yaw));

    if (view) {
      const target = fovBase + PLAYER.fovDrive * speedN;
      state.fov += (target - state.fov) * (1 - Math.exp(-4 * dt));
      if (Math.abs(view.fov - state.fov) > 0.01) {
        view.fov = state.fov;
        view.updateProjectionMatrix();
      }
    }

    const shake = state.shake * state.shake * 0.16;
    const jx = Math.sin(state.t * 61.7) * shake;
    const jy = Math.cos(state.t * 47.3) * shake;

    if (state.cameraMode === 'hood') {
      // hood: ahead of the windscreen, looking down the bonnet
      const px = car.state.pos.x + carFwd.x * (car.length * 0.5 - PLAYER.hoodFwd);
      const pz = car.state.pos.z + carFwd.z * (car.length * 0.5 - PLAYER.hoodFwd);
      const py = PLAYER.hoodUp + 0.34 + car.state.pitch * 1.6;
      smoothed.set(px + jx * 0.4, py + jy * 0.4, pz);
      lookAt.set(px + carFwd.x * 26, py - 1.2 + state.camPitch * 6, pz + carFwd.z * 26);
      if (snapCam) { snapCam = false; }
      if (view) {
        view.position.copy(smoothed);
        view.lookAt(lookAt);
      }
      return;
    }

    // chase: behind and above, swung by the camera yaw so the mouse orbits the car
    const orbit = state.camYaw;
    const back = PLAYER.chaseBack + speedN * 1.5;
    const cy = Math.cos(orbit);
    const sy = Math.sin(orbit);
    const px = car.state.pos.x + sy * back;
    const pz = car.state.pos.z + cy * back;
    const py = PLAYER.chaseUp + state.camPitch * 3.0;

    chasePos.set(px, py, pz);
    if (snapCam) {
      smoothed.copy(chasePos);
      lookSmooth.set(car.state.pos.x + carFwd.x * 6, 1.2, car.state.pos.z + carFwd.z * 6);
      snapCam = false;
    } else {
      const k = 1 - Math.exp(-PLAYER.chaseLag * dt);
      const ky = 1 - Math.exp(-PLAYER.chaseLagY * dt);
      smoothed.x += (chasePos.x - smoothed.x) * k;
      smoothed.z += (chasePos.z - smoothed.z) * k;
      smoothed.y += (chasePos.y - smoothed.y) * ky;
      // look-ahead: aim further down the road the faster the car goes
      const lead = PLAYER.chaseLead + speedN * 7;
      lookAt.set(
        car.state.pos.x + carFwd.x * lead,
        1.35 + car.state.pitch * 3,
        car.state.pos.z + carFwd.z * lead,
      );
      lookSmooth.lerp(lookAt, 1 - Math.exp(-7 * dt));
    }

    // never let the lens sink through the asphalt
    if (smoothed.y < 0.6) smoothed.y = 0.6;

    if (view) {
      view.position.set(smoothed.x + jx, smoothed.y + jy, smoothed.z);
      view.lookAt(lookSmooth);
    }
  }

  function placeFigure(yaw) {
    state.yaw = yaw;
    state.camYaw = yaw;
    object.rotation.y = yaw + Math.PI;
    object.position.copy(position);
    snapCam = true;
  }

  // ==============================================================================================
  // The figure: hip rig (legs) + body group (torso, arms, head) so the bob never lifts the feet
  // ==============================================================================================
  function buildFigure() {
    const group = new THREE.Group();
    group.name = 'player-rafa';
    const mats = makeMaterials();
    const parts = { hip: null, body: null, head: null, arms: [], legs: [] };

    const hip = new THREE.Group();
    hip.name = 'player-hip';
    hip.position.y = PLAYER.hipY;
    group.add(hip);
    parts.hip = hip;

    const body = new THREE.Group();
    body.name = 'player-body';
    hip.add(body);
    parts.body = body;

    // torso: teal jacket over a cream shirt, popped collar, belt at the waist
    addBox(body, mats.jacket, 0, 0.32, 0, 0.42, 0.50, 0.25);
    addBox(body, mats.jacket, 0, 0.55, 0, 0.50, 0.10, 0.27);            // shoulders
    addBox(body, mats.shirt, 0, 0.34, 0.125, 0.15, 0.40, 0.02);         // open front
    addBox(body, mats.collar, 0, 0.60, 0.05, 0.29, 0.06, 0.20);         // collar
    addBox(body, mats.jacket, -0.215, 0.34, 0, 0.02, 0.44, 0.21);       // seams
    addBox(body, mats.jacket, 0.215, 0.34, 0, 0.02, 0.44, 0.21);
    addBox(body, mats.belt, 0, 0.055, 0, 0.44, 0.07, 0.26);

    // head: skull, hair, sunglasses, nose, mouth, ears
    const head = new THREE.Group();
    head.name = 'player-head';
    head.position.y = 0.57;
    body.add(head);
    parts.head = head;
    addBox(head, mats.skin, 0, 0.035, 0, 0.11, 0.09, 0.11);                     // neck
    addBox(head, mats.skin, 0, 0.16, 0, 0.215, 0.235, 0.225);                   // skull
    addBox(head, mats.hair, 0, 0.275, -0.005, 0.222, 0.055, 0.232);             // hair cap
    addBox(head, mats.hair, 0, 0.225, -0.098, 0.218, 0.10, 0.05);               // nape
    addBox(head, mats.hair, 0, 0.205, 0.108, 0.20, 0.045, 0.02);                // fringe
    addBox(head, mats.glass, 0, 0.175, 0.116, 0.175, 0.045, 0.016);             // lenses
    addBox(head, mats.frame, 0, 0.175, 0.124, 0.186, 0.010, 0.012);             // brow bar
    addBox(head, mats.frame, -0.098, 0.175, 0.082, 0.012, 0.012, 0.085);        // temples
    addBox(head, mats.frame, 0.098, 0.175, 0.082, 0.012, 0.012, 0.085);
    addBox(head, mats.skin, 0, 0.115, 0.112, 0.048, 0.05, 0.03);                // nose
    addBox(head, mats.lips, 0, 0.075, 0.110, 0.07, 0.018, 0.014);               // mouth
    addBox(head, mats.skin, 0.113, 0.15, 0, 0.02, 0.07, 0.05);                  // ears
    addBox(head, mats.skin, -0.113, 0.15, 0, 0.02, 0.07, 0.05);

    // arms: shoulder pivot at the jacket cap, elbow hinge, hand
    for (const s of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.name = s < 0 ? 'player-arm-right' : 'player-arm-left';
      shoulder.position.set(s * 0.29, 0.53, 0);
      body.add(shoulder);
      addBox(shoulder, mats.jacket, 0, -0.15, 0, 0.13, 0.30, 0.15);
      const elbow = new THREE.Group();
      elbow.position.y = -0.30;
      shoulder.add(elbow);
      addBox(elbow, mats.jacket, 0, -0.12, 0, 0.115, 0.24, 0.13);
      addBox(elbow, mats.shirt, 0, -0.245, 0, 0.105, 0.05, 0.12);            // cuff
      addBox(elbow, mats.skin, 0, -0.30, 0.005, 0.095, 0.10, 0.11);          // hand
      parts.arms.push({ side: s, shoulder, elbow });
    }

    // legs: hip pivot, knee hinge, shoe
    for (const s of [-1, 1]) {
      const leg = new THREE.Group();
      leg.name = s < 0 ? 'player-leg-right' : 'player-leg-left';
      leg.position.set(s * 0.105, 0, 0);
      hip.add(leg);
      addBox(leg, mats.trousers, 0, -0.225, 0, 0.165, 0.45, 0.185);
      const knee = new THREE.Group();
      knee.position.y = -0.45;
      leg.add(knee);
      addBox(knee, mats.trousers, 0, -0.195, 0, 0.145, 0.39, 0.165);
      addBox(knee, mats.shoe, 0, -0.42, 0.035, 0.15, 0.10, 0.26);            // shoe, toe forward
      addBox(knee, mats.shoe, 0, -0.475, 0.035, 0.155, 0.025, 0.27);         // sole
      parts.legs.push({ side: s, hip: leg, knee });
    }

    group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return { group, parts, mats };
  }

  function makeMaterials() {
    // Costa Lume palette: teal jacket and cream shirt from the HUD's --teal/--gold family, so Rafa reads
    // against terracotta facades in the low warm light sky.js pours across the city.
    const table = {
      jacket: [0x1f6f6a, 0.74], collar: [0x17524f, 0.72], shirt: [0xf2e7d2, 0.88],
      skin: [0xb8794f, 0.76], hair: [0x231d19, 0.92], trousers: [0x3b4654, 0.9],
      shoe: [0xe6dfcf, 0.7], belt: [0x3a2a1e, 0.82], lips: [0x8a4a3a, 0.8],
      frame: [0xc9a15a, 0.34, { metalness: 0.7 }],
      glass: [0x14181c, 0.16, { metalness: 0.9, emissive: 0xffd9a0, emissiveIntensity: 0 }],
    };
    const mats = {};
    for (const [name, [color, roughness, extra]] of Object.entries(table)) {
      mats[name] = new THREE.MeshStandardMaterial(
        Object.assign({ color, roughness, metalness: 0.04 }, extra || {}),
      );
    }
    return mats;
  }

  function addBox(parent, mat, x, y, z, sx, sy, sz) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  // ==============================================================================================
  // Animation. The cycle is driven by distance travelled, so stride length sets the cadence at any
  // speed; limbs swing in opposition with knee and elbow bend, the body bobs and counter-rotates its
  // shoulders, the head holds the travel direction. Idle is a slower layer: breathing, an eased weight
  // shift, an occasional glance — integer buckets through hash(), never Math.random.
  // ==============================================================================================
  function updateWalkCycle(dt) {
    const p = figure.parts;
    const speedN = clamp(state.speed / PLAYER.run, 0, 1);
    const moving = state.speed > 0.3;

    if (!state.onGround) {
      // air pose: knees tucked, arms low, no ground cycle
      const tuck = Math.min(1, state.airTime * 6);
      p.legs[0].hip.rotation.set(-0.55 * tuck, 0, 0);
      p.legs[1].hip.rotation.set(-0.22 * tuck, 0, 0);
      p.legs[0].knee.rotation.x = 0.95 * tuck;
      p.legs[1].knee.rotation.x = 0.55 * tuck;
      for (let i = 0; i < 2; i += 1) {
        const s = p.arms[i].side;
        p.arms[i].shoulder.rotation.set(-0.45 * tuck, 0, s * (0.30 + 0.15 * tuck));
        p.arms[i].elbow.rotation.x = -0.75 * tuck;
      }
      p.body.position.set(0, 0, 0);
      p.body.rotation.set(0.06, 0, 0);
      p.head.rotation.set(0.08 * tuck, 0, 0);
      return;
    }

    if (moving) {
      const stride = state.sprint ? 1.5 : 1.1;                 // metres per full cycle
      const phase = (state.step / stride) * Math.PI * 2;
      const s = Math.sin(phase);
      const swing = (0.30 + 0.46 * speedN) * clamp(state.speed / 1.4, 0, 1);
      for (let i = 0; i < 2; i += 1) {
        const leg = p.legs[i];
        const ph = phase + (i ? Math.PI : 0);
        const hipAng = -Math.sin(ph) * swing;                  // negative x = leg forward
        leg.hip.rotation.x = hipAng;
        leg.hip.rotation.z = (i ? 1 : -1) * 0.02;
        // the knee folds as the foot goes behind and lifts through the swing, squared so the bend
        // stays in the swing phase instead of turning every step into a march
        const behind = 0.5 - 0.5 * Math.sin(ph);               // 1 when the foot is back
        leg.knee.rotation.x = 0.10 + behind * behind * (0.16 + 0.55 * speedN) + Math.max(0, hipAng) * 0.12;
      }
      for (let i = 0; i < 2; i += 1) {
        const arm = p.arms[i];
        const swingArm = Math.sin(phase + (i ? Math.PI : 0)) * (0.42 + 0.42 * speedN);
        arm.shoulder.rotation.x = swingArm;                    // opposite the same-side leg
        arm.shoulder.rotation.z = arm.side * (0.09 + 0.05 * speedN);
        arm.elbow.rotation.x = -(0.28 + 0.62 * speedN + 0.22 * Math.max(0, -swingArm));
      }
      const bob = Math.abs(s) * (0.028 + 0.045 * speedN);
      p.body.position.set(0, bob - 0.02 * speedN, 0);
      p.body.rotation.set(0.05 + 0.15 * speedN, -s * 0.11 * speedN, -s * 0.045 * speedN);
      p.head.rotation.set(-0.04 * speedN, s * 0.10 * speedN, -s * 0.02 * speedN);
    } else {
      // idle: breathing, an eased weight shift, an occasional glance
      const breathe = Math.sin(state.t * 1.55);
      const swayTarget = state.idle > 2 && hash((state.idle / 2.6) | 0, 3) > 0.45 ? 1 : 0;
      const glanceTarget = state.idle > 1.3 && hash((state.idle / 1.7) | 0, 11) > 0.4 ? 1 : 0;
      state.sway += (swayTarget - state.sway) * (1 - Math.exp(-2.2 * dt));
      state.glance += (glanceTarget - state.glance) * (1 - Math.exp(-1.8 * dt));
      const shift = Math.sin(state.idle * 1.25) * state.sway;
      const glance = Math.sin(state.idle * 2.1) * state.glance;
      for (let i = 0; i < 2; i += 1) {
        const leg = p.legs[i];
        leg.hip.rotation.set(0.015, 0, (i ? 1 : -1) * shift * 0.02);
        leg.knee.rotation.x = 0.05 + Math.abs(shift) * 0.05;
        const arm = p.arms[i];
        arm.shoulder.rotation.set(breathe * 0.012, 0, arm.side * (0.12 + breathe * 0.02));
        arm.elbow.rotation.x = -0.20 - breathe * 0.02;
      }
      p.body.position.set(shift * 0.02, breathe * 0.008, 0);
      p.body.rotation.set(breathe * 0.012, -shift * 0.07, shift * 0.045);
      p.head.rotation.set(Math.sin(state.t * 0.9) * 0.02, glance * 0.55, -shift * 0.03);
    }

    // landing: knees bend and the body drops, decaying over a few frames
    if (state.land > 0) {
      const q = state.land * state.land;
      p.body.position.y -= q * 0.13;
      p.body.rotation.x += q * 0.18;
      p.legs[0].knee.rotation.x += q * 0.85;
      p.legs[1].knee.rotation.x += q * 0.85;
    }

    // a sunglass glint when Rafa turns into the low sun — the daylight rig's only claim on him
    facing.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    figure.mats.glass.emissiveIntensity = clamp((facing.dot(towardSun) - 0.5) / 0.5, 0, 1) * 1.1;
  }

  // ==============================================================================================
  // Frame update
  // ==============================================================================================
  function update(dt) {
    if (!dt || dt <= 0) return;
    state.t += dt;
    if (state.car) {
      // driving: the chassis is stepped here, one fixed step at a time, same as the AI
      let left = Math.min(dt, 0.25);
      while (left > 1e-5) {
        const h = Math.min(left, 1 / 60);
        stepDriving(h);
        left -= h;
      }
    } else if (state.onFoot) {
      // fixed sub-steps: a 250 ms stall is still resolved as 15 small moves, never one leap
      let left = Math.min(dt, 0.25);
      while (left > 1e-5) {
        const h = Math.min(left, 1 / 60);
        stepPhysics(h);
        left -= h;
      }
    }
    object.position.copy(position);
    object.rotation.y = state.yaw + Math.PI;
    if (state.onFoot) updateWalkCycle(dt);
    updateCamera(dt);
  }

  // ==============================================================================================
  // Public surface
  // ==============================================================================================
  const player = {
    object,
    position,
    velocity,
    health: 100,
    armour: 50,
    update,

    // true while walking, false while a car holds the player
    get onFoot() { return state.onFoot; },
    set onFoot(v) {
      state.onFoot = !!v;
      if (!state.onFoot) state.car = state.car || null;
    },

    // the car the player is holding (null on foot), and the rig it is seen from
    get car() { return state.car; },
    get cameraMode() { return state.cameraMode; },
    set cameraMode(mode) { state.cameraMode = mode === 'hood' ? 'hood' : 'chase'; },
    get stunned() { return state.stun > 0; },
    get aiming() { return state.aiming; },

    // systems/combat.js owns the trigger; the rig only has to know when to tighten up
    setAiming(on) {
      state.aiming = !!on && state.onFoot;
      snapCam = true;
      return state.aiming;
    },

    // read-only extras: minimap heading, HUD speed gate, audio step timer
    get speed() { return state.speed; },
    get walking() { return state.speed > 0.3; },
    get sprinting() { return state.speed > PLAYER.walk + 0.2; },
    get sprint() { return state.sprint; },
    get heading() { return state.yaw; },
    get onGround() { return state.onGround; },
    get distance() { return state.distance; },
    get active() { return state.active; },
    get camera() { return view; },

    // wiring: the car pool from systems/traffic.js
    setTraffic(t) {
      traffic = t || null;
      return player;
    },

    enterCar(car) { return doEnterCar(car); },
    exitCar() { return doExitCar(); },
    damage(amount) { applyDamage(amount); },
    heal(amount) {
      player.health = Math.min(100, player.health + (amount || 0));
    },

    setActive(active) {
      state.active = !!active;
      if (!state.active) releaseKeys();
    },

    // Place the player, feet on the ground, facing yaw, the camera snapped behind them.
    teleport(x, z, yaw = 0) {
      position.set(x, groundHeight(x, z, 0.2), z);
      velocity.set(0, 0, 0);
      state.onGround = true;
      state.airTime = 0;
      state.speed = 0;
      state.step = 0;
      state.distance = 0;
      state.land = 0;
      state.idle = 0;
      state.sway = 0;
      state.glance = 0;
      state.camPitch = -0.06;
      object.visible = true;
      placeFigure(yaw);
      // a teleport moves the body tens of metres; the rig must arrive with it in one frame instead of
      // easing across the city (and through whatever stands between the old spot and the new one)
      snapCam = true;
      updateCamera(1 / 60);
    },

    // Deliberate framing for the shot scenes: sets the rig without the mouse.
    pointCamera(yaw, pitch = -0.06) {
      state.camYaw = yaw;
      state.camPitch = clamp(pitch, PLAYER.pitchMin, PLAYER.pitchMax);
      placeFigure(yaw);
      snapCam = true;          // a framed shot is framed now, not after the spring settles
      updateCamera(1 / 60);
    },

    // Called from a click: the only place a pointer lock is requested.
    lockPointer() {
      if (!canvas || typeof canvas.requestPointerLock !== 'function' || lockPending) return;
      if (doc && doc.pointerLockElement === canvas) return;
      lockPending = true;
      try {
        const r = canvas.requestPointerLock();
        if (r && typeof r.then === 'function') {
          r.then(() => { lockPending = false; }, () => { lockPending = false; });
        } else {
          lockPending = false;   // the legacy path confirms through pointerlockchange
        }
      } catch (err) {
        lockPending = false;     // refused (no gesture, iframe): stay playable, never throw
      }
    },

    dispose() {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
      }
      if (doc && doc.removeEventListener) {
        doc.removeEventListener('mousemove', onMouseMove);
        doc.removeEventListener('pointerlockchange', onPointerLockChange);
        doc.removeEventListener('pointerlockerror', onPointerLockError);
        if (doc.pointerLockElement === canvas && doc.exitPointerLock) {
          try { doc.exitPointerLock(); } catch (err) { /* already gone */ }
        }
      }
      state.active = false;
      if (scene) scene.remove(object);
      object.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      for (const m of Object.values(figure.mats)) m.dispose();
    },
  };
  return player;
}

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function angleLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// Deterministic 0..1 from two integers: the idle gestures' only source of variation.
function hash(n, salt) {
  let x = (n | 0) * 374761393 + (salt | 0) * 668265263;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// 2D slab test (x/z) against a collider inflated by pad, gated by its height: the distance along dir to
// the entry point, or -1 for a miss. Used for the camera sweep. Scratch arrays, so no per-collider
// allocation in the frame loop.
const RB_LO = [0, 0];
const RB_HI = [0, 0];
const RB_O = [0, 0];
const RB_D = [0, 0];

function rayBox(origin, dir, box, maxDist, pad) {
  if (origin.y > (box.height === undefined ? Infinity : box.height + pad)) return -1;
  RB_LO[0] = box.minX - pad; RB_LO[1] = box.minZ - pad;
  RB_HI[0] = box.maxX + pad; RB_HI[1] = box.maxZ + pad;
  RB_O[0] = origin.x; RB_O[1] = origin.z;
  RB_D[0] = dir.x; RB_D[1] = dir.z;
  let t0 = 0;
  let t1 = maxDist;
  for (let i = 0; i < 2; i += 1) {
    if (Math.abs(RB_D[i]) < 1e-8) {
      if (RB_O[i] < RB_LO[i] || RB_O[i] > RB_HI[i]) return -1;
      continue;
    }
    let a = (RB_LO[i] - RB_O[i]) / RB_D[i];
    let b = (RB_HI[i] - RB_O[i]) / RB_D[i];
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  return t0;
}
