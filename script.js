// ============================================================================
// APPLE VISION PRO - CORE SPATIAL COMPUTING ENGINE (PERFECT ALIGNMENT)
// ============================================================================

const video = document.getElementById("video");
const canvas3d = document.getElementById("three-canvas");

// --- 1. SET UP RUANG 3D & PROYEKSI KAMERA ---
const scene = new THREE.Scene();
const camera3d = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000); // Rasio dikunci ke 16:9
const renderer = new THREE.WebGLRenderer({ canvas: canvas3d, alpha: true, antialias: true });

renderer.setSize(canvas3d.clientWidth, canvas3d.clientHeight, false);
camera3d.position.set(0, 0, 5); // Jarak kamera optimal untuk melacak kedalaman tangan

// Tata Cahaya Spasial
const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
dirLight.position.set(5, 8, 5);
scene.add(dirLight);

// --- 2. STATE & SMOOTHING BUFFER VARIABLE ---
const MAX_OBJECTS = 20;
let spatialObjects = [];
let selectedObject = null;
let hoveredObject = null;

let pinchState = 'RELEASED';
let spawnTimer = 0;
let deleteTimer = 0;

// Array 21 Titik untuk Menampung Koordinat Tangan yang Sudah Dihaluskan (Bebas Jitter)
let smoothedLandmarks = Array.from({ length: 21 }, () => new THREE.Vector3());

// Pointer Utama Ujung Jari Telunjuk (Feature 1)
const pointerGeometry = new THREE.SphereGeometry(0.09, 32, 32);
const pointerMaterial = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.85 });
const spatialPointer = new THREE.Mesh(pointerGeometry, pointerMaterial);
spatialPointer.add(new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffffff })));
scene.add(spatialPointer);

const handVisualizerGroup = new THREE.Group();
scene.add(handVisualizerGroup);

// --- 3. METODE KALIBRASI POSISI 1:1 (MATRIKS JAVASCRIPT) ---
function mapToSpatialSpace(landmark) {
    // Hitung ukuran lebar & tinggi dinding kamera 3D secara dinamis di koordinat Z = 0
    const distance = camera3d.position.z;
    const visibleHeight = 2 * Math.tan((camera3d.fov * Math.PI) / 360) * distance;
    const visibleWidth = visibleHeight * camera3d.aspect;

    // KUNCI UTAMA: Membalik sumbu X di sini (-(landmark.x - 0.5)) karena video dicerminkan lewat CSS.
    // Ini membuat koordinat 3D Three.js sinkron sempurna dengan tangan asli Anda di kamera.
    const targetX = -(landmark.x - 0.5) * visibleWidth;
    const targetY = -(landmark.y - 0.5) * visibleHeight;
    const targetZ = -(landmark.z * 4.0); // Amplifikasi pergerakan kedalaman maju-mundur

    return new THREE.Vector3(targetX, targetY, targetZ);
}

// --- 4. ENGINE DETEKSI GESTURE ---
function evaluateGestures(landmarks) {
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];
    const indexKnuckle = landmarks[5];
    const middleTip = landmarks[12];
    const ringTip = landmarks[16];
    const pinkyTip = landmarks[20];

    // Jarak jepitan jempol dan telunjuk
    const pinchDist = thumbTip.distanceTo(indexTip);
    
    const isIndexExtended = indexTip.y < indexKnuckle.y;
    const isMiddleExtended = middleTip.y < landmarks[9].y;
    const isRingExtended = ringTip.y < landmarks[13].y;
    const isPinkyExtended = pinkyTip.y < landmarks[17].y;

    if (pinchDist < 0.25) { // Threshold disesuaikan dengan skala ruang 3D yang baru
        pinchState = (pinchState === 'RELEASED') ? 'PRESSED' : 'HOLDING';
    } else {
        pinchState = 'RELEASED';
    }

    if (!isIndexExtended && !isMiddleExtended && !isRingExtended && !isPinkyExtended) return { name: "Fist (Kepalan)", basic: "CLOSED" };
    if (isIndexExtended && isMiddleExtended && !isRingExtended && !isPinkyExtended) return { name: "Peace Sign", basic: "PEACE" };
    if (isIndexExtended && isMiddleExtended && isRingExtended && isPinkyExtended) return { name: "Open Palm (Tangan Terbuka)", basic: "OPEN" };
    if (pinchState === 'HOLDING' || pinchState === 'PRESSED') return { name: "Pinch / Grab", basic: "PINCH" };

    return { name: "Mencari Tangan...", basic: "UNKNOWN" };
}

// --- 5. INTERAKSI SPASIAL & PENDARAN HOVER ---
function handleObjectHover(pointerPos) {
    let closestObj = null;
    let minDistance = 0.5;

    spatialObjects.forEach(obj => {
        const dist = pointerPos.distanceTo(obj.mesh.position);
        if (dist < minDistance) {
            minDistance = dist;
            closestObj = obj;
        }
    });

    if (closestObj) {
        if (hoveredObject !== closestObj) {
            clearHoverState();
            hoveredObject = closestObj;
            hoveredObject.mesh.material.emissive.setHex(0x002233); // Efek Glow saat disentuh pointer
        }
    } else {
        clearHoverState();
    }
}

function clearHoverState() {
    if (hoveredObject) {
        hoveredObject.mesh.material.emissive.setHex(0x000000);
        hoveredObject = null;
    }
}

function createSpatialObject(position) {
    if (spatialObjects.length >= MAX_OBJECTS) return;

    const types = ['cube', 'sphere', 'panel'];
    const type = types[Math.floor(Math.random() * types.length)];
    let geom;

    if (type === 'cube') geom = new THREE.BoxGeometry(0.6, 0.6, 0.6);
    else if (type === 'sphere') geom = new THREE.SphereGeometry(0.35, 32, 32);
    else geom = new THREE.BoxGeometry(1.0, 0.6, 0.03); // Panel visionOS Window

    const mat = new THREE.MeshStandardMaterial({
        color: Math.random() * 0xffffff,
        roughness: 0.15,
        metalness: 0.1,
        transparent: true,
        opacity: 0.85
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(position);
    scene.add(mesh);

    spatialObjects.push({
        id: Math.floor(Math.random() * 10000),
        type: type,
        mesh: mesh,
        velocity: new THREE.Vector3(0, 0, 0)
    });
}

function dissolveObject(obj) {
    const duration = 300;
    const start = Date.now();
    function anim() {
        const progress = (Date.now() - start) / duration;
        if (progress < 1) {
            obj.mesh.scale.multiplyScalar(0.85);
            obj.mesh.material.opacity = 1 - progress;
            requestAnimationFrame(anim);
        } else {
            scene.remove(obj.mesh);
            spatialObjects = spatialObjects.filter(item => item.id !== obj.id);
            if (selectedObject === obj) selectedObject = null;
            updateInspector();
        }
    }
    anim();
}

// --- 6. RENDERING TULANG TANGAN PREMIUM (Feature 14) ---
function drawPremiumSkeleton() {
    handVisualizerGroup.clear();
    const jointMat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
    const boneMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 });

    // Render bola pendar di setiap sendi
    smoothedLandmarks.forEach(pos => {
        const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), jointMat);
        sphere.position.copy(pos);
        handVisualizerGroup.add(sphere);
    });

    // Hubungkan garis antar sendi tangan
    HAND_CONNECTIONS.forEach(conn => {
        const geom = new THREE.BufferGeometry().setFromPoints([smoothedLandmarks[conn[0]], smoothedLandmarks[conn[1]]]);
        handVisualizerGroup.add(new THREE.Line(geom, boneMat));
    });
}

// --- 7. UTAMA: PROCESSING LOOP PIPELINE ---
function onResults(results) {
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        spatialPointer.visible = false;
        handVisualizerGroup.clear();
        clearHoverState();
        document.getElementById("current-gesture").innerText = "Mencari Tangan...";
        return;
    }

    spatialPointer.visible = true;
    const primaryHandRaw = results.multiHandLandmarks[0];
    
    // TAHAP FILTER UTAMA: Ambil koordinat mentah, lalu lakukan LERP ke array smoothedLandmarks.
    // Koefisien 0.35 memberikan keseimbangan sempurna: Getaran hilang total, tapi respons instan tanpa lag!
    for (let i = 0; i < 21; i++) {
        const targetPos = mapToSpatialSpace(primaryHandRaw[i]);
        smoothedLandmarks[i].lerp(targetPos, 0.35);
    }

    // Tempatkan kursor di koordinat ujung jari telunjuk yang sudah halus (index 8)
    spatialPointer.position.copy(smoothedLandmarks[8]);

    // Gambar kerangka tangan digital yang mewah
    drawPremiumSkeleton();

    // Evaluasi gesture berdasarkan sendi yang sudah dihaluskan
    const gesture = evaluateGestures(smoothedLandmarks);
    document.getElementById("current-gesture").innerText = `Gesture: ${gesture.name}`;

    handleObjectHover(spatialPointer.position);

    // LOGIK MANIPULASI OBJEK BERDASARKAN GESTURE
    if (gesture.basic === "OPEN") {
        spawnTimer += 16.67;
        if (spawnTimer >= 1000) { // Tahan 1 detik untuk memunculkan objek baru
            createSpatialObject(spatialPointer.position.clone().add(new THREE.Vector3(0, 0, -0.4)));
            spawnTimer = 0;
        }
    } else { spawnTimer = 0; }

    if (pinchState === 'PRESSED' && hoveredObject) {
        selectedObject = hoveredObject;
    }

    if (pinchState === 'HOLDING' && selectedObject) {
        const lastPos = selectedObject.mesh.position.clone();
        
        // Objek ditarik mengikuti kursor dengan lerp halus 0.2
        selectedObject.mesh.position.lerp(spatialPointer.position, 0.2);
        
        // Hitung sisa energi gerakan untuk efek lemparan fisika meluncur (momentum)
        selectedObject.velocity.subVectors(selectedObject.mesh.position, lastPos);

        // Hitung orientasi rotasi objek berdasarkan arah telapak tangan (pergelangan ke jari tengah)
        const wrist = smoothedLandmarks[0];
        const knuckle = smoothedLandmarks[9];
        const dir = new THREE.Vector3().subVectors(knuckle, wrist).normalize();
        selectedObject.mesh.rotation.x = dir.y * 1.8;
        selectedObject.mesh.rotation.y = dir.x * 1.8;
    }

    if (pinchState === 'RELEASED') selectedObject = null;

    // Penskalaan Objek Dua Tangan (Feature 9)
    if (results.multiHandLandmarks.length >= 2 && gesture.basic === "OPEN" && selectedObject) {
        const secondaryHandRaw = results.multiHandLandmarks[1];
        const secPointerTarget = mapToSpatialSpace(secondaryHandRaw[8]);
        const dist = spatialPointer.position.distanceTo(secPointerTarget);
        selectedObject.mesh.scale.setScalar(Math.max(0.4, Math.min(2.5, dist * 0.6)));
    }

    if (gesture.basic === "CLOSED" && hoveredObject) {
        deleteTimer += 16.67;
        if (deleteTimer >= 1000) { // Kepalkan tangan di atas objek selama 1 detik untuk menghapus
            dissolveObject(hoveredObject);
            deleteTimer = 0;
        }
    } else { deleteTimer = 0; }

    updateInspector();
}

function updateInspector() {
    const panel = document.getElementById("object-inspector");
    if (!selectedObject) { panel.classList.add("hidden"); return; }
    panel.classList.remove("hidden");
    document.getElementById("inspect-status").innerText = "GRABBED";
    document.getElementById("inspect-status").className = "badge active";
    document.getElementById("inspect-id").innerText = selectedObject.id;
    document.getElementById("inspect-type").innerText = selectedObject.type.toUpperCase();
    document.getElementById("inspect-px").innerText = selectedObject.mesh.position.x.toFixed(2);
    document.getElementById("inspect-py").innerText = selectedObject.mesh.position.y.toFixed(2);
    document.getElementById("inspect-pz").innerText = selectedObject.mesh.position.z.toFixed(2);
    document.getElementById("inspect-rx").innerText = selectedObject.mesh.rotation.x.toFixed(2);
    document.getElementById("inspect-ry").innerText = selectedObject.mesh.rotation.y.toFixed(2);
    document.getElementById("inspect-rz").innerText = selectedObject.mesh.rotation.z.toFixed(2);
    document.getElementById("inspect-scale").innerText = selectedObject.mesh.scale.x.toFixed(2);
}

// --- 8. TICK ANIMATION & MOMENTUM PHYSICS (Feature 13) ---
function animate() {
    requestAnimationFrame(animate);
    
    spatialObjects.forEach(obj => {
        if (obj !== selectedObject) {
            // Jalankan peluncuran momentum fisika saat objek dilepas dari genggaman tangan
            obj.mesh.position.add(obj.velocity);
            obj.velocity.multiplyScalar(0.92); // Perlambatan gesekan udara secara halus
            
            // Efek putaran lambat konstan saat melayang bebas
            obj.mesh.rotation.x += 0.003;
            obj.mesh.rotation.y += 0.002;
        }
    });
    
    renderer.render(scene, camera3d);
}
animate();

// --- 9. MENYALAKAN HARDWARE & ENGINE ---
async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
    video.srcObject = stream;
}
startCamera();

const hands = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.75, minTrackingConfidence: 0.75 });
hands.onResults(onResults);

const camera = new Camera(video, {
    onFrame: async () => { await hands.send({ image: video }); },
    width: 1280, height: 720
});
camera.start();

// Handle perubahan ukuran layar browser secara dinamis tanpa merusak rasio 16:9
window.addEventListener('resize', () => {
    const w = canvas3d.clientWidth;
    const h = canvas3d.clientHeight;
    camera3d.aspect = w / h;
    camera3d.updateProjectionMatrix();
    renderer.setSize(w, h, false);
});
