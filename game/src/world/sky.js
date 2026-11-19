// Costa Lume — sky, sun, ocean and the golden-hour lighting rig.
//
// A gradient dome (shader, no texture file), a low warm sun with a glow sprite, a large ocean plane
// with an animated normal map, exp2 fog whose colour is the dome's horizon colour, and four lights:
// one shadow-casting directional sun, a hemisphere fill and a small ambient. The shadow frustum is
// tight (110 m) and follows the player so 2048 px buys crisp contact shadows near the camera.
import * as THREE from 'three';

export const HORIZON = 0xcfe0ef;
// Golden hour, low over the north-east: the boulevard shot looks north with the sun ahead-left, so
// the west-side facades rake warm light and every shadow runs back toward the camera. The sun sits
// ~28 degrees up, enough to clear the far roofline and lay a lit band across the far half of the road
// while the near canyon stays in luminous shade.
export const SUN_DIR = new THREE.Vector3(0.42, 0.48, 0.80).normalize();
const ZENITH = new THREE.Color('#4a7fb5');
const HORIZON_WARM = new THREE.Color('#ffe0b0');
const HORIZON_COOL = new THREE.Color(HORIZON);

function glowSpriteTexture() {
  const size = 256;
  const el = document.createElement('canvas');
  el.width = size;
  el.height = size;
  const ctx = el.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,252,238,1)');
  g.addColorStop(0.06, 'rgba(255,246,214,1)');
  g.addColorStop(0.16, 'rgba(255,223,161,0.85)');
  g.addColorStop(0.36, 'rgba(255,183,110,0.32)');
  g.addColorStop(0.66, 'rgba(255,150,90,0.10)');
  g.addColorStop(1.0, 'rgba(255,140,80,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(el);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildDome() {
  const geo = new THREE.SphereGeometry(1200, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: ZENITH.clone() },
      uHorizonCool: { value: HORIZON_COOL.clone() },
      uHorizonWarm: { value: HORIZON_WARM.clone() },
      uSunDir: { value: SUN_DIR.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith;
      uniform vec3 uHorizonCool;
      uniform vec3 uHorizonWarm;
      uniform vec3 uSunDir;
      varying vec3 vDir;
      void main() {
        vec3 dir = normalize(vDir);
        float h = clamp(dir.y, 0.0, 1.0);
        // sun-bleached coastal haze: the warm horizon runs most of the way round, deepening to a clear zenith
        vec3 horizon = mix(uHorizonCool, uHorizonWarm, 0.46);
        vec3 col = mix(horizon, uZenith, pow(h, 0.52));
        // warm scatter around the sun, strongest along the horizon band
        float sunAmt = max(dot(dir, normalize(uSunDir)), 0.0);
        col += uHorizonWarm * pow(sunAmt, 4.0) * 0.70;
        col += vec3(1.0, 0.82, 0.58) * pow(sunAmt, 48.0) * 0.65;
        // a blown-out warm shelf just above the horizon — the frame's brightest band.
        // smoothstep's edges must climb (edge0 < edge1); the inverted pair this shader shipped with is
        // undefined in GLSL and rendered the whole dome as a dark slab on some drivers.
        float band = (1.0 - smoothstep(0.0, 0.20, h)) * smoothstep(-0.06, 0.03, dir.y);
        col = mix(col, uHorizonWarm * 1.12, band * 0.62);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

function buildOcean(waterNormal) {
  const geo = new THREE.PlaneGeometry(4200, 2600, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const normal = waterNormal.clone();
  normal.needsUpdate = true;
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.repeat.set(70, 44);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2e6d86,
    roughness: 0.20,
    metalness: 0.45,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.45, 0.45),
    envMapIntensity: 0.8,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, -0.45, -1380);
  mesh.receiveShadow = false;
  mesh.name = 'ocean';
  return { mesh, normal };
}

export function createSky(scene, waterNormal) {
  scene.fog = new THREE.FogExp2(HORIZON, 0.00125);
  scene.background = new THREE.Color(HORIZON);

  const dome = buildDome();
  scene.add(dome);

  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowSpriteTexture(),
    color: 0xffffff,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
    transparent: true,
  }));
  sunSprite.scale.setScalar(220);
  sunSprite.position.copy(SUN_DIR).multiplyScalar(900);
  sunSprite.renderOrder = -9;
  scene.add(sunSprite);

  const { mesh: ocean, normal } = buildOcean(waterNormal);
  scene.add(ocean);

  // ---- lighting rig ----
  // Bright golden hour: a strong warm sun, a generous sky/ground fill so shadowed walls keep their
  // colour instead of crushing to black, and a warm ambient to take the edge off the shadow side.
  const sun = new THREE.DirectionalLight(0xffd7a6, 3.35);
  sun.position.copy(SUN_DIR).multiplyScalar(120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 320;
  const span = 58;
  sun.shadow.camera.left = -span;
  sun.shadow.camera.right = span;
  sun.shadow.camera.top = span;
  sun.shadow.camera.bottom = -span;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.045;
  sun.shadow.radius = 2.5;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0xd7e9fb, 0x8a7053, 1.05);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0xffe8cb, 0.30);
  scene.add(ambient);

  let time = 0;
  const lightOffset = SUN_DIR.clone().multiplyScalar(120);

  return {
    sun,
    hemi,
    ambient,
    ocean,
    dome,
    sunSprite,
    // keeps sun, shadow frustum and dome centred on the player, and drifts the water shimmer
    update(playerPos, dt) {
      time += dt;
      sun.position.set(playerPos.x + lightOffset.x, playerPos.y + lightOffset.y, playerPos.z + lightOffset.z);
      sun.target.position.set(playerPos.x, 0, playerPos.z);
      sun.target.updateMatrixWorld();
      dome.position.set(playerPos.x, 0, playerPos.z);
      sunSprite.position.set(
        playerPos.x + SUN_DIR.x * 900,
        SUN_DIR.y * 900,
        playerPos.z + SUN_DIR.z * 900,
      );
      normal.offset.set(time * 0.006, time * 0.011);
    },
  };
}
