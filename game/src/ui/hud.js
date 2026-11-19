// Costa Lume — the DOM HUD: one cheap pass per frame over the ids index.html already owns.
//
// Everything a screenshot has to show at a glance lives here: mission text, cash, wanted stars,
// vitals, the weapon line, the speedometer, radio, the centre prompt, toasts and the minimap.
// The HUD builds no markup of its own — it binds the existing ids, diffs against the last value it
// wrote and touches the DOM only when something changed, so a 60 fps loop stays nearly free.
//
// Minimap: the city plate is painted into an offscreen canvas window centred on the player. That
// window is only repainted after the player has travelled more than MAP_REDRAW_M metres; in between,
// the blit is offset by the leftover distance so the player arrow stays pinned at the centre and the
// map still slides smoothly. Dots, the mission diamond and the arrow are drawn on top every frame,
// at most 20 times a second.

const MAP_VIEW_M = 250;      // metres across the 380 device-pixel plate
const MAP_REDRAW_M = 8;      // repaint the offscreen window after this much travel ("a few metres")
const MAP_FPS_MS = 50;       // 20 fps ceiling for the minimap
const TOAST_MAX = 4;
const TOAST_MS = 4600;
const TOAST_FADE_MS = 420;

const PALETTE = {
  water: '#0a1a26',
  land: '#14212a',
  sand: '#33291c',
  board: '#5a4a30',
  street: 'rgba(178,193,201,0.42)',
  boulevard: 'rgba(229,237,241,0.62)',
  gold: '#e8b96b',
  police: '#6fb2ff',
  traffic: 'rgba(238,244,247,0.92)',
  ink: 'rgba(9,16,26,0.9)',
};

const byId = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

// $12,450 — thousands separators, no cents, sign in front of the dollar mark.
function formatMoney(value) {
  const v = Math.round(Number(value) || 0);
  const digits = String(Math.abs(v));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    const left = digits.length - i;
    out += digits[i];
    if (left > 1 && (left - 1) % 3 === 0) out += ',';
  }
  return `${v < 0 ? '-$' : '$'}${out}`;
}

// ---------------------------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------------------------
function streetEnds(s) {
  // axis 'z': the street runs along z at x = centre, from/to are z values.
  // axis 'x': the street runs along x at z = centre, from/to are x values.
  if (s.axis === 'x') return { x1: s.from, z1: s.centre, x2: s.to, z2: s.centre };
  return { x1: s.centre, z1: s.from, x2: s.centre, z2: s.to };
}

function firstNum(...vals) {
  for (const v of vals) {
    const n = num(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function entityX(e) {
  if (!e) return NaN;
  if (Array.isArray(e)) return num(e[0]);
  return firstNum(e.x, e.pos && e.pos.x, e.position && e.position.x);
}

function entityZ(e) {
  if (!e) return NaN;
  if (Array.isArray(e)) return num(e[1]);
  return firstNum(e.z, e.pos && e.pos.z, e.position && e.position.z);
}

function createMinimap(el, city) {
  const ctx = el && typeof el.getContext === 'function' ? el.getContext('2d') : null;
  if (!ctx) return null;

  const W = el.width || 380;
  const H = el.height || 380;
  const scale = W / MAP_VIEW_M;
  const cx = W / 2;
  const cy = H / 2;

  const bg = document.createElement('canvas');
  bg.width = W;
  bg.height = H;
  const bctx = bg.getContext('2d');

  const graph = (city && city.roadGraph) || {};
  const streets = Array.isArray(graph.streets) ? graph.streets : [];
  const districts = Array.isArray(city && city.districts) ? city.districts : [];
  const mains = new Set(Array.isArray(graph.mainStreets) ? graph.mainStreets : ['S4', 'Z3']);

  // World extents, read off the street graph so the plate follows the city instead of a magic box.
  let wMinX = Infinity;
  let wMaxX = -Infinity;
  let wMinZ = Infinity;
  let wMaxZ = -Infinity;
  for (const s of streets) {
    const e = streetEnds(s);
    wMinX = Math.min(wMinX, e.x1, e.x2);
    wMaxX = Math.max(wMaxX, e.x1, e.x2);
    wMinZ = Math.min(wMinZ, e.z1, e.z2);
    wMaxZ = Math.max(wMaxZ, e.z1, e.z2);
  }
  if (!Number.isFinite(wMinX) && city && city.bounds) {
    wMinX = city.bounds.minX; wMaxX = city.bounds.maxX;
    wMinZ = city.bounds.minZ; wMaxZ = city.bounds.maxZ;
  }
  const hasLand = Number.isFinite(wMinX) && wMaxX > wMinX && wMaxZ > wMinZ;
  const coastZ = hasLand ? wMinZ : 0;     // south edge of the asphalt grid: beach below it

  let anchorX = NaN;
  let anchorZ = NaN;

  function paint(ax, az) {
    if (!bctx) return;
    const sx = (x) => cx + (x - ax) * scale;
    const sy = (z) => cy - (z - az) * scale;

    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, W, H);
    bctx.fillStyle = PALETTE.water;
    bctx.fillRect(0, 0, W, H);

    if (hasLand) {
      // land plate from the coast northwards; sand and boardwalk read as light strips along it
      bctx.fillStyle = PALETTE.land;
      bctx.fillRect(sx(wMinX - 12), sy(wMaxZ + 12), (wMaxX - wMinX + 24) * scale, (wMaxZ + 12 - coastZ) * scale);

      bctx.fillStyle = PALETTE.sand;
      bctx.fillRect(sx(wMinX - 40), sy(coastZ - 10), (wMaxX - wMinX + 80) * scale, 62 * scale);

      bctx.fillStyle = PALETTE.board;
      bctx.fillRect(sx(wMinX - 40), sy(coastZ), (wMaxX - wMinX + 80) * scale, 10 * scale);
    }

    // streets as schematic lines: ordinary roads, then the two boulevards on top and wider
    bctx.lineCap = 'round';
    for (const pass of [false, true]) {
      for (const s of streets) {
        if (mains.has(s.id) !== pass) continue;
        const e = streetEnds(s);
        bctx.strokeStyle = pass ? PALETTE.boulevard : PALETTE.street;
        bctx.lineWidth = pass ? 7 : 3.5;
        bctx.beginPath();
        bctx.moveTo(sx(e.x1), sy(e.z1));
        bctx.lineTo(sx(e.x2), sy(e.z2));
        bctx.stroke();
      }
    }
  }

  function playerPos(state) {
    const src = state.player || state;
    const x = entityX(src);
    const z = entityZ(src);
    return { x: Number.isFinite(x) ? x : 0, z: Number.isFinite(z) ? z : 0 };
  }

  function currentDistrict(state, px, pz) {
    const name = typeof state.district === 'string' ? state.district : '';
    if (name) {
      const hit = districts.find((d) => d && d.name === name);
      if (hit) return hit;
    }
    return districts.find((d) => d && px >= d.minX && px <= d.maxX && pz >= d.minZ && pz <= d.maxZ) || null;
  }

  function missionMarker(state) {
    const m = state.mission || {};
    const candidates = [m.marker, m.target, state.missionMarker, state.marker];
    for (const c of candidates) {
      if (!c) continue;
      const x = entityX(c);
      const z = entityZ(c);
      if (Number.isFinite(x) && Number.isFinite(z)) return { x, z };
    }
    return null;
  }

  function drawDots(list, colour, radius, toX, toY, px, pz, limit) {
    if (!Array.isArray(list) || !list.length) return;
    ctx.fillStyle = colour;
    let drawn = 0;
    for (const e of list) {
      if (drawn >= limit) break;
      const x = entityX(e);
      const z = entityZ(e);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      if (Math.hypot(x - px, z - pz) < 6) continue;   // the player arrow covers that spot
      const dx = toX(x);
      const dy = toY(z);
      if (dx < -radius || dy < -radius || dx > W + radius || dy > H + radius) continue;
      ctx.beginPath();
      ctx.arc(dx, dy, radius, 0, Math.PI * 2);
      ctx.fill();
      drawn += 1;
    }
  }

  function draw(state) {
    const p = playerPos(state);

    if (!Number.isFinite(anchorX) || Math.hypot(p.x - anchorX, p.z - anchorZ) > MAP_REDRAW_M) {
      anchorX = p.x;
      anchorZ = p.z;
      paint(anchorX, anchorZ);
    }

    // leftover travel inside the redraw threshold: slide the blit so the arrow keeps the centre
    const ox = -(p.x - anchorX) * scale;
    const oy = (p.z - anchorZ) * scale;
    const toX = (x) => cx + (x - p.x) * scale;
    const toY = (z) => cy - (z - p.z) * scale;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(bg, ox, oy);

    // district name, only for the one the player is standing in
    const d = currentDistrict(state, p.x, p.z);
    if (d) {
      const lx = toX((d.minX + d.maxX) / 2);
      const ly = toY((d.minZ + d.maxZ) / 2);
      if (lx > 16 && lx < W - 16 && ly > 16 && ly < H - 16) {
        ctx.font = '600 13px "Inter", "Helvetica Neue", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(6,12,20,0.72)';
        ctx.strokeText(String(d.name).toUpperCase(), lx, ly);
        ctx.fillStyle = 'rgba(232,185,107,0.94)';
        ctx.fillText(String(d.name).toUpperCase(), lx, ly);
      }
    }

    // gold diamond on the active mission marker
    const marker = missionMarker(state);
    if (marker) {
      const r = 6.5;
      ctx.save();
      ctx.translate(toX(marker.x), toY(marker.z));
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = PALETTE.gold;
      ctx.strokeStyle = PALETTE.ink;
      ctx.lineWidth = 2;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.strokeRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }

    // the map overlay's waypoint, small and teal, so the same flag exists on both plates
    const wp = state.waypoint;
    if (wp && Number.isFinite(entityX(wp)) && Number.isFinite(entityZ(wp))) {
      const wx = toX(entityX(wp));
      const wy = toY(entityZ(wp));
      ctx.beginPath();
      ctx.arc(wx, wy, 4.4, 0, Math.PI * 2);
      ctx.fillStyle = '#4fb8ad';
      ctx.fill();
      ctx.strokeStyle = PALETTE.ink;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    drawDots(state.police || state.cops || state.policeUnits, PALETTE.police, 3, toX, toY, p.x, p.z, 24);
    drawDots(state.traffic || state.cars || state.vehicles, PALETTE.traffic, 2.2, toX, toY, p.x, p.z, 48);

    // player: an arrow at the centre, turned to the heading. three.js yaw 0 looks down -z, and north
    // (+z) is up on the plate, so forward in screen space is (fx, -fz).
    const heading = num(state.heading !== undefined ? state.heading : state.yaw);
    const yaw = Number.isFinite(heading) ? heading : 0;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const angle = Math.atan2(-fz, fx);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(-7.5, 7);
    ctx.lineTo(-3.2, 0);
    ctx.lineTo(-7.5, -7);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 2.2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  return { draw };
}

// ---------------------------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------------------------
export function createHud({ city = null, canvas = null } = {}) {
  const hudEl = byId('hud');
  const els = {
    missionTitle: byId('mission-title'),
    missionObj: byId('mission-obj'),
    money: byId('money'),
    stars: byId('stars'),
    minimap: canvas || byId('minimap'),
    district: byId('district'),
    health: byId('health-fill'),
    armour: byId('armour-fill'),
    weapon: byId('weapon'),
    ammo: byId('ammo'),
    speed: byId('speed'),
    drive: byId('drive'),
    radio: byId('radio'),
    sound: byId('sound'),
    prompt: byId('prompt'),
    toasts: byId('toasts'),
  };

  const starEls = els.stars ? Array.from(els.stars.querySelectorAll('.star')).slice(0, 5) : [];

  // #speed carries its own <small>KM/H</small>; write the number into a leading text node so the
  // unit markup survives. A second <small> rides beside it for the car's brand while driving,
  // borrowing the unit's own styling instead of inventing a new HUD block. Both are looked up
  // rather than recreated, so building a HUD twice cannot orphan the nodes the first one holds.
  let speedText = null;
  let brandEl = null;
  if (els.speed && els.speed.querySelector('small')) {
    if (els.speed.firstChild && els.speed.firstChild.nodeType === 3) {
      speedText = els.speed.firstChild;
    } else {
      speedText = document.createTextNode('0');
      els.speed.insertBefore(speedText, els.speed.firstChild);
    }
    brandEl = els.speed.querySelector('small.car-brand');
    if (!brandEl) {
      brandEl = document.createElement('small');
      brandEl.className = 'car-brand';
      els.speed.appendChild(brandEl);
    }
    brandEl.style.display = brandEl.textContent ? '' : 'none';
  }

  const minimap = createMinimap(els.minimap, city);

  // ---- the ending plate: BUSTED / WASTED over a dimmed frame --------------------------------
  // Built on first use and kept, so a chase ending costs a text write and one class of opacity.
  let bannerEl = null;
  let bannerTitle = null;
  let bannerSub = null;

  function ensureBanner() {
    if (bannerEl || typeof document === 'undefined' || !document.body) return bannerEl;
    bannerEl = document.createElement('div');
    bannerEl.id = 'banner';
    bannerEl.style.cssText =
      'position:fixed;inset:0;z-index:15;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;background:rgba(6,10,16,0.74);opacity:0;' +
      'transition:opacity 300ms linear;pointer-events:none;';
    bannerTitle = document.createElement('div');
    bannerTitle.style.cssText =
      'font-size:60px;font-weight:800;letter-spacing:0.22em;color:#f4efe4;' +
      'text-shadow:0 10px 44px rgba(0,0,0,0.7)';
    bannerSub = document.createElement('div');
    bannerSub.style.cssText =
      'margin-top:12px;font-size:12px;letter-spacing:0.22em;text-transform:uppercase;color:#e8b96b';
    bannerEl.append(bannerTitle, bannerSub);
    document.body.appendChild(bannerEl);
    return bannerEl;
  }

  // systems/police.js calls this when a chase ends; clearBanner() takes it away after the respawn.
  function banner(title, subtitle = '') {
    const el = ensureBanner();
    if (!el) return;
    bannerTitle.textContent = title ? String(title) : '';
    bannerSub.textContent = subtitle ? String(subtitle) : '';
    el.style.opacity = '1';
  }

  function clearBanner() {
    if (bannerEl) bannerEl.style.opacity = '0';
  }

  let lastMissionTitle = null;
  let lastMissionObj = null;
  let lastMoney = null;
  let lastStars = -1;
  let lastWeapon = null;
  let lastAmmo = null;
  let lastSpeed = null;
  let lastFast = null;
  let lastInCar = null;
  let lastBrand = null;
  let lastRadio = null;
  let lastPrompt = null;
  let lastDistrict = null;
  let lastSound = null;
  let lastMapAt = -Infinity;

  const toasts = [];

  function makeBar(el) {
    if (!el) return () => {};
    let lastPct = -1;
    return (value, max) => {
      const ceiling = Number(max) > 0 ? Number(max) : 100;
      const pct = Math.round(clamp(((Number(value) || 0) / ceiling) * 100, 0, 100));
      if (pct === lastPct) return;
      lastPct = pct;
      el.style.width = `${pct}%`;
      el.classList.toggle('low', pct < 25);
    };
  }

  const setHealth = makeBar(els.health);
  const setArmour = makeBar(els.armour);

  function setMission(title, objective) {
    const t = title == null ? '' : String(title);
    const o = objective == null ? undefined : String(objective);
    if (els.missionTitle && t !== lastMissionTitle) {
      els.missionTitle.textContent = t;
      lastMissionTitle = t;
    }
    if (els.missionObj && o !== undefined && o !== lastMissionObj) {
      els.missionObj.textContent = o;
      lastMissionObj = o;
    }
  }

  function setDistrict(name) {
    if (!els.district) return;
    const label = name == null ? '' : String(name).trim();
    if (!label || label === lastDistrict) return;
    lastDistrict = label;
    els.district.textContent = label;
    // a short fade: Web Animations does its own cleanup, no timers left behind
    if (typeof els.district.animate === 'function') {
      els.district.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
    }
  }

  function setPrompt(text) {
    if (!els.prompt) return;
    const t = text == null ? '' : String(text);
    if (!t) {
      if (lastPrompt !== '') {
        els.prompt.classList.remove('show');
        els.prompt.textContent = '';
        lastPrompt = '';
      }
      return;
    }
    if (t !== lastPrompt) {
      lastPrompt = t;
      els.prompt.textContent = '';
      const cut = t.indexOf(' — ') > 0 ? t.indexOf(' — ') : t.indexOf(' - ');
      if (cut > 0) {
        const key = document.createElement('b');
        key.textContent = t.slice(0, cut);
        els.prompt.append(key, document.createTextNode(t.slice(cut)));
      } else {
        els.prompt.textContent = t;
      }
    }
    els.prompt.classList.add('show');
  }

  function dropToast(rec) {
    if (!rec) return;
    if (rec.timer) clearTimeout(rec.timer);
    if (rec.fade) clearTimeout(rec.fade);
    rec.timer = 0;
    rec.fade = 0;
    if (rec.el && rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    const i = toasts.indexOf(rec);
    if (i >= 0) toasts.splice(i, 1);
  }

  function toast(text) {
    if (!els.toasts) return;
    const body = text == null ? '' : String(text).trim();
    if (!body) return;

    const el = document.createElement('div');
    el.className = 'toast';
    // "Mira: you're late" -> <b>Mira</b>: you're late, built with text nodes, never innerHTML
    const m = /^([^:]{1,32}):\s+([\s\S]+)$/.exec(body);
    if (m) {
      const who = document.createElement('b');
      who.textContent = m[1];
      el.append(who, document.createTextNode(`: ${m[2]}`));
    } else {
      el.textContent = body;
    }

    els.toasts.appendChild(el);
    const rec = { el, timer: 0, fade: 0 };
    toasts.push(rec);
    while (toasts.length > TOAST_MAX) dropToast(toasts[0]);

    rec.timer = setTimeout(() => {
      rec.timer = 0;
      el.style.transition = `opacity ${TOAST_FADE_MS}ms linear`;
      el.style.opacity = '0';
      rec.fade = setTimeout(() => dropToast(rec), TOAST_FADE_MS + 40);
    }, TOAST_MS);
  }

  function writeSpeed(kmh) {
    if (!els.speed) return;
    const v = String(kmh);
    if (v === lastSpeed) return;
    lastSpeed = v;
    if (speedText) speedText.nodeValue = v;
    else els.speed.textContent = v;
  }

  // km/h from the car's own chassis speed (m/s, signed by travel direction), so a walk cycle can
  // never leak into the dial. A car that is not there falls back to the pre-computed number.
  function speedKmh(car, state) {
    const st = car && car.state ? car.state : null;
    const ms = st ? Math.abs(Number(st.speed)) : NaN;
    if (Number.isFinite(ms)) return Math.max(0, Math.round(ms * 3.6));
    return Math.max(0, Math.round(Number(state.speedKmh) || 0));
  }

  function weaponLabel(raw) {
    if (raw && typeof raw === 'object') raw = raw.name || raw.id || raw.type;
    const key = raw == null ? 'fists' : String(raw).toLowerCase();
    if (key === 'fists' || key === 'unarmed' || key === '') return 'Fists';
    if (key === 'pistol') return 'Pistol';
    if (key === 'smg') return 'SMG';
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  function ammoLabel(state) {
    const raw = state.ammo !== undefined ? state.ammo : state.weaponAmmo;
    if (raw == null) return '—';
    if (typeof raw === 'number') return String(Math.max(0, Math.round(raw)));
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'object') {
      const mag = Number(raw.mag !== undefined ? raw.mag : raw.clip);
      const rest = Number(raw.reserve !== undefined ? raw.reserve : raw.stock);
      if (Number.isFinite(mag) && Number.isFinite(rest)) return `${mag}/${rest}`;
      if (Number.isFinite(mag)) return String(mag);
    }
    return '—';
  }

  function update(state, dt) {
    if (!state) return;

    const mission = state.mission;
    if (mission) setMission(mission.title, mission.objective);

    if (els.money) {
      const cash = formatMoney(state.money);
      if (cash !== lastMoney) {
        els.money.textContent = cash;
        lastMoney = cash;
      }
    }

    const stars = Math.round(clamp(Number(state.stars) || 0, 0, 5));
    if (starEls.length && stars !== lastStars) {
      lastStars = stars;
      for (let i = 0; i < starEls.length; i += 1) starEls[i].classList.toggle('on', i < stars);
    }

    setHealth(state.health, state.maxHealth === undefined ? 100 : state.maxHealth);
    setArmour(state.armour, state.maxArmour === undefined ? 100 : state.maxArmour);

    const weapon = weaponLabel(state.weapon);
    if (els.weapon && weapon !== lastWeapon) {
      els.weapon.textContent = weapon;
      lastWeapon = weapon;
    }
    const ammo = weapon === 'Fists' ? '—' : ammoLabel(state);
    if (els.ammo && ammo !== lastAmmo) {
      els.ammo.textContent = ammo;
      lastAmmo = ammo;
    }

    const inCar = !!state.inCar;
    // The speedometer reads the chassis, never the player's walk speed: the car the player is
    // holding is the authority, state.speedKmh is only the fallback for a caller that omits it.
    const car = (state.player && state.player.car) || (state.car && state.car.state ? state.car : null) || null;
    const kmh = inCar ? speedKmh(car, state) : 0;
    writeSpeed(kmh);
    if (els.speed) {
      const fast = inCar && kmh > 90;
      if (fast !== lastFast) {
        lastFast = fast;
        els.speed.classList.toggle('fast', fast);
      }
    }
    if (els.drive && inCar !== lastInCar) {
      lastInCar = inCar;
      els.drive.style.display = inCar ? '' : 'none';
    }
    if (brandEl) {
      const raw = inCar ? (car && car.brand) || state.carBrand || '' : '';
      const brand = raw == null ? '' : String(raw).trim();
      if (brand !== lastBrand) {
        lastBrand = brand;
        brandEl.textContent = brand ? `· ${brand.toUpperCase()}` : '';
        brandEl.style.display = brand ? '' : 'none';
      }
    }

    if (els.radio) {
      const station = state.radio == null ? '' : String(state.radio);
      if (station !== lastRadio) {
        els.radio.textContent = station;
        lastRadio = station;
      }
    }

    if (els.sound && state.sound !== undefined) {
      const label = String(state.sound);
      if (label !== lastSound) {
        els.sound.textContent = label;
        lastSound = label;
      }
    }

    if (state.district) setDistrict(state.district);

    // The interaction prompt is driven from the state the wiring provides ("F — steal Viento" on
    // foot, empty while driving); a scene can still call setPrompt() directly for a one-off line.
    if (state.prompt !== undefined) setPrompt(state.prompt);

    if (minimap) {
      const t = nowMs();
      if (t - lastMapAt >= MAP_FPS_MS || t < lastMapAt) {
        lastMapAt = t;
        minimap.draw(state);
      }
    }
    // dt rides along for callers that want to pace effects; nothing here is time-dependent
    void dt;
  }

  function show() {
    if (hudEl) hudEl.classList.remove('hidden');
  }

  function hide() {
    if (hudEl) hudEl.classList.add('hidden');
    setPrompt('');
  }

  return { update, toast, setMission, setDistrict, setPrompt, show, hide, banner, clearBanner };
}
