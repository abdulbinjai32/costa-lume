// Static geometry merging. Props (palms, lamps, benches, water tanks, balconies...) are built as
// little transformed boxes/tubes and merged per material so a street of 300 props costs one draw
// call. Everything here emits non-indexed position/normal/uv triangles, which is what merge needs.
import * as THREE from 'three';

const FORWARD = new THREE.Vector3(0, 0, 1);
const ONE = new THREE.Vector3(1, 1, 1);
// every emitter writes an unindexed triangle list, so an authored quad becomes two triangles.
// Handedness differs by emitter: boxes, walls and signs list their corners clockwise seen from the
// front face, cylinder rings counter-clockwise. Fanning in the authored direction halves the work.
export const QUAD_TRIS = [0, 2, 1, 0, 3, 2];       // clockwise-authored quads (boxes, walls, signs)
export const QUAD_TRIS_CCW = [0, 1, 2, 0, 2, 3];   // counter-clockwise-authored quads (cylinders)

export function makeBuilder() {
  return { pos: [], nor: [], uv: [] };
}

// axis-aligned box: centre + full size, optional yaw (radians) about the vertical axis
export function pushBox(b, cx, cy, cz, sx, sy, sz, yaw = 0) {
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const verts = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const P = verts.map(([x, y, z]) => [cx + x * c + z * s, cy + y, cz - x * s + z * c]);
  const faces = [
    [[0, 1, 2, 3], [0, 0, -1]],
    [[5, 4, 7, 6], [0, 0, 1]],
    [[1, 5, 6, 2], [1, 0, 0]],
    [[4, 0, 3, 7], [-1, 0, 0]],
    [[3, 2, 6, 7], [0, 1, 0]],
    [[4, 5, 1, 0], [0, -1, 0]],
  ];
  for (const [quad, n] of faces) {
    const nx = n[0] * c + n[2] * s;
    const nz = -n[0] * s + n[2] * c;
    // the buffer is a plain triangle list: a quad has to be written as two triangles (6 vertices),
    // fanned from its authored corner order so the winding stays the one the face table intends
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const k of QUAD_TRIS) {
      const P0 = P[quad[k]];
      b.pos.push(P0[0], P0[1], P0[2]);
      b.nor.push(nx, n[1], nz);
      b.uv.push(uv[k][0], uv[k][1]);
    }
  }
}

// tapered cylinder (trunk, lamp post, water tank) from base point p0 to top point p1
export function pushCylinder(b, p0, p1, r0, r1, segments = 7) {
  const dir = new THREE.Vector3().subVectors(p1, p0);
  const len = dir.length() || 0.001;
  dir.divideScalar(len);
  // ring basis: two axes square to dir, so the section stays circular instead of spiralling down
  // the axis (rotating a fixed xz offset by dir's quaternion shears it along the axis)
  const seed = Math.abs(dir.x) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const right = new THREE.Vector3().crossVectors(dir, seed).normalize();
  const fwd = new THREE.Vector3().crossVectors(dir, right).normalize();
  const ring = (r, t) => {
    const out = [];
    for (let i = 0; i < segments; i += 1) {
      const a = (i / segments) * Math.PI * 2;
      const v = new THREE.Vector3()
        .addScaledVector(right, Math.cos(a))
        .addScaledVector(fwd, Math.sin(a));
      const n = v.clone();
      out.push({
        p: [p0.x + dir.x * len * t + v.x * r, p0.y + dir.y * len * t + v.y * r, p0.z + dir.z * len * t + v.z * r],
        n: [n.x, n.y, n.z],
      });
    }
    return out;
  };
  const top = ring(r1, 1);
  const bot = ring(r0, 0);
  for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % segments;
    const quad = [bot[i], bot[j], top[j], top[i]];
    const u0 = i / segments;
    const u1 = (i + 1) / segments;
    const uvs = [[u0, 0], [u1, 0], [u1, 1], [u0, 1]];
    for (const k of QUAD_TRIS_CCW) {
      const v = quad[k];
      b.pos.push(v.p[0], v.p[1], v.p[2]);
      b.nor.push(v.n[0], v.n[1], v.n[2]);
      b.uv.push(uvs[k][0], uvs[k][1]);
    }
  }
}

// thin quad centred at c, spanning w horizontally along `right`, h along `up`
export function pushQuad(b, c, right, up, w, h, normal) {
  const hw = w / 2;
  const hh = h / 2;
  const corners = [
    [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh],
  ];
  const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const k of QUAD_TRIS) {
    const [ru, uu] = corners[k];
    b.pos.push(c.x + right.x * ru + up.x * uu, c.y + right.y * ru + up.y * uu, c.z + right.z * ru + up.z * uu);
    b.nor.push(normal.x, normal.y, normal.z);
    b.uv.push(uvs[k][0], uvs[k][1]);
  }
}

export function pushGeometry(b, geometry, matrix) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  g.applyMatrix4(matrix);
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i += 1) {
    b.pos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    b.nor.push(nor.getX(i), nor.getY(i), nor.getZ(i));
    b.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
  }
  g.dispose();
}

export function pushMesh(b, geometry, position, rotation = new THREE.Euler(), scale = ONE) {
  const m = new THREE.Matrix4().compose(
    position,
    new THREE.Quaternion().setFromEuler(rotation),
    scale,
  );
  pushGeometry(b, geometry, m);
}

export function finish(b, { castShadow = true, receiveShadow = true } = {}) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  geo.computeBoundingSphere();
  return geo;
}

export function buildMesh(b, material, opts) {
  const mesh = new THREE.Mesh(finish(b, opts), material);
  mesh.castShadow = opts?.castShadow ?? true;
  mesh.receiveShadow = opts?.receiveShadow ?? true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
