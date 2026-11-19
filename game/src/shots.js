// Costa Lume — the scripted screenshot scenes.
//
// main.js builds the world, then calls stageShot(name, ctx) once with the context
//   { scene, camera, renderer, state, player, city, hud, textures, traffic, rng, seed }
// and renders the result. A scene leaves the world in the frame the screenshot wants and returns;
// main.js owns window.__shotReady and sets it after its second rendered frame, so the flag can never
// flip before a pixel lands.
//
// `state` is main.js's per-frame HUD object: writing state.money here is the same write the HUD
// reads on its next update. Dressing goes into one group tagged on window.__shotRoot so a later
// scene — or a real play session after a shot — can drop it with clearShotProps().
import * as THREE from 'three';
import { pushGeometry } from './world/geometry.js';
import { createCar } from './entities/vehicles.js';
import { MISSIONS } from './systems/missions.js';

// city.js draws its sidewalk pads 0.16 m above the asphalt, and pads carry no colliders, so the
// player's feet sit at street level; shot props are lifted onto the pad by hand.
const PAD_Y = 0.16;

// Avenida Sol runs along z at x = -36 (city.js CFG.mainX = 4), Calle Mercado along x at z = -108.
// Playa Norte's pastel hotels are blocks j = 0 and j = 1, z -312..-192; the sea is south (-z).
// The asphalt spans -48..-24; each block's 3.5 m walk ring sits just inside its pad edge.
const SOL = -36;
const EAST_WALK = SOL + 13.75;    // east sidewalk band -24..-20.5
const WEST_WALK = SOL - 13.75;    // west sidewalk band -51.5..-48

// ==============================================================================================
// Scene table
// ==============================================================================================
export function stageShot(name, ctx) {
  const scene = SCENES[name];
  if (!scene) {
    // a typo in ?shot= must not take the entry down: hold the menu frame instead
    console.warn(`[shots] no scene named "${name}"`);
    return;
  }
  scene(ctx);
}

// ==============================================================================================
// cover — Playa Norte boulevard at golden hour
// ----------------------------------------------------------------------------------------------
// Rafa mid-stride on the crown of Avenida Sol walking north. The street is the live one: seven cars
// out of systems/traffic.js's fleet are posed in the lanes and at the near kerb, and the crowd is
// five walkers added through traffic.addWalker() on the near sidewalk plus a jaywalker half way
// across the asphalt — instanced figures that stride, not hand-placed boxes.
//
// He walks the centre line rather than the pavement: the mercado-style facades of this row hang a
// 3.1 m awning 2.3 m out over the sidewalk, and a lens standing under one frames the awning's dark
// underside across the top of the picture (the defect the earlier cover capture carried). On the
// asphalt the lens sits 12 m clear of both kerbs and the frame's top is open sky.
//
// yaw PI looks north (+z) up the boulevard; yaw 0 looks south at the sea. The rig sits behind him,
// so the road, the traffic and the far facades recede up the frame while the near kerb and its
// parked Viento sit on the right third. The low sun is north-east, ahead-left of the lens: the
// west-side facades rake with warm light and every shadow runs back toward the camera.
// ==============================================================================================
const COVER_YAW = Math.PI - 0.24;

function stageCover(ctx) {
  const { player, city, state, hud, camera, scene, traffic } = ctx;
  const root = openProps(scene);
  const props = propBatches();

  // --- Rafa on the centre line of the avenue, mid-stride, heading north -------------------------
  player.teleport(SOL, -226.5, COVER_YAW);
  poseStride(player, COVER_YAW);
  player.pointCamera(COVER_YAW, -0.02);

  // Everything below is placed against the staged frame, so a change to the stride or the teleport
  // moves the street with it.
  const camZ = camera.position.z;
  const px = player.position.x;
  const pz = player.position.z;
  const used = new Set();

  // --- the kerbside car the HUD prompt names: a Viento within arm's reach ----------------------
  const parked = ensureBrand(traffic, scene, 'viento', 0x2f5d73, used);
  poseCar(parked, SOL + KERB_PARK, pz + 3.7, NORTH);

  // --- traffic: three northbound, three southbound, all out of the live fleet ------------------
  const moving = takeCars(traffic, ['lagarto', 'abeja', 'tiburon', 'faro', 'marea', 'viento'], used);
  const lanes = [
    [SOL + LANE_IN, camZ + 16, NORTH],
    [SOL + LANE_IN, camZ + 31, NORTH],
    [SOL + LANE_OUT, camZ + 23, NORTH],
    [SOL - LANE_IN, camZ + 12, SOUTH],
    [SOL - LANE_OUT, camZ + 27, SOUTH],
    [SOL - LANE_IN, camZ + 41, SOUTH],
  ];
  moving.forEach((car, i) => {
    const [x, z, yaw] = lanes[i];
    poseCar(car, x, z, yaw);
  });

  // --- walkers: five within 12 m of the lens on the near sidewalk, one crossing the road -------
  // All of them ahead of Rafa so nobody stands in the three metres between him and the lens, and
  // spread across the walk band so the crowd reads as a crowd and not a queue.
  const spots = [
    [-23.2, 5.0], [-21.6, 7.7], [-22.4, 10.0], [-21.8, 11.7], [-23.3, 14.9],
  ];
  const taken = [];
  for (let i = 0; i < spots.length; i += 1) {
    const [sx, dz] = spots[i];
    const spot = clearSpot(city.colliders, sx, camZ + dz, px, pz, taken);
    taken.push(spot);
    sidewalkWalker(traffic, spot.x, spot.z, i % 2 ? -1 : 1);
  }
  // the jaywalker, half way over the avenue and heading west
  crossWalker(traffic, EAST_WALK - 0.4, WEST_WALK + 1.2, camZ + 4.6, 8.4);

  finishProps(root, props);

  // the instanced walkers exist now; flush them without stepping the world
  traffic.refresh();

  // --- HUD: the live first job, no heat, full health and starting cash ------------------------
  // The mission block is the missions system's own publish(), so the title and objective in the
  // frame are the ones the game is actually running, not text painted for a photograph.
  const { missions } = ctx;
  if (missions) missions.start(0, { teleport: false });
  player.health = 100;
  player.armour = 50;
  state.money = 250;
  state.stars = 0;
  state.weapon = 'fists';
  state.ammo = null;
  state.inCar = false;
  state.speedKmh = 0;
  state.carBrand = '';
  state.radio = 'Radio Sol';
  state.district = districtAt(city, player.position.x, player.position.z);

  hud.show();
  // the F prompt is the game's own rule — a car inside player.js's 4 m carReach — so it is drawn
  // only when the parked Viento really is within arm's reach of where Rafa stands, not painted
  const reach = parked
    ? Math.hypot(parked.state.pos.x - player.position.x, parked.state.pos.z - player.position.z)
    : Infinity;
  hud.setPrompt(reach <= 4.0 ? `F — steal ${parked.brand}` : '');
  hud.toast('Mira: the Viento is on the kerb. Don\u2019t scratch it.');
  hud.update(state, 0);
}

// ==============================================================================================
// drive — at the wheel of a Tiburón, north up Avenida Sol
// ----------------------------------------------------------------------------------------------
// The player is actually in the car: enterCar() hides the figure and hands the rig to the chase
// camera, which springs in behind the chassis and leads it down the road. The speed is written into
// the chassis itself, so the speedometer in the HUD is the car's own 78 km/h and not a number this
// scene painted. The rest of the boulevard is live traffic, posed ahead and behind on the map.
// ==============================================================================================
const DRIVE_Z = -212;

function stageDrive(ctx) {
  const { player, city, state, hud, traffic, scene } = ctx;

  // --- the car: a Tiburón out of the fleet, northbound in the inner lane at 78 km/h ------------
  const used = new Set();
  const car = ensureBrand(traffic, scene, 'tiburon', 0x8c2f2a, used);
  poseCar(car, SOL + LANE_IN, DRIVE_Z, NORTH, 78 / 3.6);

  // --- the player takes it: figure hidden, chase rig behind the tail ---------------------------
  player.teleport(SOL + LANE_IN, DRIVE_Z, NORTH);
  player.enterCar(car);
  car.lightsOn = false;          // golden hour, headlights down
  car.refreshLamps();
  // settle the rig and the speed FOV: pointCamera snaps the chase spring and aims down the road
  for (let i = 0; i < 30; i += 1) player.pointCamera(NORTH, -0.03);

  const cz = car.state.pos.z;
  const camZ = cz - 9;

  // --- traffic: ahead in both lanes, oncoming, and two more behind on the minimap --------------
  const moving = takeCars(traffic, ['lagarto', 'abeja', 'viento', 'faro', 'marea', 'patrulla'], used);
  const lanes = [
    [SOL + LANE_IN, cz + 24, NORTH],
    [SOL + LANE_OUT, cz + 40, NORTH],
    [SOL + LANE_IN, cz - 34, NORTH],     // behind the lens, on the map
    [SOL - LANE_IN, cz + 30, SOUTH],
    [SOL - LANE_OUT, cz + 58, SOUTH],
    [SOL - LANE_IN, cz - 22, SOUTH],     // behind the lens, on the map
  ];
  moving.forEach((other, i) => {
    const [x, z, yaw] = lanes[i];
    poseCar(other, x, z, yaw);
  });

  // --- pedestrians on both sidewalks, ahead of the lens ----------------------------------------
  // The chase rig sits ~9 m behind the car, so anything on the right-hand walk has to be at least
  // half a carriageway plus that offset ahead of the lens to fall inside the frame.
  const taken = [];
  const east = [
    [-21.7, 16], [-21.4, 26], [-22.0, 38], [-21.6, 52],
  ];
  for (let i = 0; i < east.length; i += 1) {
    const [x, dz] = east[i];
    const spot = clearSpot(city.colliders, x, camZ + dz, car.state.pos.x, cz, taken);
    taken.push(spot);
    sidewalkWalker(traffic, spot.x, spot.z, i % 2 ? -1 : 1);
  }
  const west = [[-49.8, 24], [-49.5, 40]];
  for (let i = 0; i < west.length; i += 1) {
    const [x, dz] = west[i];
    const spot = clearSpot(city.colliders, x, camZ + dz, car.state.pos.x, cz, taken);
    taken.push(spot);
    sidewalkWalker(traffic, spot.x, spot.z, i % 2 ? -1 : 1);
  }
  traffic.refresh();

  // --- HUD: mission one, cash on hand, the dial reading the chassis ----------------------------
  player.health = 100;
  player.armour = 50;
  state.money = 12450;
  state.stars = 0;
  state.weapon = 'fists';
  state.ammo = null;
  state.radio = 'Radio Sol';
  state.mission = {
    id: 'first-fare',
    title: 'First Fare',
    objective: 'drive the Viento to the Mercado drop',
    marker: { x: -22, z: -108 },
  };
  state.district = districtAt(city, player.position.x, player.position.z);
  state.speedKmh = Math.abs(car.state.speed) * 3.6;
  state.inCar = true;
  state.carBrand = car.brand;

  hud.show();
  hud.update(state, 0);
}

// chase — a Tiburón at 96 km/h up Avenida Sol with two PATRULLA cruisers on its tail
// ----------------------------------------------------------------------------------------------
// The speed is written into the chassis itself, so the dial in the HUD is the car's own 96 km/h.
// The pursuit is staged rather than simulated: police.stageCruiser() parks two cruisers behind the
// player's tail (one in the outer lane, one swung out over the centre line) and lights their bars,
// so the siren reads as a red-blue pair of discs at a glance. 3 stars are set on the same system, so
// the HUD stars and the minimap dots are the real wanted level, not paint.
//
// The camera is the game's chase rig, pulled back and lifted a little: the two cruisers have to fit
// between the lens and the car, which is what makes the frame read as a pursuit instead of a cruise.
// Skid smoke trails off the rear tyres (the car's own smoke pool), two rubber marks are laid on the
// asphalt, and three translucent copies of the shell behind the car give the frame its speed blur.
// ==============================================================================================
const CHASE_Z = -206;
const CHASE_KMH = 96;

function stageChase(ctx) {
  const { player, city, state, hud, traffic, scene, police, combat, camera } = ctx;
  const root = openProps(scene);
  const props = propBatches();
  const used = new Set();
  const speed = CHASE_KMH / 3.6;

  // --- the player's car: a Tiburón at 96, north up Avenida Sol --------------------------------
  const car = ensureBrand(traffic, scene, 'tiburon', 0x8c2f2a, used);
  poseCar(car, SOL + LANE_IN, CHASE_Z, NORTH, speed);
  car.lightsOn = false;                 // golden hour, headlights down
  car.refreshLamps();

  player.teleport(SOL + LANE_IN, CHASE_Z, NORTH);
  player.enterCar(car);
  for (let i = 0; i < 30; i += 1) player.pointCamera(NORTH, -0.03);   // settle the chase spring

  const cx = car.state.pos.x;
  const cz = car.state.pos.z;

  // the rig: 11 m back, 3.5 m up, aimed down the boulevard so the car sits low in frame and the two
  // cruisers fit between the lens and the tail instead of being cropped by the edges
  camera.position.set(cx + 1.2, 3.75, cz - 12.5);
  camera.lookAt(cx - 0.6, 1.15, cz + 14.0);
  camera.fov = 74;
  camera.updateProjectionMatrix();

  // the job in the HUD is the real one: Harbour Run's escape step, published by missions.js
  if (ctx.missions) ctx.missions.start(2, { teleport: false, step: 2 });

  // --- the pursuit: two cruisers behind, bars lit, 3 stars --------------------------------------
  // one on the player's right rear quarter, one swung out over the centre line: a pair, not a queue
  police.stageCruiser({ x: SOL + LANE_IN + 4.9, z: cz - 4.9, yaw: NORTH + 0.04, speed, stars: 3 });
  police.stageCruiser({ x: SOL + LANE_IN - 3.2, z: cz - 6.6, yaw: NORTH - 0.05, speed });
  // a third unit still coming up the boulevard, behind the lens: it is off camera, but its dot on the
  // minimap is what makes the plate read as a pursuit closing from the south rather than a parked pair
  police.stageCruiser({ x: SOL + LANE_OUT, z: cz - 44, yaw: NORTH, speed });

  // --- traffic ahead: two civilian cars in the lanes, northbound ---------------------------------
  const moving = takeCars(traffic, ['lagarto', 'abeja'], used);
  const ahead = [
    [SOL + LANE_IN, cz + 27, NORTH],
    [SOL + LANE_OUT, cz + 42, NORTH],
  ];
  moving.forEach((other, i) => {
    const [x, z, yaw] = ahead[i];
    poseCar(other, x, z, yaw, 11);
  });

  // --- a group on the east sidewalk, watching the chase go past ----------------------------------
  const taken = [];
  const crowd = [[-23.1, 17], [-22.2, 18.6], [-23.4, 20.2], [-21.8, 22.0], [-22.6, 24.2]];
  for (let i = 0; i < crowd.length; i += 1) {
    const [x, dz] = crowd[i];
    const spot = clearSpot(city.colliders, x, cz + dz, cx, cz, taken);
    taken.push(spot);
    sidewalkWalker(traffic, spot.x, spot.z, 1, 10);
  }
  const west = [[-49.6, 21], [-50.0, 31]];
  for (let i = 0; i < west.length; i += 1) {
    const [x, dz] = west[i];
    const spot = clearSpot(city.colliders, x, cz + dz, cx, cz, taken);
    taken.push(spot);
    sidewalkWalker(traffic, spot.x, spot.z, 1, 10);
  }
  traffic.refresh();

  // --- skid marks and the motion-blur ghosts -----------------------------------------------------
  // two rubber lines off the rear tyres, laid flat on the asphalt just above the road surface
  for (const side of [-1, 1]) {
    box(props.matte, 0x17181a, cx + side * 0.78, 0.036, cz - 4.2, 0.26, 0.012, 7.4, 0);
  }
  finishProps(root, props);
  addMotionGhosts(root, car);

  // --- skid smoke: the car's own puff pool, three plumes behind each rear wheel -------------------
  if (car.ensureSmoke) {
    car.ensureSmoke(scene);
    for (let i = 0; i < 3; i += 1) {
      car.puff(1 / 60, 1, 0xcfc9bc, 0.7);
      car.stepSmoke(0.12);
    }
  }
  // and a soft static plume drawn by the effects pool: it holds its opacity in a still frame, so the
  // trail is graded by hand rather than aged — thick at the tyre, thin by the time it reaches the lens
  if (combat && combat.effects) {
    for (let i = 0; i < 3; i += 1) {
      combat.effects.puff(
        { x: cx + (i % 2 ? 0.95 : -0.95), y: 0.2 + i * 0.04, z: cz - 3.4 - i * 1.0 },
        0.34 + i * 0.12, 0xd6d0c4, 0.3,
      );
    }
  }

  // --- HUD: 3 stars, the mission that put him there, a pistol in his hand ------------------------
  player.health = 100;
  player.armour = 62;
  state.money = 1050;
  state.radio = 'Lume Bass';
  state.district = districtAt(city, car.state.pos.x, car.state.pos.z);
  if (combat) {
    combat.select('pistol', true);
    state.weapon = combat.weapon;
    state.ammo = combat.ammo;
  }
  state.stars = police.stars;
  state.police = police.dots();

  hud.show();
  hud.setPrompt('');
  hud.toast('Mira: shake them before the pier, Rafa');
  hud.update(state, 0);
}

// Three translucent copies of the shell, stepped back along the road and fading out: the cheapest
// honest motion blur a still frame can carry (no post-processing, no extra render target).
function addMotionGhosts(root, car) {
  const geo = car._internal.geo.body.clone();
  for (let i = 1; i <= 3; i += 1) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x8c2f2a, transparent: true, opacity: 0.17 / i,
      depthWrite: false, toneMapped: false,
    });
    const ghost = new THREE.Mesh(geo, mat);
    ghost.position.set(car.state.pos.x, 0, car.state.pos.z - i * 0.95);
    ghost.rotation.y = car.state.yaw + Math.PI;
    ghost.renderOrder = 2;
    root.add(ghost);
  }
}

// mission — "Last Sunset": Cesar Vela's crew on the Colinas stretch of Avenida Sol. The four guards
// are the ones systems/missions.js spawns for the job's kill step; two of them are put down through
// the same hit path a player's bullet takes, and the burst in the frame is combat.fire() aimed down
// the street. Nothing here draws a tracer the combat system did not make.
//
// Staged on the road, not in the Mercado square the job's earlier frame used: that market hangs
// striped 1.55 m canopies over its aisles, and a lens standing among the stalls shot the underside
// of one across the top half of the picture. Colinas' ring sits on open asphalt either side of the
// avenue, so the lens behind Rafa has sky above it and the crew reads across the road.
function stageMission(ctx) {
  const { player, state, hud, combat, missions, police, city } = ctx;
  if (!missions) return;

  // the real job, at its kill step, so the spawn, the counters and the HUD line are all the game's
  const MISSION = 4;                       // last-sunset, the Colinas firefight
  const YAW = Math.PI + 0.64;              // north-east, up the avenue at the east pair
  missions.start(MISSION, { teleport: true, step: 1 });
  player.teleport(-38, 186, YAW);
  player.health = 78;
  player.armour = 34;
  combat.select('smg', true);
  combat.setAiming(true);
  player.pointCamera(YAW, -0.015);

  // two of the four are already down (the far pair, so the two nearest still read in frame)
  const targets = missions.guardTargets();
  if (targets[0]) targets[0].hit(400);
  if (targets[1]) targets[1].hit(400);

  // and one real burst at the survivor straight ahead: tracer, muzzle flash, impact puff
  combat.fire();
  combat.fire();

  // the kill counter in the HUD line comes from the system, not from this scene
  missions.publish();
  state.district = districtAt(city, player.position.x, player.position.z);
  state.stars = police.stars;
  state.police = police.dots();
  state.weapon = combat.weapon;
  state.ammo = combat.ammo;
  state.inCar = false;

  hud.show();
  hud.setPrompt('');
  hud.toast('Mira: the ledger is in the back stall — make it quick');
  hud.update(state, 0);
}

// Complete a job through its real steps: teleport into a car for a driving step, stand on the
// marker for a foot step, spend the guards' health through the same hit path combat uses, and drop
// the wanted level for an escape. missions.update() is the only thing advancing, never a flag write.
function runJob(ctx, index) {
  const { missions, player, traffic, police } = ctx;
  if (!missions) return false;
  missions.start(index, { teleport: true, completed: missions.completed });
  for (let guard = 0; guard < 16; guard += 1) {
    if (missions.index !== index || !missions.running || missions.failed) break;
    const m = missions.mission;
    const step = m ? m.steps[missions.step] : null;
    if (!step) break;
    if (step.kind === 'car') {
      if (!player.car) {
        const car = takeCars(traffic, ['viento', 'abeja', 'tiburon', 'marea'])[0];
        if (car) player.enterCar(car);
      }
    } else if (step.kind === 'reach') {
      if (step.car && !player.car) {
        const car = takeCars(traffic, ['marea', 'faro', 'lagarto'])[0];
        if (car) player.enterCar(car);
      }
      if (!step.car && player.car) player.exitCar();
      const car = player.car;
      if (step.car && car) {
        car.setPose(step.x, step.z, 0);
        car.syncTransform();
        player.position.set(step.x, 0.4, step.z);
      } else {
        player.teleport(step.x, step.z, 0);
      }
    } else if (step.kind === 'kill') {
      for (const t of missions.guardTargets()) t.hit(999);
    } else if (step.kind === 'escape') {
      police.setStars(1);
      missions.update(1 / 60);
      police.setStars(0);
    }
    missions.update(1 / 60);
  }
  return missions.completed.includes(MISSIONS[index].id);
}

// map — the real Tab overlay over the city, opened after two jobs were actually finished: the job
// list shows those two ticked, the live third job's markers are on the plate, and the cash is the
// reward money the missions system paid out.
function stageMap(ctx) {
  const { missions, mapOverlay, state, player, police, hud, city, save } = ctx;
  if (!missions || !mapOverlay) return;
  runJob(ctx, 0);
  runJob(ctx, 1);
  // a waypoint the player could have clicked: the pier gate, on the live job's route
  mapOverlay.setWaypoint(0, -330);
  state.district = districtAt(city, player.position.x, player.position.z);
  const view = {
    player: { x: player.position.x, z: player.position.z },
    heading: player.heading,
    money: state.money,
    district: state.district,
    police: police.dots(),
    completed: missions.completed,
    mission: state.mission,
    total: MISSIONS.length,
  };
  hud.hide();
  mapOverlay.show(view);
  // the save the map is standing in for: written here so the frame is not a drawing of progress but
  // the progress itself (the same call the pause screen makes)
  if (save && save.writeSave) {
    save.writeSave({
      v: 1, mission: missions.index, step: missions.step, finished: missions.finished,
      money: state.money, completed: missions.completed,
      player: {
        x: player.position.x, z: player.position.z, health: player.health, armour: player.armour,
        weapon: state.weapon, ammo: state.ammo || { pistol: 0, smg: 0 },
      },
    });
  }
}

const SCENES = {
  cover: stageCover, drive: stageDrive, chase: stageChase, mission: stageMission, heist: stageMission, map: stageMap,
};

// ==============================================================================================
// Live street dressing — cars and walkers come out of systems/traffic.js, never out of this file
// ----------------------------------------------------------------------------------------------
// Lane offsets are traffic.js's own (LANE_NEAR 3 m, LANE_FAR 9 m, right of the centre line), so a
// posed car sits exactly where a driving one would. A pose is a pose: the car keeps its brand, its
// paint, its wheels and its AI, and if the simulation runs again it drives off from there.
// ==============================================================================================
const NORTH = Math.PI;         // yaw PI looks north (+z)
const SOUTH = 0;               // yaw 0 looks south, at the sea
const LANE_IN = 3.0;
const LANE_OUT = 9.0;
const KERB_PARK = 10.4;        // a car pulled up against the near kerb

// Park or drive a live car at a pose. A non-zero speed is written into the chassis AND its world
// velocity, so the wheels, the camera's FOV and the HUD all read the same motion.
function poseCar(car, x, z, yaw, speed = 0) {
  car.setPose(x, z, yaw);
  car.state.speed = speed;
  car.state.vel.set(-Math.sin(yaw) * speed, 0, -Math.cos(yaw) * speed);
  car.syncTransform();
  car.refreshLamps();
  for (const w of car.wheels) w.spin = 0;
}

// Take live cars out of the fleet, one per brand where the pool allows it, so the street shows the
// whole range instead of seven clones. Cars already claimed by the scene are skipped.
function takeCars(traffic, brands, used = new Set()) {
  const pool = (traffic && traffic.cars) || [];
  const out = [];
  for (const key of brands) {
    let pick = pool.find((c) => c && !c.destroyed && !used.has(c) && c.key === key);
    if (!pick) pick = pool.find((c) => c && !c.destroyed && !used.has(c));
    if (!pick) break;
    used.add(pick);
    out.push(pick);
  }
  return out;
}

// A car of this brand: borrowed from the fleet, or built by the same factory and handed to it so
// traffic.js knows about it too.
function ensureBrand(traffic, scene, key, hex, used) {
  const pool = (traffic && traffic.cars) || [];
  let car = pool.find((c) => c && !c.destroyed && !used.has(c) && c.key === key);
  if (!car) {
    car = createCar(key, hex, { driver: 'ai' });
    scene.add(car.group);
    pool.push(car);
  }
  used.add(car);
  return car;
}

// A walker on a straight stretch of sidewalk, standing on (x, z) and heading dir (+1 north, -1
// south). addWalker() is traffic.js's own spawn: instanced parts, per-instance colours, a stride
// driven by the path, and the same figure the crowd in a played session is made of. `s` is the
// distance along the path, so half the span puts the figure where the scene asked for it.
function sidewalkWalker(traffic, x, z, dir, span = 26) {
  const a = dir > 0 ? z - span / 2 : z + span / 2;
  const b = dir > 0 ? z + span / 2 : z - span / 2;
  return traffic.addWalker({ path: [{ x, z: a }, { x, z: b }], s: span / 2, dir: 1, y: PAD_Y, idle: 0 });
}

// A walker out over the asphalt, `s` metres along a kerb-to-kerb line: the jaywalker. y = 0 because
// the road is 16 cm below the sidewalk pad.
function crossWalker(traffic, fromX, toX, z, s) {
  return traffic.addWalker({
    path: [{ x: fromX, z }, { x: toX, z }],
    s, dir: 1, y: 0.02, idle: 0,
  });
}

// True when a figure at (x, z) is clear of the solids the city registered. A palm trunk is drawn
// ~2.6 m across on a 0.84 m collider, so it gets the berth it looks like it needs; lamp posts and
// kiosks get a hugging one. Kerbs and lane paint are below the knee and never count.
function clearOfSolids(colliders, x, z, r = 0.55) {
  for (let i = 0; i < colliders.length; i += 1) {
    const c = colliders[i];
    if (c.height !== undefined && c.height < 0.6) continue;
    const span = Math.min(c.maxX - c.minX, c.maxZ - c.minZ);
    const pad = span > 0.7 && span < 1.0 ? 1.7 : r;
    if (x + pad <= c.minX || x - pad >= c.maxX || z + pad <= c.minZ || z - pad >= c.maxZ) continue;
    return false;
  }
  return true;
}

// Nudge a walker's z until it clears the street furniture, the player's own body and the walkers
// already placed, keeping the x the sidewalk band gave it.
function clearSpot(colliders, x, z, px, pz, taken = []) {
  let cz = z;
  for (let i = 0; i < 12; i += 1) {
    const clear = clearOfSolids(colliders, x, cz);
    const offBody = Math.hypot(x - px, cz - pz) > 1.3;
    const offCrowd = taken.every((t) => Math.hypot(t.x - x, t.z - cz) > 1.1);
    if (clear && offBody && offCrowd) break;
    cz += 0.8;
  }
  return { x, z: cz };
}

// ==============================================================================================
// Posing
// ==============================================================================================

// Walk Rafa forward for a few fixed frames and stop on the frame where the stride is widest. The
// cycle is driven by distance travelled, so distance — not time — is what picks the pose.
function poseStride(player, yaw) {
  const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
  player.setActive(true);
  player.pointCamera(yaw, -0.09);
  key('keydown', 'KeyW');
  key('keydown', 'ShiftLeft');
  for (let i = 0; i < 90; i += 1) {
    player.update(1 / 60);
    const phase = (player.distance / 1.5) * Math.PI * 2;   // 1.5 m stride at a sprint
    if (player.speed > 6.4 && Math.sin(phase) > 0.8) break;
  }
  key('keyup', 'KeyW');
  key('keyup', 'ShiftLeft');
  player.setActive(false);
}

function districtAt(city, x, z) {
  const list = (city && city.districts) || [];
  const hit = list.find((d) => x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ);
  return hit ? hit.name : '';
}

// ==============================================================================================
// Props — one merged, vertex-coloured mesh per material, so a whole dressed street costs 3 draws
// ==============================================================================================
const BUCKETS = ['paint', 'matte', 'glass'];

function propBatches() {
  const out = {};
  for (const k of BUCKETS) out[k] = { pos: [], nor: [], uv: [], col: [] };
  return out;
}

function openProps(scene) {
  clearShotProps();
  const root = new THREE.Group();
  root.name = 'shot-props';
  scene.add(root);
  window.__shotRoot = root;
  return root;
}

export function clearShotProps() {
  const root = window.__shotRoot;
  if (!root) return;
  if (root.parent) root.parent.remove(root);
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m) m.dispose();
  });
  window.__shotRoot = null;
}

const MATERIALS = {
  paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.40, metalness: 0.34 }),
  matte: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.02 }),
  glass: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.14, metalness: 0.55 }),
};

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scale = new THREE.Vector3(1, 1, 1);
const _mat = new THREE.Matrix4();
const _color = new THREE.Color();

function emit(batch, hex, geometry, x, y, z, yaw = 0, roll = 0) {
  _pos.set(x, y, z);
  _euler.set(0, yaw, roll, 'YXZ');
  _quat.setFromEuler(_euler);
  _mat.compose(_pos, _quat, _scale);
  const before = batch.pos.length / 3;
  pushGeometry(batch, geometry, _mat);
  _color.set(hex);
  for (let i = before; i < batch.pos.length / 3; i += 1) batch.col.push(_color.r, _color.g, _color.b);
}

const _boxCache = new Map();
function boxGeo(sx, sy, sz) {
  const key = `${sx}|${sy}|${sz}`;
  let g = _boxCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(sx, sy, sz);
    _boxCache.set(key, g);
  }
  return g;
}

function box(batch, hex, x, y, z, sx, sy, sz, yaw = 0) {
  emit(batch, hex, boxGeo(sx, sy, sz), x, y, z, yaw);
}

function finishProps(root, props) {
  for (const key of BUCKETS) {
    const b = props[key];
    if (!b.pos.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, MATERIALS[key]);
    mesh.name = `shot-${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}

// a boardwalk stall: counter, four posts, a striped canopy, crates of produce on top
function stall(props, x, z, yaw) {
  const m = props.matte;
  box(m, 0x8a6a4c, x, PAD_Y + 0.48, z, 2.6, 0.96, 1.7, yaw);
  for (const sx of [-1.2, 1.2]) {
    for (const sz of [-0.8, 0.8]) box(m, 0x474c50, x + sx, PAD_Y + 1.4, z + sz, 0.09, 2.0, 0.09, yaw);
  }
  for (let i = 0; i < 6; i += 1) {
    box(m, i % 2 ? 0xf2e7d2 : 0xd0563c, x - 1.3 + i * 0.52, PAD_Y + 2.42, z, 0.52, 0.08, 2.1, yaw);
  }
  const fruit = [0xe8913a, 0xc94a3f, 0x8fb84a];
  for (let i = 0; i < 3; i += 1) {
    box(m, fruit[i], x - 0.8 + i * 0.8, PAD_Y + 1.06, z + 0.25, 0.5, 0.22, 0.42, yaw);
  }
}
