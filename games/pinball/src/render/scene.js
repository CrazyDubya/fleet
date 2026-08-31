// three.js only lives here (and in sibling render/ modules). Not imported by physics/,
// table/ or rules/.
import * as THREE from 'three';

export function createScene(canvas) {
  const scene = new THREE.Scene();
  // Backdrop: the vendored backglass photo (dim gym at night, chrome ball streaking
  // through) reused as the backboard/sky behind the tilted table, per the reference art
  // redirect. Falls back to a dark navy if the texture hasn't loaded yet.
  scene.background = new THREE.Color(0x0c1220);
  new THREE.TextureLoader().load('./assets/textures/backglass.jpg', (tex) => {
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    scene.background = tex;
  });

  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 10);
  camera.position.set(0, 0.85, 0.55);
  camera.lookAt(0, 0, -0.4);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  // Warm, slightly-dim rec-room lighting (a single low tube light over a worn machine),
  // not flat daylight — per the reference photo's mood.
  const hemi = new THREE.HemisphereLight(0xffe3b3, 0x2a2015, 0.55);
  const dir = new THREE.DirectionalLight(0xffcf8f, 0.9);
  dir.position.set(0.3, 1, 0.5);
  const ambient = new THREE.AmbientLight(0x332211, 0.35);
  scene.add(hemi, dir, ambient);

  // Playfield-space coordinates map into the tilt group as:
  //   local x = table x, local y = 0 (playfield plane) / ball height, local z = -table y
  // then the whole group is rotated back by the cabinet pitch so it reads as an inclined
  // table receding from the player.
  const tiltGroup = new THREE.Group();
  scene.add(tiltGroup);

  function resize(width, height) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  return { scene, camera, renderer, tiltGroup, resize };
}

export function toSceneVec(x, y, z = 0) {
  return { x, y: z, z: -y };
}
