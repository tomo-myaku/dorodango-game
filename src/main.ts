import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

type Stage = 'roll' | 'dry' | 'polish' | 'done';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

const view = element<HTMLDivElement>('view');
const heading = element('title');
const hint = element('hint');
const next = element<HTMLButtonElement>('next');
const modeButton = element<HTMLButtonElement>('mode');
const retry = element<HTMLButtonElement>('retry');
const results = element('results');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
renderer.setClearColor(0xe8e3d9, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
camera.position.set(0, 0.12, 4.8);

const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environment = pmrem.fromScene(room, 0.04);
scene.environment = environment.texture;
room.dispose();
pmrem.dispose();

scene.add(new THREE.HemisphereLight(0xfff4da, 0x736756, 2.3));
const key = new THREE.DirectionalLight(0xfff1d4, 3);
key.position.set(-3, 4, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xe6ecff, 1.2);
fill.position.set(3, 1, -2);
scene.add(fill);

// 頂点ごとに形状、粗さ、研磨の蓄積、傷を保持する。
const geometry = new THREE.SphereGeometry(1, 80, 56);
const position = geometry.getAttribute('position') as THREE.BufferAttribute;
const count = position.count;
const directions: THREE.Vector3[] = [];
const radius = new Float32Array(count);
const roughness = new Float32Array(count);
const wear = new Float32Array(count);
const damage = new Float32Array(count);
const surface = new Float32Array(count);
const colors = new Float32Array(count * 3);

for (let i = 0; i < count; i++) {
  directions.push(new THREE.Vector3().fromBufferAttribute(position, i).normalize());
}

geometry.setAttribute('aSurface', new THREE.BufferAttribute(surface, 1));
geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

const material = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  vertexColors: true,
  roughness: 0.9,
  metalness: 0.06,
  envMapIntensity: 1.25,
  specularIntensity: 1.15
});

// 局所的な研磨を、フラグメントの粗さへ反映する。
material.onBeforeCompile = shader => {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nattribute float aSurface;\nvarying float vSurface;'
    )
    .replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvSurface = aSurface;'
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\nvarying float vSurface;'
    )
    .replace(
      '#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\nroughnessFactor = clamp(vSurface, 0.045, 1.0);'
    );
};
material.customProgramCacheKey = () => 'local-clay-roughness-v1';

const ball = new THREE.Mesh(geometry, material);
scene.add(ball);

// 薄い影。生成画像や外部アセットは不要。
const shadowCanvas = document.createElement('canvas');
shadowCanvas.width = shadowCanvas.height = 128;
const context = shadowCanvas.getContext('2d')!;
const gradient = context.createRadialGradient(64, 64, 3, 64, 64, 62);
gradient.addColorStop(0, 'rgba(55,45,26,.22)');
gradient.addColorStop(1, 'rgba(55,45,26,0)');
context.fillStyle = gradient;
context.fillRect(0, 0, 128, 128);

const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
const shadow = new THREE.Mesh(
  new THREE.PlaneGeometry(3.1, 1),
  new THREE.MeshBasicMaterial({
    map: shadowTexture, transparent: true, depthWrite: false
  })
);
shadow.position.set(0, -1.25, -0.5);
scene.add(shadow);

let stage: Stage = 'roll';
let polishing = true;
let water = 0.88;
let hardness = 0.12;
let dryElapsed = 0;
let seed = 1;
let dirty = true;
let activePointer: number | null = null;
let lastX = 0;
let lastY = 0;
let lastTime = 0;
let lastHit: THREE.Vector3 | null = null;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const inverse = new THREE.Quaternion();
const axis = new THREE.Vector3();
const color = new THREE.Color();
const clamp = THREE.MathUtils.clamp;

function randomGenerator(value: number) {
  return () => {
    value |= 0;
    value = (value + 0x6D2B79F5) | 0;
    let n = Math.imul(value ^ (value >>> 15), 1 | value);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

function refreshUI() {
  const stages: Stage[] = ['roll', 'dry', 'polish', 'done'];
  document.querySelectorAll('nav span').forEach((item, i) => {
    item.classList.toggle('active', stages[i] === stage);
  });

  const titles = {
    roll: 'ひとつの、土のかたまり。',
    dry: '土の色が、変わっていく。',
    polish: '光を、少しずつ。',
    done: 'あなたの手が、つくったもの。'
  };

  const hints = {
    roll: '指をすべらせて、手のなかで転がします。\n気が済んだら、次の工程へ。',
    dry: '置いて、少し待つ時間。\n表情を見ながら、磨きはじめる頃合いを。',
    polish: polishing
      ? '表面を指でなぞって磨きます。\n別の面へ移るときは「回す」に切り替えます。'
      : '指をすべらせて、別の面を手前へ。\n磨くときは「磨く」に切り替えます。',
    done: '指で回して、光の映り方を眺めてください。'
  };

  heading.textContent = titles[stage];
  hint.style.whiteSpace = 'pre-line';
  hint.textContent = hints[stage];
  modeButton.hidden = stage !== 'polish';
  modeButton.textContent = polishing ? '回すに切替' : '磨くに切替';
  next.hidden = stage === 'done';
  retry.hidden = stage !== 'done';
  results.hidden = stage !== 'done';
  next.textContent = stage === 'roll'
    ? '乾かしはじめる'
    : stage === 'dry' ? '磨きはじめる' : '完成にする';
}

function reset(useSeed?: number) {
  const querySeed = Number(new URLSearchParams(location.search).get('seed'));
  seed = useSeed ??
    (Number.isFinite(querySeed) && querySeed > 0
      ? querySeed >>> 0
      : crypto.getRandomValues(new Uint32Array(1))[0]);

  // シードはURLとローカルストレージに保存。保存不可でもプレイ可能。
  try {
    localStorage.setItem('dorodango-last-seed', String(seed));
    const url = new URL(location.href);
    url.searchParams.set('seed', String(seed));
    history.replaceState(null, '', url);
  } catch { /* Storage or history may be unavailable. */ }

  element('seed').textContent = `土の種 ${seed}`;
  const random = randomGenerator(seed);
  const phases = Array.from({ length: 8 }, () => random() * Math.PI * 2);

  for (let i = 0; i < count; i++) {
    const p = directions[i];
    const shape =
      Math.sin(p.x * 3.6 + phases[0]) *
        Math.cos(p.y * 3.1 + phases[1]) * 0.14 +
      Math.sin(p.z * 4.2 + phases[2]) *
        Math.cos(p.x * 2.8 + phases[3]) * 0.10 +
      (p.x * p.x - p.y * p.y) * 0.09;
    const grain = Math.sin(
      p.x * 53 + Math.sin(p.y * 37 + phases[4]) * 2 +
      p.z * 41 + phases[5]
    );
    radius[i] = 1 + shape + grain * 0.008;
    roughness[i] = 0.87 + grain * 0.035;
    wear[i] = 0;
    damage[i] = 0;
  }

  stage = 'roll';
  polishing = true;
  water = 0.88;
  hardness = 0.12;
  dryElapsed = 0;
  ball.quaternion.identity();
  activePointer = null;
  lastHit = null;
  dirty = true;
  updateMesh();
  refreshUI();
}

function updateMesh() {
  const dryness = 1 - water;

  for (let i = 0; i < count; i++) {
    const p = directions[i];
    const scar = damage[i];
    position.setXYZ(
      i, p.x * radius[i], p.y * radius[i], p.z * radius[i]
    );

    // 水分由来の濡れた光沢と、研磨による平滑化を分ける。
    surface[i] = clamp(
      roughness[i] - water * 0.12 + scar * 0.4, 0.045, 1
    );

    const fineGrain = Math.sin(p.x * 143 + p.y * 97 + p.z * 131) * 0.018;
    const crackLine = Math.pow(
      Math.max(0, 1 - Math.abs(
        Math.sin(p.x * 24 + Math.sin(p.y * 17) * 1.5 + p.z * 19)
      ) * 9),
      2
    );
    const crack = scar * (0.22 + crackLine * 0.78);
    const lightness =
      0.205 + dryness * 0.125 + fineGrain * roughness[i] -
      crack * 0.18 - (1 - roughness[i]) * 0.035;

    color.setHSL(0.085, 0.28 + water * 0.1, clamp(lightness, 0.07, 0.5));
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  position.needsUpdate = true;
  geometry.getAttribute('aSurface').needsUpdate = true;
  geometry.getAttribute('color').needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  dirty = false;
}

function localHit(x: number, y: number): THREE.Vector3 | null {
  const rect = view.getBoundingClientRect();
  pointer.set(
    ((x - rect.left) / rect.width) * 2 - 1,
    -((y - rect.top) / rect.height) * 2 + 1
  );
  ball.updateMatrixWorld(true);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(ball, false)[0];
  return hit ? ball.worldToLocal(hit.point.clone()).normalize() : null;
}

function rotate(dx: number, dy: number) {
  const length = Math.hypot(dx, dy);
  if (length < 0.00001) return;
  axis.set(dy, dx, 0).normalize();
  ball.quaternion.premultiply(
    new THREE.Quaternion().setFromAxisAngle(axis, length * 3.5)
  );
}

// 丸める操作。
// 手前に接した領域を均し、回転によって別の面が手に接する。
// 一方向の回転では回転軸の近くが残る。
function roll(dx: number, dy: number, speed: number) {
  const distance = Math.hypot(dx, dy);
  inverse.copy(ball.quaternion).invert();
  const contact = new THREE.Vector3(0, 0, 1).applyQuaternion(inverse);
  const quality = Math.exp(-Math.pow((speed - 0.55) / 0.9, 2));
  const force = clamp((speed - 1.7) / 2, 0, 1);

  for (let i = 0; i < count; i++) {
    const dot = directions[i].dot(contact);
    const weight = Math.pow(clamp((dot - 0.2) / 0.8, 0, 1), 1.5);
    if (weight === 0) continue;

    const correction = 1 - Math.exp(-distance * 8 * quality * weight);
    radius[i] += (1 - radius[i]) * correction;

    // 乱暴な動きは局所的なへこみを生む。後から均し直せる。
    radius[i] -= distance * force * weight * 0.085;
    radius[i] = clamp(radius[i], 0.76, 1.25);
    roughness[i] = Math.max(
      0.67, roughness[i] - distance * weight * quality * 0.06
    );
  }

  rotate(dx, dy);
  dirty = true;
}

function polishStamp(center: THREE.Vector3, travel: number, speed: number) {
  const suitableWater = Math.exp(-Math.pow((water - 0.32) / 0.24, 2));
  const suitableSpeed = Math.exp(-Math.pow((speed - 0.42) / 0.65, 2));
  const harsh = clamp((speed - 1.4) / 1.5, 0, 1);

  for (let i = 0; i < count; i++) {
    const dot = directions[i].dot(center);
    if (dot < 0.978) continue;
    const weight = Math.pow((dot - 0.978) / 0.022, 2);
    const dose = travel * weight;
    wear[i] += dose;

    const overwork = clamp((wear[i] - 1.4) / 1.4, 0, 1);
    const skill = suitableWater * suitableSpeed * (1 - overwork);

    roughness[i] = clamp(
      roughness[i] - dose * skill * 1.7 +
      dose * (harsh * 0.28 + overwork * 0.32),
      0.045, 0.98
    );

    // 濡れた状態では形が動く。乾きすぎると傷が増える。
    const wet = clamp((water - 0.52) / 0.35, 0, 1);
    const brittle = clamp((0.2 - water) / 0.2, 0, 1);
    damage[i] = clamp(
      damage[i] + dose *
      (brittle * (0.12 + harsh * 0.5) + overwork * 0.22 + harsh * 0.13),
      0, 1
    );
    radius[i] = clamp(
      radius[i] - dose * (wet * 0.05 + overwork * 0.008),
      0.73, 1.25
    );
  }
  dirty = true;
}

function polishStroke(
  from: THREE.Vector3, to: THREE.Vector3, speed: number
) {
  const angle = from.angleTo(to);
  if (!Number.isFinite(angle) || angle > 0.65 || angle < 0.00001) return;
  const steps = Math.max(1, Math.ceil(angle / 0.035));
  for (let step = 1; step <= steps; step++) {
    const center = from.clone().lerp(to, step / steps).normalize();
    polishStamp(center, angle / steps, speed);
  }
}

view.addEventListener('pointerdown', event => {
  if (activePointer !== null || stage === 'dry') return;
  const hit = localHit(event.clientX, event.clientY);
  if (!hit) return;

  activePointer = event.pointerId;
  view.setPointerCapture(event.pointerId);
  lastX = event.clientX;
  lastY = event.clientY;
  lastTime = event.timeStamp;
  lastHit = hit;
});

view.addEventListener('pointermove', event => {
  if (event.pointerId !== activePointer) return;
  const scale = Math.min(view.clientWidth, view.clientHeight);
  const dx = (event.clientX - lastX) / scale;
  const dy = (event.clientY - lastY) / scale;
  const elapsed = Math.max(0.008, (event.timeStamp - lastTime) / 1000);
  const speed = Math.hypot(dx, dy) / elapsed;

  if (stage === 'roll') {
    // 極端に大きい単発イベントは分割して安定させる。
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.025));
    for (let i = 0; i < steps; i++) roll(dx / steps, dy / steps, speed);
  } else if (stage === 'done' || (stage === 'polish' && !polishing)) {
    rotate(dx, dy);
  } else if (stage === 'polish') {
    const hit = localHit(event.clientX, event.clientY);
    if (hit && lastHit) polishStroke(lastHit, hit, speed);
    lastHit = hit;
  }

  lastX = event.clientX;
  lastY = event.clientY;
  lastTime = event.timeStamp;
});

function releasePointer() {
  if (activePointer !== null && view.hasPointerCapture(activePointer)) {
    view.releasePointerCapture(activePointer);
  }
  activePointer = null;
  lastHit = null;
}

view.addEventListener('pointerup', releasePointer);
view.addEventListener('pointercancel', releasePointer);
view.addEventListener('lostpointercapture', () => {
  activePointer = null;
  lastHit = null;
});

modeButton.addEventListener('click', () => {
  releasePointer();
  polishing = !polishing;
  refreshUI();
});

function scoreFinished() {
  // 経緯線の密度差を補正して面積に近い重みで評価する。
  let weightSum = 0;
  let meanRadius = 0;
  let meanRough = 0;
  let meanDamage = 0;
  let meanGloss = 0;

  for (let i = 0; i < count; i++) {
    const weight = Math.sqrt(Math.max(0, 1 - directions[i].y ** 2));
    weightSum += weight;
    meanRadius += radius[i] * weight;
    meanRough += roughness[i] * weight;
    meanDamage += damage[i] * weight;
    meanGloss += Math.pow(1 - surface[i], 2) * weight;
  }

  meanRadius /= weightSum;
  meanRough /= weightSum;
  meanDamage /= weightSum;
  meanGloss /= weightSum;

  let variance = 0;
  for (let i = 0; i < count; i++) {
    const weight = Math.sqrt(Math.max(0, 1 - directions[i].y ** 2));
    variance += (radius[i] - meanRadius) ** 2 * weight;
  }

  const deviation = Math.sqrt(variance / weightSum) / meanRadius;
  const roundness = clamp(100 * (1 - deviation / 0.13), 0, 100);
  const smoothness = clamp(
    (1 - meanRough) * 100 - meanDamage * 30, 0, 100
  );
  const gloss = clamp(meanGloss * 110, 0, 100);
  const strength = clamp(
    100 * hardness * (1 - meanDamage * 0.8) *
    (0.65 + 0.35 * Math.exp(-Math.pow((water - 0.25) / 0.3, 2))),
    0, 100
  );
  const total =
    roundness * 0.35 + smoothness * 0.25 + gloss * 0.25 + strength * 0.15;

  const entries: [string, number][] = [
    ['真球度', roundness],
    ['平滑度', smoothness],
    ['光沢度', gloss],
    ['耐久度', strength]
  ];

  element('grades').replaceChildren(...entries.map(([label, value]) => {
    const item = document.createElement('span');
    item.textContent = label;
    const number = document.createElement('b');
    number.textContent = String(Math.round(value));
    item.appendChild(number);
    return item;
  }));

  const rank = total >= 85 ? '秀作' : total >= 65 ? '佳作' :
    total >= 40 ? '手の跡' : 'はじまりの一球';

  let comment = '土の表情が残る、あなただけの一球です。';
  if (meanDamage > 0.15) {
    comment = '細かな傷も手仕事の記録。光を傾けると、表情が変わります。';
  } else if (roundness < 65) {
    comment = '光のゆらぎに、丸めたときの形が残っています。';
  } else if (gloss > 65) {
    comment = '静かな光をまとった一球。映り込みまで眺めてみてください。';
  } else if (water > 0.5) {
    comment = 'まだ柔らかさを含んだ一球。指がふれた跡が残りました。';
  } else if (roundness > 85) {
    comment = '丁寧に整った輪郭。磨き残しにも、土らしい味わいがあります。';
  }

  element('review').textContent = `${rank} — ${comment}`;
}

next.addEventListener('click', () => {
  releasePointer();
  if (stage === 'roll') {
    stage = 'dry';
  } else if (stage === 'dry') {
    stage = 'polish';
    polishing = true;
  } else if (stage === 'polish') {
    updateMesh();
    stage = 'done';
    scoreFinished();
  }
  refreshUI();
});

retry.addEventListener('click', () => {
  // 再挑戦は新しい土。URLのseed指定で同じ土からも始められる。
  reset(crypto.getRandomValues(new Uint32Array(1))[0]);
});

function resize() {
  const width = view.clientWidth;
  const height = Math.max(1, view.clientHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;

  // 縦長画面でも横方向に団子が収まる距離を確保。
  camera.position.z = Math.max(4.8, 3.65 / camera.aspect);
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(view);
resize();
reset();

let previousTime = performance.now();
let accumulator = 0;

function dryStep(dt: number) {
  dryElapsed += dt;
  water = Math.max(0.035, 0.88 * Math.exp(-dryElapsed / 27));
  hardness = clamp(0.12 + (0.88 - water) * 1.06, 0.12, 0.98);

  // 乾燥しすぎると、形の歪みが大きい場所ほど割れやすい。
  if (water < 0.17) {
    for (let i = 0; i < count; i++) {
      const stress = Math.abs(radius[i] - 1);
      damage[i] = clamp(
        damage[i] + dt * (0.17 - water) * (0.02 + stress * 0.8),
        0, 1
      );
    }
  }
  dirty = true;
}

renderer.setAnimationLoop(time => {
  const dt = Math.min((time - previousTime) / 1000, 0.1);
  previousTime = time;

  // 乾燥は固定刻み。バックグラウンド放置による急変も防ぐ。
  if (stage === 'dry' && !document.hidden) {
    accumulator += dt;
    while (accumulator >= 1 / 30) {
      dryStep(1 / 30);
      accumulator -= 1 / 30;
    }
  } else {
    accumulator = 0;
  }

  if (dirty) updateMesh();
  renderer.render(scene, camera);
});

document.addEventListener('visibilitychange', () => {
  releasePointer();
  previousTime = performance.now();
  accumulator = 0;
});
