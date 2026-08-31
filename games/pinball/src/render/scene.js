// three.js only lives here (and in sibling render/ modules). Not imported by physics/,
// table/ or rules/.
import * as THREE from 'three';

export function createScene(canvas) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fd3ff);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 10);
  camera.position.set(0, 0.85, 0.55);
  camera.lookAt(0, 0, -0.4);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(0.3, 1, 0.5);
  const ambient = new THREE.AmbientLight(0xffffff, 0.3);
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
