// Costa Lume — the full map overlay (Tab): the whole city, its districts, the player and the job.
//
// The minimap in hud.js is a 250 m window; this is the same city drawn once to fit the screen, so
// the player can see where Playa Norte ends and Colinas Altas begins and can put a waypoint down
// with a click. A waypoint is the only thing this file owns: it hands it back to main.js through
// onWaypoint, and main.js keeps it in the HUD state so the minimap shows the same flag.
//
// Drawing happens on show() and after a click, never per frame: the game is paused while the map is
// up, so nothing it draws can move.

const COL = {
  water: '#08131d',
  land: '#16232b',
  sand: '#3a2e20',
  board: '#5a4a30',
  street: 'rgba(178,193,201,0.40)',
  boulevard: 'rgba(236,244,247,0.68)',
  gold: '#e8b96b',
  teal: '#4fb8ad',
  police: '#6fb2ff',
  ink: 'rgba(6,12,20,0.92)',
};

const byId = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

function streetEnds(s) {
  if (s.axis === 'x') return { x1: s.from, z1: s.centre, x2: s.to, z2: s.centre };
  return { x1: s.centre, z1: s.from, x2: s.centre, z2: s.to };
}

export function createMapOverlay({ city, missions = null, onWaypoint = null } = {}) {
  const root = byId('mapoverlay');
  const canvas = byId('map-canvas');
  const listEl = byId('map-list');
  const metaEl = byId('map-meta');
  const hintEl = byId('map-waypoint');
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  if (!root || !ctx) return { open: false, show() {}, hide() {}, toggle() {}, setWaypoint() {}, draw() {} };

  const W = canvas.width;
  const H = canvas.height;
  const PAD = 26;

  const graph = (city && city.roadGraph) || {};
  const streets = Array.isArray(graph.streets) ? graph.streets : [];
  const districts = Array.isArray(city && city.districts) ? city.districts : [];
  const mains = new Set(Array.isArray(graph.mainStreets) ? graph.mainStreets : ['S4', 'Z3']);

  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const s of streets) {
    const e = streetEnds(s);
    minX = Math.min(minX, e.x1, e.x2); maxX = Math.max(maxX, e.x1, e.x2);
    minZ = Math.min(minZ, e.z1, e.z2); maxZ = Math.max(maxZ, e.z1, e.z2);
  }
  if (!Number.isFinite(minX) && city && city.bounds) {
    minX = city.bounds.minX; maxX = city.bounds.maxX;
    minZ = city.bounds.minZ; maxZ = city.bounds.maxZ;
  }
  // include the beach and the pier, which sit south of the street grid
  const pad = 40;
  minX -= pad; maxX += pad; minZ -= pad + 60; maxZ += pad;

  const spanX = Math.max(1, maxX - minX);
  const spanZ = Math.max(1, maxZ - minZ);
  const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanZ);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanZ * scale) / 2;
  const sx = (x) => offX + (x - minX) * scale;
  const sy = (z) => H - offY - (z - minZ) * scale;

  let waypoint = null;
  let open = false;

  function toWorld(px, py) {
    return {
      x: minX + (px - offX) / scale,
      z: minZ + (H - offY - py) / scale,
    };
  }

  function drawPlate() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COL.water;
    ctx.fillRect(0, 0, W, H);

    // the land plate, then the sand and the boardwalk strip along its south edge
    ctx.fillStyle = COL.land;
    ctx.fillRect(sx(minX), sy(maxZ), spanX * scale, spanZ * scale);
    ctx.fillStyle = COL.sand;
    ctx.fillRect(sx(minX), sy(minZ + 74), spanX * scale, 74 * scale);
    ctx.fillStyle = COL.board;
    ctx.fillRect(sx(minX), sy(minZ + 62), spanX * scale, 9 * scale);

    // district plates and their names
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const d of districts) {
      const x0 = sx(d.minX);
      const x1 = sx(d.maxX);
      const y0 = sy(d.maxZ);
      const y1 = sy(d.minZ);
      ctx.fillStyle = 'rgba(232,185,107,0.05)';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = 'rgba(232,185,107,0.22)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      ctx.font = '700 13px "Inter", "Helvetica Neue", Arial, sans-serif';
      ctx.fillStyle = 'rgba(232,185,107,0.36)';
      ctx.fillText(String(d.name).toUpperCase(), cx, cy);
    }

    // streets: the two boulevards last and wider, so the grid reads as a city and not a mesh
    ctx.lineCap = 'butt';
    for (const pass of [false, true]) {
      for (const s of streets) {
        if (mains.has(s.id) !== pass) continue;
        const e = streetEnds(s);
        ctx.strokeStyle = pass ? COL.boulevard : COL.street;
        ctx.lineWidth = pass ? 5 : 2.2;
        ctx.beginPath();
        ctx.moveTo(sx(e.x1), sy(e.z1));
        ctx.lineTo(sx(e.x2), sy(e.z2));
        ctx.stroke();
      }
    }
  }

  function drawEntities(state) {
    const px = state.player ? state.player.x : 0;
    const pz = state.player ? state.player.z : 0;

    // police
    ctx.fillStyle = COL.police;
    for (const d of state.police || []) {
      if (!Number.isFinite(d.x) || !Number.isFinite(d.z)) continue;
      ctx.beginPath();
      ctx.arc(sx(d.x), sy(d.z), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // the live job's route: numbered pins, the current one gold and larger
    const route = missions ? missions.route() : [];
    route.forEach((p, i) => {
      const x = sx(p.x);
      const y = sy(p.z);
      const r = p.current ? 8 : 5.5;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fillStyle = p.current ? COL.gold : 'rgba(232,185,107,0.45)';
      ctx.fill();
      ctx.strokeStyle = COL.ink;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      if (p.current) {
        ctx.font = '700 11px "Inter", Arial, sans-serif';
        ctx.fillStyle = '#0b1219';
        ctx.fillText(String(i + 1), x, y + 0.5);
      }
    });

    if (waypoint) {
      const x = sx(waypoint.x);
      const y = sy(waypoint.z);
      ctx.strokeStyle = COL.teal;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - 16);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y - 16);
      ctx.lineTo(x + 13, y - 11.5);
      ctx.lineTo(x, y - 7);
      ctx.closePath();
      ctx.fillStyle = COL.teal;
      ctx.fill();
    }

    // the player: an arrow turned to the heading (yaw 0 looks down -z, north is up)
    const yaw = Number.isFinite(state.heading) ? state.heading : 0;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const angle = Math.atan2(-fz, fx);
    ctx.save();
    ctx.translate(sx(px), sy(pz));
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-9, 8.5);
    ctx.lineTo(-4.5, 0);
    ctx.lineTo(-9, -8.5);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = COL.ink;
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.restore();

    // north mark in the corner of the plate
    ctx.font = '700 12px "Inter", Arial, sans-serif';
    ctx.fillStyle = 'rgba(244,239,228,0.75)';
    ctx.fillText('N', W - 18, 18);
    ctx.beginPath();
    ctx.moveTo(W - 18, 26);
    ctx.lineTo(W - 18, 40);
    ctx.strokeStyle = 'rgba(244,239,228,0.5)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function renderList(state) {
    if (!listEl || !missions) return;
    const all = missions.missionList || [];
    const done = new Set(state.completed || []);
    listEl.textContent = '';
    for (const m of all) {
      const row = document.createElement('div');
      row.className = 'map-job';
      if (done.has(m.id)) row.classList.add('done');
      if (state.mission && state.mission.id === m.id) row.classList.add('live');
      const mark = document.createElement('span');
      mark.className = 'map-job-mark';
      mark.textContent = done.has(m.id) ? '✓' : state.mission && state.mission.id === m.id ? '▶' : '·';
      const name = document.createElement('span');
      name.className = 'map-job-name';
      name.textContent = m.title;
      const cash = document.createElement('span');
      cash.className = 'map-job-cash';
      cash.textContent = `$${m.reward}`;
      row.append(mark, name, cash);
      listEl.appendChild(row);
    }
  }

  function renderMeta(state) {
    if (metaEl) {
      const done = (state.completed || []).length;
      const cash = Number.isFinite(state.money) ? Math.round(state.money) : 0;
      metaEl.textContent = `$${cash.toLocaleString('en-US')}  ·  ${done}/${(state.total || 5)} jobs  ·  ${state.district || ''}`;
    }
    if (hintEl) {
      if (waypoint) {
        const px = state.player ? state.player.x : 0;
        const pz = state.player ? state.player.z : 0;
        const d = Math.round(Math.hypot(waypoint.x - px, waypoint.z - pz));
        hintEl.textContent = `Waypoint set — ${d} m away. Click again to move it.`;
      } else {
        hintEl.textContent = 'Click the map to drop a waypoint. Tab or Esc returns to the street.';
      }
    }
  }

  function draw(state = {}) {
    drawPlate();
    drawEntities(state);
    renderList(state);
    renderMeta(state);
  }

  function setWaypoint(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    waypoint = { x: Math.round(x), z: Math.round(z) };
    if (onWaypoint) onWaypoint(waypoint);
    return waypoint;
  }

  if (canvas.addEventListener) {
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      const py = ((e.clientY - rect.top) / rect.height) * H;
      const p = toWorld(px, py);
      setWaypoint(p.x, p.z);
      if (root.__state) draw(root.__state);
    });
  }

  function show(state) {
    open = true;
    root.__state = state || root.__state || {};
    root.classList.remove('hidden');
    draw(root.__state);
  }

  function hide() {
    open = false;
    root.classList.add('hidden');
  }

  return {
    get open() { return open; },
    get waypoint() { return waypoint; },
    show,
    hide,
    draw(state) { root.__state = state || {}; if (open) draw(root.__state); },
    setWaypoint,
    clearWaypoint() { waypoint = null; if (onWaypoint) onWaypoint(null); },
  };
}
