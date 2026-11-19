// Costa Lume — the save file: one small JSON document in localStorage, validated field by field.
//
// A save is only trusted after validate() has checked every number is finite and inside the city's
// own bounds, every weapon is one the combat system knows and every mission index points at a
// mission that exists. A tampered or half-written document is dropped with a reason instead of
// resuming the player inside a building or at NaN, and load() never throws.

export const SAVE_KEY = 'costa-lume.save.v1';
export const SAVE_VERSION = 1;

const WEAPONS = ['fists', 'pistol', 'smg'];
const WORLD_LIMIT = 4200;          // metres: the city is ~700 across, so this is a sanity box
const MONEY_LIMIT = 100000000;

function num(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function storageOf(storage) {
  if (storage) return storage;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (err) {
    return null;                          // blocked storage (file://, private mode): no save
  }
  return null;
}

// Returns {ok:true, data} or {ok:false, reason}. Never throws on hostile input.
export function validate(raw, missionCount = 5) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
  if (raw.v !== SAVE_VERSION) return { ok: false, reason: `version ${raw.v}` };

  const maxMission = Math.max(0, missionCount - 1);
  const missionRaw = Number(raw.mission);
  if (!Number.isFinite(missionRaw) || missionRaw < 0 || missionRaw > maxMission) {
    return { ok: false, reason: 'mission index' };
  }
  const mission = Math.round(missionRaw);
  const stepRaw = Number(raw.step);
  if (!Number.isFinite(stepRaw) || stepRaw < 0 || stepRaw > 12) return { ok: false, reason: 'step index' };
  const step = Math.round(stepRaw);

  const p = raw.player;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'player block' };
  const x = num(p.x, -WORLD_LIMIT, WORLD_LIMIT, NaN);
  const z = num(p.z, -WORLD_LIMIT, WORLD_LIMIT, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return { ok: false, reason: 'player position' };
  if (Math.abs(z) > WORLD_LIMIT || Math.abs(x) > WORLD_LIMIT) return { ok: false, reason: 'position range' };

  const weapon = WEAPONS.includes(p.weapon) ? p.weapon : 'fists';
  const ammo = p.ammo && typeof p.ammo === 'object' ? {
    pistol: Math.round(num(p.ammo.pistol, 0, 400, 0)),
    smg: Math.round(num(p.ammo.smg, 0, 900, 0)),
  } : { pistol: 0, smg: 0 };

  const completed = Array.isArray(raw.completed)
    ? raw.completed.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 40).slice(0, 16)
    : [];

  return {
    ok: true,
    data: {
      v: SAVE_VERSION,
      at: typeof raw.at === 'string' ? raw.at.slice(0, 40) : '',
      mission,
      step,
      finished: raw.finished === true,
      money: Math.round(num(raw.money, 0, MONEY_LIMIT, 250)),
      completed,
      player: {
        x, z,
        health: num(p.health, 1, 100, 100),
        armour: num(p.armour, 0, 100, 0),
        weapon,
        ammo,
      },
      muted: raw.muted === true,
      playSeconds: num(raw.playSeconds, 0, 1e7, 0),
    },
  };
}

export function readSave(storage, missionCount = 5) {
  const store = storageOf(storage);
  if (!store) return { ok: false, reason: 'storage unavailable' };
  let text = null;
  try {
    text = store.getItem(SAVE_KEY);
  } catch (err) {
    return { ok: false, reason: 'storage read failed' };
  }
  if (!text) return { ok: false, reason: 'no save' };
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: 'corrupt json' };
  }
  return validate(parsed, missionCount);
}

export function writeSave(snapshot, storage) {
  const store = storageOf(storage);
  const check = validate(snapshot, 12);
  if (!check.ok) return { ok: false, reason: check.reason };
  if (!store) return { ok: false, reason: 'storage unavailable' };
  try {
    store.setItem(SAVE_KEY, JSON.stringify({ ...check.data, at: new Date().toISOString() }));
  } catch (err) {
    return { ok: false, reason: 'storage write failed' };
  }
  return { ok: true };
}

export function clearSave(storage) {
  const store = storageOf(storage);
  if (!store) return false;
  try {
    store.removeItem(SAVE_KEY);
    return true;
  } catch (err) {
    return false;
  }
}

export function hasSave(storage, missionCount = 5) {
  return readSave(storage, missionCount).ok;
}
