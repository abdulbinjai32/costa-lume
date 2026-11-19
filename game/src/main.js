// Costa Lume — boot, renderer, world assembly, the fixed-step loop and the menu/play/pause machine.
//
// One seeded stream drives the whole world: mulberry32(hashSeed(?seed=)) feeds createTextures, then
// buildCity, then the shot dressing, in that order, so the same URL always rebuilds the same Costa
// Lume. Nothing here calls Math.random.
//
// The loop is fixed-step: real time accumulates into a 1/60 s accumulator, at most four steps run per
// frame (a stall drops the backlog instead of spiralling), and every animated system — player,
// police, combat, traffic, missions — is fed that fixed dt while the mode is 'playing' and by nothing
// at all while it is 'paused' or 'map'. That is what makes the pause real: no mission timer, no
// siren, no guard trigger, no traffic moves.
//
// Modes: menu (title over a live street) | playing | paused | map | shot (a scripted screenshot).
import * as THREE from 'three';
import { mulberry32, hashSeed } from './util/rng.js';
import { createTextures } from './world/textures.js';
import { createSky } from './world/sky.js';
import { buildCity } from './world/city.js';
import { createPlayer, PLAYER } from './entities/player.js';
import { nearestCar } from './entities/vehicles.js';
import { createHud } from './ui/hud.js';
import { createMenus } from './ui/menu.js';
import { createMapOverlay } from './ui/mapoverlay.js';
import { startTraffic } from './systems/traffic.js';
import { createPolice } from './systems/police.js';
import { createCombat } from './systems/combat.js';
import { createMissions, MISSIONS } from './systems/missions.js';
import { createAudio } from './audio/audio.js';
import { readSave, writeSave, clearSave } from './systems/save.js';
import { stageShot } from './shots.js';

const STEP = 1 / 60;            // fixed simulation step, seconds
const MAX_STEPS = 4;            // a slow frame may catch up 4 steps, no further
const DEFAULT_SEED = 'costa-lume';
const MAX_BUFFER_PIXELS = 2560 * 1440;

const params = new URLSearchParams(window.location.search);
const SEED_TEXT = params.get('seed') || DEFAULT_SEED;
const SEED = hashSeed(String(SEED_TEXT));
const SHOT = params.get('shot');

// ---------------------------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------------------------
function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.24;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // stats read one frame's numbers, so the counters reset by hand just before each render
  renderer.info.autoReset = false;
  return renderer;
}

function resizeToWindow(renderer, camera) {
  const w = window.innerWidth || 1280;
  const h = window.innerHeight || 720;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  // cap the drawing buffer: a 4K panel at dpr 1.5 would otherwise ask for 4x the fill rate
  const budget = Math.min(1, Math.sqrt(MAX_BUFFER_PIXELS / (w * h * dpr * dpr)));
  renderer.setPixelRatio(Math.max(1, dpr * budget));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------
function createCamera(aspect) {
  const camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 2600);
  camera.name = 'costa-lume-camera';
  return camera;
}

// textures first, then the sky (which owns the fog and the lighting rig), then the city on that grid,
// then the street life: traffic and walkers seeded from the same stream, wired to the player so F can
// take a car out of it.
function assembleWorld(renderer, canvas) {
  const rng = mulberry32(SEED);
  const textures = createTextures(rng);

  const scene = new THREE.Scene();
  const camera = createCamera(window.innerWidth / window.innerHeight);
  const sky = createSky(scene, textures.waterNormal);

  const city = buildCity(scene, rng, textures);
  const traffic = startTraffic(city, scene, rng);
  const player = createPlayer({ scene, camera, city, dom: canvas });
  player.setTraffic(traffic);
  const hud = createHud({ city });

  return { rng, textures, scene, camera, sky, city, traffic, player, hud };
}

// ---------------------------------------------------------------------------------------------
// Game state: one object per frame, read by the HUD and written by shots/missions
// ---------------------------------------------------------------------------------------------
function createGameState(player) {
  return {
    money: 250,
    health: player.health,
    armour: player.armour,
    maxHealth: 100,
    maxArmour: 100,
    stars: 0,
    weapon: 'fists',
    ammo: null,
    speedKmh: 0,
    inCar: false,
    carBrand: '',
    radio: 'Radio Sol',
    sound: 'Sound on · M',
    mission: {
      id: 'first-fare',
      title: 'First Fare',
      objective: 'Steal a car — any set of wheels on the boulevard',
      marker: null,
    },
    waypoint: null,
    district: 'Playa Norte',
    heading: 0,
    prompt: '',
    player,
    police: [],
    traffic: [],
    walkers: [],
  };
}

function districtAt(city, x, z) {
  const list = (city && city.districts) || [];
  const hit = list.find((d) => x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ);
  return hit ? hit.name : '';
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
const canvas = document.getElementById('view');
const renderer = createRenderer(canvas);
const world = assembleWorld(renderer, canvas);
const { scene, camera, sky, city, traffic, player, hud, textures } = world;
const state = createGameState(player);

// Sound first: the systems below take it as a dependency (police siren, combat gunshots) and stay
// silent until the first gesture builds the context.
const audio = createAudio();

// The two stage-3 systems: police owns the wanted level and everything that answers to it, combat owns
// the guns, the shots and the pickups. Both write into `state` (cash, stars) and read the player.
const police = createPolice({
  scene, city, player, hud, rng: world.rng, audio, traffic, game: state,
});
const combat = createCombat({
  scene, camera, player, police, traffic, hud, rng: world.rng, audio, city, game: state,
});

const missions = createMissions({
  scene, city, player, hud, police, combat, audio, game: state,
  onComplete: () => saveGame('mission'),
  onFail: () => { refreshState(); },
  onAdvance: () => saveGame('objective'),
});
combat.registerTargets(() => missions.guardTargets());

resizeToWindow(renderer, camera);
window.addEventListener('resize', () => resizeToWindow(renderer, camera));

let mode = 'menu';              // menu | playing | paused | map | shot
let accumulator = 0;
let bootHidden = false;
let playSeconds = 0;

// the menu backdrop: Rafa on the Playa Norte kerb, the avenue running south to the sea
const HERO = { x: -22.2, z: -224, yaw: 0.12 };

const mapOverlay = createMapOverlay({
  city,
  missions: { route: () => missions.route(), missionList: MISSIONS },
  onWaypoint: (w) => { state.waypoint = w; },
});

function enterMenu() {
  mode = 'menu';
  accumulator = 0;
  player.setActive(false);
  player.teleport(HERO.x, HERO.z, HERO.yaw);
  player.pointCamera(HERO.yaw, -0.04);
  hud.hide();
  menus.showStart();
  menus.setContinue(hasValidSave(), saveNote());
  mapOverlay.hide();
  audio.engine(0, false);
  audio.siren(false);
  audio.radioOn(false);
  releasePointer();
}

function enterPlaying() {
  mode = 'playing';
  accumulator = 0;
  menus.hideStart();
  menus.hidePause();
  hud.show();
  player.setActive(true);
  player.lockPointer();
  audio.unlock();
}

function enterPaused() {
  if (mode !== 'playing') return;
  mode = 'paused';
  accumulator = 0;
  player.setActive(false);
  menus.showPause();
  // pausing is the save point: every pause writes the same document the save button does
  const saved = saveGame('pause');
  if (menus.setPauseStatus) menus.setPauseStatus(`${pauseLine()}  ·  ${saved ? 'Saved' : 'Not saved'}`);
  hud.hide();
  audio.engine(0, false);
  audio.radioOn(false);
  releasePointer();
}

// "Wanted ★★★☆☆ · Pistol 9/48 · First Fare" on the pause plate: what you left on the street.
function pauseLine() {
  const stars = police.stars;
  const wanted = stars > 0 ? `Wanted ${'\u2605'.repeat(stars)}${'\u2606'.repeat(5 - stars)}` : 'No wanted level';
  const ammo = combat.ammo;
  const gun = ammo ? `${combat.weaponName} ${ammo.mag}/${ammo.reserve}` : combat.weaponName;
  const job = missions.finished ? 'Story complete' : missions.mission ? missions.mission.title : 'Free roam';
  return `${wanted}  \u00b7  ${gun}  \u00b7  ${job}`;
}

function resumePlaying() {
  if (mode !== 'paused') return;
  mode = 'playing';
  accumulator = 0;
  menus.hidePause();
  hud.show();
  player.setActive(true);
  player.lockPointer();
  audio.unlock();
}

function openMap() {
  if (mode !== 'playing') return;
  mode = 'map';
  accumulator = 0;
  player.setActive(false);
  hud.hide();
  releasePointer();
  audio.engine(0, false);
  mapOverlay.show(mapState());
}

function closeMap() {
  if (mode !== 'map') return;
  mode = 'playing';
  accumulator = 0;
  mapOverlay.hide();
  hud.show();
  player.setActive(true);
  player.lockPointer();
}

function releasePointer() {
  const doc = document;
  if (doc.pointerLockElement && doc.exitPointerLock) {
    try { doc.exitPointerLock(); } catch (err) { /* already released */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Save / load
// ---------------------------------------------------------------------------------------------
function currentSnapshot() {
  return {
    v: 1,
    mission: Math.min(missions.index, MISSIONS.length - 1),
    step: missions.step,
    finished: missions.finished,
    money: state.money,
    completed: missions.completed,
    player: {
      x: player.position.x,
      z: player.position.z,
      health: Math.max(1, player.health),
      armour: player.armour,
      weapon: combat.weapon,
      ammo: combat.ammoSummary(),
    },
    muted: audio.muted,
    playSeconds,
  };
}

function saveGame(why = 'pause') {
  if (mode === 'menu' || mode === 'shot') return false;
  const ok = writeSave(currentSnapshot()).ok;
  if (ok && why === 'pause' && hud && hud.toast) hud.toast('Game saved');
  return ok;
}

function hasValidSave() {
  return readSave(undefined, MISSIONS.length).ok;
}

function saveNote() {
  const read = readSave(undefined, MISSIONS.length);
  if (!read.ok) return 'Resume the last saved job';
  const m = MISSIONS[Math.min(read.data.mission, MISSIONS.length - 1)];
  const step = read.data.finished ? 'story complete' : m ? `step ${read.data.step + 1} of ${m.steps.length}` : '';
  return `Resume ${m ? m.title : 'Costa Lume'} · ${step}`;
}

function loadGame() {
  const read = readSave(undefined, MISSIONS.length);
  if (!read.ok) return false;
  const d = read.data;
  // clear anything a previous run left on the street before the save takes over
  police.clear();
  combat.select(d.player.weapon, true);
  if (combat.restoreAmmo) combat.restoreAmmo(d.player.ammo);
  player.health = d.player.health;
  player.armour = d.player.armour;
  state.money = d.money;
  state.waypoint = null;
  audio.setMuted(d.muted === true);
  refreshSoundLabel();
  player.teleport(d.player.x, d.player.z, player.heading || 0);
  missions.restore({ mission: d.mission, step: d.step, finished: d.finished, completed: d.completed });
  playSeconds = d.playSeconds || 0;
  return true;
}

function newGame() {
  clearSave();
  state.money = 250;
  state.waypoint = null;
  player.health = 100;
  player.armour = 50;
  combat.select('fists', true);
  combat.restoreAmmo({ pistol: 0, smg: 0 });
  police.clear();
  missions.start(0, { completed: [], teleport: true });
  playSeconds = 0;
}

function refreshSoundLabel() {
  state.sound = audio.muted ? 'Sound off · M' : 'Sound on · M';
}

// ---------------------------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------------------------
const menus = createMenus({
  onStart: () => { audio.unlock(); player.lockPointer(); },
  onNew: () => {
    newGame();
    enterPlaying();
  },
  onContinue: () => {
    audio.unlock();
    if (!loadGame()) {
      hud.toast('No readable save — starting a new game');
      newGame();
    }
    enterPlaying();
  },
  onResume: () => resumePlaying(),
  onSave: () => {
    const ok = saveGame('button');
    if (menus.setPauseStatus) menus.setPauseStatus(`${pauseLine()}  ·  ${ok ? 'Saved' : 'Save failed'}`);
  },
  onRetry: () => {
    missions.retry();
    resumePlaying();
  },
  onQuit: () => enterMenu(),
});

// ---------------------------------------------------------------------------------------------
// Keys: Esc pause/back, Tab map, Enter retry, M mute, T radio, H horn. The player and combat own
// their own keys (WASD/F/C and 1/2/3/R) and ignore everything while they are inactive.
// ---------------------------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (mode === 'map') { closeMap(); return; }
    if (mode === 'playing') enterPaused();
    else if (mode === 'paused') resumePlaying();
    return;
  }
  if (e.code === 'Tab') {
    if (mode === 'playing') { e.preventDefault(); openMap(); }
    else if (mode === 'map') { e.preventDefault(); closeMap(); }
    return;
  }
  if (mode !== 'playing') {
    if (e.code === 'Enter' && mode === 'paused' && missions.failed) { missions.retry(); resumePlaying(); }
    return;
  }
  if (e.code === 'Enter' && missions.failed) { missions.retry(); return; }
  if (e.code === 'KeyM') { toggleMute(); return; }
  if (e.code === 'KeyT') {
    const name = audio.stationNext();
    state.radio = name;
    hud.toast(`Radio: ${name}`);
    return;
  }
  if (e.code === 'KeyH' && player.car && !player.onFoot) audio.horn();
});

function toggleMute() {
  const muted = audio.toggleMute();
  refreshSoundLabel();
  hud.toast(muted ? 'Sound off' : 'Sound on');
  try { localStorage.setItem('costa-lume.muted', muted ? '1' : '0'); } catch (err) { /* no storage */ }
}

canvas.addEventListener('click', () => {
  if (mode === 'playing') player.lockPointer();
});

// ---------------------------------------------------------------------------------------------
// One fixed simulation step
// ---------------------------------------------------------------------------------------------
// The eye traffic.js steers its drivers and walkers around: the player on foot, or the car he is
// holding — stepDriving() in player.js copies the chassis onto position, so one read covers both.
const eye = { x: 0, z: 0, yaw: 0 };

function updateFrame(dt) {
  // F / C are handled by player.js's own key listener (it is the only place the car changes hands),
  // so the frame only has to step: the player first, so everything else sees this step's pose.
  // Order matters: the rig places the camera before combat fires through it, police answers to a
  // body on the pavement before traffic walks past it, and traffic moves last so it can dodge.
  player.update(dt);
  eye.x = player.position.x;
  eye.z = player.position.z;
  eye.yaw = player.heading;
  police.update(dt);
  combat.update(dt);
  missions.update(dt);
  traffic.update(dt, eye);
  sky.update(player.position, dt);
  playSeconds += dt;

  // sound follows the same step: engine load from the car, siren from the wanted level, radio only
  // while a car is being driven
  const car = player.car;
  const driving = !!car && !player.onFoot;
  const load = driving ? Math.min(1, Math.abs(car.state.speed) / 24) : 0;
  audio.engine(load, driving);
  audio.siren(police.stars > 0);
  audio.radioOn(driving);
}

// ---------------------------------------------------------------------------------------------
// Per-frame state refresh: the player and the car he is holding are the source of truth
// ---------------------------------------------------------------------------------------------
function refreshState() {
  state.health = player.health;
  state.armour = player.armour;
  state.heading = player.heading;

  // Wanted level and the gun in his hand: the systems are the source of truth, the HUD just reads.
  state.stars = police.stars;
  state.weapon = combat.weapon;
  state.ammo = combat.ammo;
  state.police = police.dots();

  // Driving: the chassis owns the speedometer, the brand and the camera. Reading the car's own
  // signed speed here is what keeps the HUD off the player's walk speed.
  const car = player.car;
  state.inCar = !!car && !player.onFoot;
  state.speedKmh = state.inCar ? Math.abs(car.state.speed) * 3.6 : 0;
  state.carBrand = state.inCar ? car.brand : '';

  // Minimap dots, and the F prompt: what the nearest car within reach is called.
  state.traffic = traffic.cars;
  state.walkers = traffic.pedestrians;
  state.prompt = state.inCar ? '' : promptFor();

  state.district = districtAt(city, player.position.x, player.position.z) || state.district;
  state.waypoint = mapOverlay.waypoint;
}

// "F — steal Viento" while a car is within reach on foot; nothing while driving (the prompt sits
// where a chase camera puts the car's tail).
function promptFor() {
  if (missions.failed) return 'Enter — retry the job';
  const near = nearestCar(traffic.cars, player.position.x, player.position.z, PLAYER.carReach);
  return near ? `F — steal ${near.brand}` : '';
}

function mapState() {
  return {
    player: { x: player.position.x, z: player.position.z },
    heading: player.heading,
    money: state.money,
    district: state.district,
    police: police.dots(),
    completed: missions.completed,
    mission: state.mission,
    total: MISSIONS.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Shot scenes: staged once, then the world is held still while the harness captures it
// ---------------------------------------------------------------------------------------------
let shotFrames = 0;
if (SHOT) {
  mode = 'shot';
  menus.hideStart();
  menus.hidePause();
  stageShot(SHOT, {
    scene, camera, renderer, state, player, city, hud, textures, traffic, rng: world.rng, seed: SEED,
    police, combat, missions, audio, mapOverlay, save: { writeSave, readSave },
  });
  refreshState();
  hud.update(state, 0);
}

// ---------------------------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------------------------
let last = performance.now();
let fpsFrames = 0;
let fpsSince = last;
let fps = 0;

function publishStats(now) {
  window.__stats = {
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    fps,
  };
  void now;
}

function frame(now) {
  window.requestAnimationFrame(frame);
  const real = Math.min(0.25, Math.max(0, (now - last) / 1000));
  last = now;

  if (mode === 'playing') {
    accumulator += real;
    let steps = 0;
    while (accumulator >= STEP && steps < MAX_STEPS) {
      updateFrame(STEP);
      accumulator -= STEP;
      steps += 1;
    }
    if (steps === MAX_STEPS) accumulator = 0;   // drop the backlog, never spiral
  } else if (mode === 'shot') {
    // a screenshot is a still: the water keeps shimmering, the pose and the camera stay put
    sky.update(player.position, STEP);
  }

  refreshState();
  hud.update(state, real);

  renderer.info.reset();
  renderer.render(scene, camera);

  if (!bootHidden) {
    bootHidden = true;
    const boot = document.getElementById('boot');
    if (boot) boot.classList.add('done');
  }

  if (SHOT && mode === 'shot') {
    shotFrames += 1;
    if (shotFrames === 2) window.__shotReady = true;   // two frames on screen, then the harness shoots
  }

  fpsFrames += 1;
  if (now - fpsSince >= 1000) {
    fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
    fpsFrames = 0;
    fpsSince = now;
    publishStats(now);
  }
}

// the start screen renders over a live Costa Lume from the first frame; a shot page skips it
if (!SHOT) {
  try {
    if (localStorage.getItem('costa-lume.muted') === '1') audio.setMuted(true);
  } catch (err) { /* no storage */ }
  refreshSoundLabel();
  missions.publish();
  enterMenu();
}
refreshState();
hud.update(state, 0);
window.requestAnimationFrame(frame);

// handles for the console and the verification harness while building the next stages
window.__game = {
  renderer, scene, camera, sky, city, player, hud, traffic, state, police, combat, missions, audio,
  mapOverlay, menus, MISSIONS,
  get mode() { return mode; },
  get playSeconds() { return playSeconds; },
  saveGame: () => saveGame('debug'),
  loadGame,
  newGame,
  toggleMute,
  openMap,
  closeMap,
  getSave: () => readSave(undefined, MISSIONS.length),
  // test hook: drop straight into a mode without the menu click
  enterPlaying,
  enterPaused,
  setMoney: (v) => { state.money = v; },
};
