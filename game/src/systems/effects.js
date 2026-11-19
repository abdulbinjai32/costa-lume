// Costa Lume — transient shot dressing: tracers, muzzle flash, dust puffs and metal sparks.
//
// systems/combat.js (Rafa's guns) and systems/police.js (the officers' return fire) both put bullets
// in the air, so the look of a single shot lives here once: one stretched additive box per tracer that
// fades out in under half a second, ONE shared point light behind every muzzle flash (a flash is
// ~60 ms of light and it dies immediately), and pooled sprites for dust puffs and metal sparks.
//
// Pools are built on the first call and reused, so a firefight allocates nothing mid-frame. Nothing
// here decides damage, plays audio or owns a weapon: it only draws what the systems report.
import * as THREE from 'three';

const TRACER_POOL = 16;
const PUFF_POOL = 20;
const SPARK_POOL = 12;
const TRACER_LIFE = 0.40;     // seconds — inside the half-second the brief allows
const PUFF_LIFE = 0.55;
const SPARK_LIFE = 0.26;
const FLASH_DECAY = 26;       // light intensity falls by e every ~38 ms

const FORWARD = new THREE.Vector3(0, 0, 1);   // the tracer box's long axis

// A soft round sprite: smoke, dust and spark glows all use the same canvas. Exported so
// systems/police.js can hang the siren halo off the same picture instead of a second canvas.
let _disc = null;
export function softDiscTexture() {
  if (_disc) return _disc;
  const size = 64;
  const el = document.createElement('canvas');
  el.width = size;
  el.height = size;
  const ctx = el.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _disc = new THREE.CanvasTexture(el);
  _disc.colorSpace = THREE.SRGBColorSpace;
  return _disc;
}

export function createEffects(scene) {
  const group = new THREE.Group();
  group.name = 'effects';
  if (scene) scene.add(group);

  const disc = softDiscTexture();

  // ---- tracers: one additive box per shot, stretched between two points ---------------------
  const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
  const tracers = [];
  for (let i = 0; i < TRACER_POOL; i += 1) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe6b0, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
    });
    const mesh = new THREE.Mesh(tracerGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.name = `tracer-${i}`;
    group.add(mesh);
    tracers.push({ mesh, mat, life: 0 });
  }
  let tracerTurn = 0;

  // ---- sprites: dust puffs and metal sparks ---------------------------------------------------
  const makeSprite = (colour, blending) => {
    const mat = new THREE.SpriteMaterial({
      map: disc, color: colour, transparent: true, opacity: 0,
      blending, depthWrite: false, fog: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    sprite.frustumCulled = false;
    group.add(sprite);
    return { sprite, mat, life: 0, max: 1, vx: 0, vy: 0, vz: 0, grow: 0, size: 0.6, alpha: 0.6 };
  };
  const puffs = [];
  for (let i = 0; i < PUFF_POOL; i += 1) puffs.push(makeSprite(0xd8cbb6, THREE.NormalBlending));
  const sparks = [];
  for (let i = 0; i < SPARK_POOL; i += 1) sparks.push(makeSprite(0xffcf7a, THREE.AdditiveBlending));
  let puffTurn = 0;
  let sparkTurn = 0;

  // ---- the muzzle light: one for the whole system, moved to whichever barrel just fired --------
  const flash = new THREE.PointLight(0xffd59a, 0, 9, 2);
  flash.name = 'muzzle-flash';
  group.add(flash);

  const _dir = new THREE.Vector3();
  const _mid = new THREE.Vector3();

  // A tracer from a muzzle to wherever the round stopped. `width` is the visual bore, not a calibre.
  function tracer(from, to, colour = 0xffe6b0, width = 0.035) {
    if (!from || !to) return;
    const t = tracers[tracerTurn];
    tracerTurn = (tracerTurn + 1) % tracers.length;
    _dir.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const len = _dir.length();
    if (len < 1e-3) return;
    _dir.divideScalar(len);
    _mid.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
    t.mesh.position.copy(_mid);
    t.mesh.quaternion.setFromUnitVectors(FORWARD, _dir);
    t.mesh.scale.set(width, width, len);
    t.mat.color.setHex(colour);
    t.mat.opacity = 0.9;
    t.mesh.visible = true;
    t.life = TRACER_LIFE;
  }

  // A flash light plus its little hot core, for one frame of light.
  function muzzle(point, colour = 0xffd59a) {
    if (!point) return;
    flash.position.set(point.x, point.y, point.z);
    flash.color.setHex(colour);
    flash.intensity = 9;
    const s = sparks[sparkTurn];
    sparkTurn = (sparkTurn + 1) % sparks.length;
    s.sprite.position.copy(point);
    s.mat.color.setHex(0xfff0cf);
    s.mat.opacity = 1;
    s.sprite.scale.setScalar(0.34);
    s.sprite.visible = true;
    s.life = 0.045;
    s.max = 0.045;
    s.alpha = 1;
    s.grow = 0.8;
    s.vx = 0; s.vy = 0; s.vz = 0;
  }

  // Dust, plaster, blood-free hit puff: it rises slowly and thins out. `alpha` lets a caller lay a
  // thin plume (a skid trail in a screenshot) instead of a thick one.
  function puff(point, size = 0.55, colour = 0xd8cbb6, alpha = 0.55) {
    if (!point) return;
    const p = puffs[puffTurn];
    puffTurn = (puffTurn + 1) % puffs.length;
    p.sprite.position.set(point.x, point.y, point.z);
    p.mat.color.setHex(colour);
    p.mat.opacity = alpha;
    p.sprite.scale.setScalar(size);
    p.sprite.visible = true;
    p.life = PUFF_LIFE;
    p.max = PUFF_LIFE;
    p.size = size;
    p.alpha = alpha;
    p.grow = 1.5;
    p.vx = 0.25;
    p.vy = 0.55;
    p.vz = 0.25;
  }

  // A spark off metal: bright, small, gone in a quarter second.
  function spark(point, colour = 0xffcf7a) {
    if (!point) return;
    const s = sparks[sparkTurn];
    sparkTurn = (sparkTurn + 1) % sparks.length;
    s.sprite.position.set(point.x, point.y, point.z);
    s.mat.color.setHex(colour);
    s.mat.opacity = 0.95;
    s.sprite.scale.setScalar(0.26);
    s.sprite.visible = true;
    s.life = SPARK_LIFE;
    s.max = SPARK_LIFE;
    s.size = 0.26;
    s.alpha = 0.95;
    s.grow = -0.55;
    s.vx = 0;
    s.vy = 0.9;
    s.vz = 0;
  }

  const step = (pool, dt, rise) => {
    for (const p of pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.sprite.visible = false; p.mat.opacity = 0; continue; }
      const t = 1 - p.life / p.max;
      const sc = Math.max(0.02, p.size * (1 + p.grow * t));
      p.sprite.scale.setScalar(sc);
      p.mat.opacity = Math.max(0, (1 - t) * (1 - t)) * p.alpha;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += (p.vy + rise) * dt;
      p.sprite.position.z += p.vz * dt;
    }
  };

  function update(dt) {
    if (!dt || dt <= 0) return;
    for (const t of tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) { t.mesh.visible = false; t.mat.opacity = 0; continue; }
      const k = t.life / TRACER_LIFE;
      t.mat.opacity = 0.9 * k * k;
    }
    step(puffs, dt, 0.35);
    step(sparks, dt, 0);
    if (flash.intensity > 0.01) flash.intensity *= Math.exp(-FLASH_DECAY * dt);
    else flash.intensity = 0;
  }

  return { tracer, muzzle, puff, spark, update, group, light: flash };
}
