// Costa Lume — canvas texture factory.
//
// Every surface texture in the game is painted here at run time on a 2D canvas; the entry ships no
// image files at all. Each factory takes the world's seeded PRNG so the grain, lit windows and paint
// wear are identical for a given seed. Textures are shared by every material that uses them.
import * as THREE from 'three';

const PALETTE = {
  asphalt: '#2c3034',
  asphaltLight: '#3c4045',
  paint: '#e8e2cf',
  sidewalk: '#b3aa9b',
  sidewalkJoint: '#8d8677',
  sand: '#e2cda2',
  trunk: '#7a6046',
};

function canvas2d(size, height = size) {
  const el = document.createElement('canvas');
  el.width = size;
  el.height = height;
  const ctx = el.getContext('2d');
  return { el, ctx, w: size, h: height };
}

function toTexture(el, { repeat = true, srgb = true, aniso = 4 } = {}) {
  const tex = new THREE.CanvasTexture(el);
  tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

// speckle: small translucent dots, the cheapest way to kill flat colour fields
function speckle(ctx, rng, w, h, count, colors, minR, maxR, alpha) {
  for (let i = 0; i < count; i += 1) {
    const x = rng() * w;
    const y = rng() * h;
    const r = minR + rng() * (maxR - minR);
    ctx.globalAlpha = alpha * (0.4 + rng() * 0.6);
    ctx.fillStyle = colors[(rng() * colors.length) | 0];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function asphaltTexture(rng) {
  const { el, ctx, w, h } = canvas2d(512);
  ctx.fillStyle = PALETTE.asphalt;
  ctx.fillRect(0, 0, w, h);
  speckle(ctx, rng, w, h, 5200, ['#4a4f54', '#22262a', '#585d62', '#1b1f22'], 0.6, 2.2, 0.5);
  // aggregate patches and long cracks
  for (let i = 0; i < 26; i += 1) {
    ctx.globalAlpha = 0.10 + rng() * 0.10;
    ctx.fillStyle = i % 2 ? '#3d4247' : '#23272b';
    ctx.beginPath();
    ctx.ellipse(rng() * w, rng() * h, 28 + rng() * 76, 14 + rng() * 44, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = '#1c2023';
  for (let i = 0; i < 9; i += 1) {
    let x = rng() * w;
    let y = rng() * h;
    ctx.lineWidth = 0.7 + rng() * 1.1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 7; s += 1) {
      x += (rng() - 0.5) * 60;
      y += (rng() - 0.5) * 60;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return toTexture(el, { aniso: 8 });
}

// worn white paint: one dash per tile, aligned with the road's length axis
export function laneTexture(rng) {
  const { el, ctx, w, h } = canvas2d(128, 512);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(232,226,207,0.82)';
  ctx.fillRect(w / 2 - 7, 34, 14, h - 68);
  // scuff the paint so it does not read as a vector rectangle
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i += 1) {
    ctx.globalAlpha = 0.25 + rng() * 0.55;
    const r = 1 + rng() * 5;
    ctx.beginPath();
    ctx.arc(w / 2 + (rng() - 0.5) * 20, rng() * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  const tex = toTexture(el, { srgb: true });
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function crosswalkTexture(rng) {
  const { el, ctx, w, h } = canvas2d(512, 128);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(238,232,214,0.80)';
  for (let x = 10; x < w; x += 46) ctx.fillRect(x, 0, 26, h);
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 220; i += 1) {
    ctx.globalAlpha = 0.3 + rng() * 0.5;
    ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 6, 1 + rng() * 5);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  return toTexture(el);
}

export function sidewalkTexture(rng) {
  const { el, ctx, w, h } = canvas2d(512);
  ctx.fillStyle = PALETTE.sidewalk;
  ctx.fillRect(0, 0, w, h);
  speckle(ctx, rng, w, h, 3400, ['#c8c0b1', '#9c9485', '#d4ccbc'], 0.5, 1.8, 0.5);
  // 128px slabs with dark joints
  ctx.strokeStyle = PALETTE.sidewalkJoint;
  ctx.globalAlpha = 0.65;
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i += 1) {
    const p = i * 128;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(w, p); ctx.stroke();
  }
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#6f6759';
  for (let i = 0; i < 22; i += 1) {
    ctx.beginPath();
    ctx.ellipse(rng() * w, rng() * h, 8 + rng() * 34, 6 + rng() * 20, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return toTexture(el, { aniso: 8 });
}

export function sandTexture(rng) {
  const { el, ctx, w, h } = canvas2d(512);
  ctx.fillStyle = PALETTE.sand;
  ctx.fillRect(0, 0, w, h);
  speckle(ctx, rng, w, h, 9000, ['#efdcb6', '#d3bb8b', '#c9ad7c', '#f6e8c8'], 0.4, 1.5, 0.6);
  // wind ripples
  ctx.globalAlpha = 0.10;
  ctx.strokeStyle = '#b99f72';
  for (let i = 0; i < 26; i += 1) {
    ctx.lineWidth = 2 + rng() * 4;
    ctx.beginPath();
    const y0 = rng() * h;
    for (let x = 0; x <= w; x += 16) {
      ctx.lineTo(x, y0 + Math.sin((x / w) * Math.PI * 2 + rng() * 0.4) * 9);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return toTexture(el, { aniso: 4 });
}

// water: tileable normal map built from summed sine waves, used with a low-roughness material
export function waterNormalTexture() {
  const size = 256;
  const { el, ctx } = canvas2d(size);
  const img = ctx.createImageData(size, size);
  const waves = [
    { ax: 2, az: 3, amp: 0.55, phase: 0.4 },
    { ax: 5, az: 2, amp: 0.32, phase: 1.7 },
    { ax: 3, az: 7, amp: 0.18, phase: 3.1 },
    { ax: 9, az: 5, amp: 0.10, phase: 0.9 },
  ];
  const height = (x, z) => {
    let h = 0;
    for (const wv of waves) {
      h += wv.amp * Math.sin((x / size) * Math.PI * 2 * wv.ax + (z / size) * Math.PI * 2 * wv.az + wv.phase);
    }
    return h;
  };
  const step = 1.4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = height(x + step, y) - height(x - step, y);
      const dz = height(x, y + step) - height(x, y - step);
      const nx = -dx;
      const nz = -dz;
      const ny = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      const i = (y * size + x) * 4;
      img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((nz / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(el, { srgb: false, aniso: 2 });
}

// one facade tile = 4 floors x 4 windows, so wall UVs are (width/12, height/12)
export function facadeTexture(rng, scheme) {
  const { el, ctx, w, h } = canvas2d(512);
  const cell = 128;
  // wall base with a soft vertical wash (sunlight from above, shadow at street level)
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, scheme.wallTop);
  grad.addColorStop(0.65, scheme.wall);
  grad.addColorStop(1, scheme.wallBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  speckle(ctx, rng, w, h, 2400, [scheme.grain, scheme.wall], 0.5, 1.6, 0.35);
  // grime streaks running down between the floors
  ctx.globalAlpha = 0.10;
  for (let i = 0; i < 16; i += 1) {
    ctx.fillStyle = scheme.shadow;
    const x = rng() * w;
    ctx.fillRect(x, rng() * h * 0.4, 2 + rng() * 10, 60 + rng() * 260);
  }
  ctx.globalAlpha = 1;

  for (let fy = 0; fy < 4; fy += 1) {
    for (let fx = 0; fx < 4; fx += 1) {
      const x = fx * cell;
      const y = fy * cell;
      // window recess
      const wx = x + 26;
      const wy = y + 26;
      const ww = cell - 52;
      const wh = cell - 58;
      ctx.fillStyle = scheme.shadow;
      ctx.fillRect(wx - 4, wy - 3, ww + 8, wh + 8);
      const lit = rng() < scheme.litChance;
      const glass = ctx.createLinearGradient(wx, wy, wx + ww, wy + wh);
      if (lit) {
        glass.addColorStop(0, '#f6d79b');
        glass.addColorStop(0.55, '#e9b76b');
        glass.addColorStop(1, '#c98d4e');
      } else {
        glass.addColorStop(0, scheme.glassTop);
        glass.addColorStop(1, scheme.glassBottom);
      }
      ctx.fillStyle = glass;
      ctx.fillRect(wx, wy, ww, wh);
      // sky reflection streak across the glass
      ctx.globalAlpha = lit ? 0.10 : 0.22;
      ctx.fillStyle = '#cfe4f0';
      ctx.beginPath();
      ctx.moveTo(wx, wy + wh * 0.62);
      ctx.lineTo(wx + ww, wy + wh * 0.18);
      ctx.lineTo(wx + ww, wy + wh * 0.42);
      ctx.lineTo(wx, wy + wh * 0.86);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      // mullion + sill
      ctx.fillStyle = scheme.trim;
      ctx.fillRect(wx + ww / 2 - 1.5, wy, 3, wh);
      ctx.fillRect(wx - 5, wy + wh, ww + 10, 5);
      // shutters on some windows of the pastel hotels
      if (scheme.shutters && rng() < 0.55) {
        ctx.fillStyle = scheme.shutter;
        ctx.fillRect(wx - 15, wy, 11, wh);
        ctx.fillRect(wx + ww + 4, wy, 11, wh);
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = '#000000';
        for (let s = wy + 6; s < wy + wh; s += 9) ctx.fillRect(wx - 15, s, 11, 2);
        for (let s = wy + 6; s < wy + wh; s += 9) ctx.fillRect(wx + ww + 4, s, 11, 2);
        ctx.globalAlpha = 1;
      }
    }
  }
  // floor band
  ctx.fillStyle = scheme.trim;
  ctx.globalAlpha = 0.20;
  for (let fy = 1; fy < 4; fy += 1) ctx.fillRect(0, fy * cell - 2, w, 4);
  ctx.globalAlpha = 1;
  return toTexture(el, { aniso: 4 });
}

export function towerTexture(rng) {
  const { el, ctx, w, h } = canvas2d(512);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#93aebb');
  grad.addColorStop(0.6, '#7e97a4');
  grad.addColorStop(1, '#6d838e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const cell = 128;
  for (let fy = 0; fy < 4; fy += 1) {
    for (let fx = 0; fx < 4; fx += 1) {
      const x = fx * cell + 8;
      const y = fy * cell + 10;
      const ww = cell - 16;
      const wh = cell - 22;
      const lit = rng() < 0.18;
      const g = ctx.createLinearGradient(x, y, x + ww, y + wh);
      if (lit) {
        g.addColorStop(0, '#ffe0a8');
        g.addColorStop(1, '#c9a066');
      } else {
        g.addColorStop(0, '#33505e');
        g.addColorStop(0.5, '#24404d');
        g.addColorStop(1, '#1b3038');
      }
      ctx.fillStyle = g;
      ctx.fillRect(x, y, ww, wh);
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = '#d8ecf5';
      ctx.beginPath();
      ctx.moveTo(x, y + wh);
      ctx.lineTo(x + ww * 0.7, y);
      ctx.lineTo(x + ww, y);
      ctx.lineTo(x, y + wh);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(28,42,50,0.55)';
      ctx.fillRect(x + ww / 2 - 1, y, 2, wh);
    }
  }
  for (let i = 0; i < 5; i += 1) {
    ctx.fillStyle = 'rgba(232,240,244,0.16)';
    ctx.fillRect(0, i * 128 - 1, w, 3);
  }
  return toTexture(el, { aniso: 4 });
}

export function roofTexture(rng) {
  const { el, ctx, w, h } = canvas2d(256);
  ctx.fillStyle = '#8d8a80';
  ctx.fillRect(0, 0, w, h);
  speckle(ctx, rng, w, h, 2600, ['#a09c90', '#6f6d64', '#b6b2a4'], 0.5, 1.8, 0.55);
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#4c4a44';
  for (let i = 0; i < 12; i += 1) {
    ctx.beginPath();
    ctx.ellipse(rng() * w, rng() * h, 10 + rng() * 34, 8 + rng() * 26, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return toTexture(el, { aniso: 2 });
}

export function palmFrondTexture(rng) {
  const { el, ctx, w, h } = canvas2d(256);
  ctx.clearRect(0, 0, w, h);
  // frond grows along +x from the left edge; leaflets fan out to both sides
  const midY = h / 2;
  const green = ['#4f7d3a', '#5c8f42', '#3f6a2f', '#6b9c4a'];
  for (let i = 0; i < 26; i += 1) {
    const t = i / 25;
    const x = 12 + t * (w - 30);
    const len = (1 - t) * 74 + 14;
    const lean = 16 * t;
    ctx.fillStyle = green[(rng() * green.length) | 0];
    ctx.globalAlpha = 0.88;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(x, midY);
      ctx.lineTo(x + 20 + lean, midY + dir * len);
      ctx.lineTo(x + 34 + lean, midY + dir * (len - 9));
      ctx.lineTo(x + 9, midY + dir * 3);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#7d6a3d';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(7, midY);
  ctx.lineTo(w - 6, midY);
  ctx.stroke();
  return toTexture(el, { repeat: false, aniso: 4 });
}

const SIGN_WORDS = [
  'HOTEL', 'CAFE', 'BAR', 'MERCADO', 'LUME', 'SOL', 'TACOS', 'RADIO',
  'FARMACIA', 'CINE', 'MUELLES', 'PLAYA', 'MOTEL', 'CANTINA', 'TIENDA', 'VELA',
];
const SIGN_COLORS = ['#ff6b8a', '#5fe3d0', '#ffd166', '#8fb8ff', '#ff9f45', '#c78bff'];

// 4x4 neon sign atlas: each cell is one sign plate with glowing tube lettering
export function neonAtlasTexture(rng) {
  const { el, ctx, w } = canvas2d(1024);
  const cell = 256;
  ctx.fillStyle = '#05090e';
  ctx.fillRect(0, 0, w, w);
  for (let i = 0; i < 16; i += 1) {
    const cx = (i % 4) * cell;
    const cy = ((i / 4) | 0) * cell;
    const color = SIGN_COLORS[(rng() * SIGN_COLORS.length) | 0];
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#070c12';
    ctx.fillRect(6, 6, cell - 12, cell - 12);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 4;
    ctx.strokeRect(16, 16, cell - 32, cell - 32);
    ctx.globalAlpha = 1;
    ctx.shadowColor = color;
    ctx.shadowBlur = 26;
    ctx.fillStyle = color;
    ctx.font = '700 44px "Liberation Sans", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const word = SIGN_WORDS[i];
    ctx.fillText(word.length > 8 ? word.slice(0, 8) : word, cell / 2, cell / 2 + 2, cell - 46);
    ctx.shadowBlur = 12;
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.font = '700 44px "Liberation Sans", Arial, sans-serif';
    ctx.fillText(word.length > 8 ? word.slice(0, 8) : word, cell / 2, cell / 2 + 2, cell - 46);
    ctx.restore();
  }
  return toTexture(el, { repeat: false });
}

// soft contact-shadow gradient, used as an alpha map under buildings and trees
export function aoTexture() {
  const { el, ctx, w } = canvas2d(128);
  const g = ctx.createRadialGradient(w / 2, w / 2, 6, w / 2, w / 2, w / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.85)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.45)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, w);
  return toTexture(el, { repeat: false, srgb: false });
}

export function boardwalkTexture(rng) {
  const { el, ctx, w, h } = canvas2d(512);
  ctx.fillStyle = '#8a6a4c';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 8; i += 1) {
    const y = i * 64;
    const shade = ['#96745a', '#7d6047', '#a07f60', '#86684d'][i % 4];
    ctx.fillStyle = shade;
    ctx.fillRect(0, y + 2, w, 60);
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = '#5b4331';
    ctx.lineWidth = 1;
    for (let k = 0; k < 5; k += 1) {
      ctx.beginPath();
      ctx.moveTo(0, y + 10 + k * 11 + rng() * 3);
      ctx.bezierCurveTo(w * 0.3, y + k * 11 + rng() * 8, w * 0.6, y + k * 11 + rng() * 8, w, y + 10 + k * 11);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(40,28,18,0.45)';
    ctx.fillRect(0, y, w, 3);
    ctx.fillRect((i * 137) % w, y, 3, 64);
  }
  return toTexture(el, { aniso: 4 });
}

export function createTextures(rng) {
  const schemes = [
    { // peach / terracotta
      wall: '#eebfa8', wallTop: '#f6d3bd', wallBottom: '#d9a48c', grain: '#c98a6e',
      trim: '#f7e6d6', shadow: '#b9795c', glassTop: '#3d5a66', glassBottom: '#243a45',
      shudders: false, shutters: true, shutter: '#7fa79b', litChance: 0.16,
    },
    { // mint
      wall: '#bcd8cb', wallTop: '#d3e8dd', wallBottom: '#9dbcb0', grain: '#7fa294',
      trim: '#f2f6ef', shadow: '#6f8e83', glassTop: '#35525c', glassBottom: '#1f333b',
      shutters: true, shutter: '#e8d6a8', litChance: 0.14,
    },
    { // butter
      wall: '#ecd9a8', wallTop: '#f7e9c4', wallBottom: '#d5bb83', grain: '#bfa069',
      trim: '#fbf2da', shadow: '#a68b58', glassTop: '#3a545c', glassBottom: '#22353c',
      shutters: true, shutter: '#7fa79b', litChance: 0.15,
    },
    { // bougainvillea pink
      wall: '#e6b9c4', wallTop: '#f4d2d8', wallBottom: '#cd9aa9', grain: '#b9808f',
      trim: '#fceef0', shadow: '#a3707e', glassTop: '#3a5058', glassBottom: '#213238',
      shutters: false, shutter: '#8fae9f', litChance: 0.17,
    },
  ];
  return {
    asphalt: asphaltTexture(rng),
    lane: laneTexture(rng),
    crosswalk: crosswalkTexture(rng),
    sidewalk: sidewalkTexture(rng),
    sand: sandTexture(rng),
    waterNormal: waterNormalTexture(),
    frond: palmFrondTexture(rng),
    neon: neonAtlasTexture(rng),
    roof: roofTexture(rng),
    ao: aoTexture(),
    boardwalk: boardwalkTexture(rng),
    facades: schemes.map((s) => facadeTexture(rng, s)),
    tower: towerTexture(rng),
    // flat colours for props, kept here so prop materials never drift from the palette
    colors: {
      trunk: PALETTE.trunk,
      paint: PALETTE.paint,
      asphalt: PALETTE.asphalt,
      lamp: '#2b2f33',
      bench: '#7c5f43',
      planter: '#a89b88',
      balcony: '#f4e6d4',
      tank: '#9aa3a8',
      ac: '#b9bcbd',
    },
  };
}
