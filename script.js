// ==========================================
// CONFIGURATIONS & SPATIAL PARAMETERS
// ==========================================
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const viewport = document.getElementById("app-viewport");

const TRACKING_PERSISTENCE_MS = 600;  
const PREDICTION_FACTOR_MS = 35;     
const POINTER_LANDMARK = 8;          
const THUMB_LANDMARK = 4;            
const WRIST_LANDMARK = 0;            
const DEADZONE = 0.0008;             

let trackedHands = [];
let lastTimestamp = performance.now();

// Array Penyimpanan Multi-Objek Spasial (Maks 20 Objek)
let spatialObjects = [];
let selectedObjectId = null;

// ==========================================
// INITIALIZE THREE.JS 3D ENGINE
// ==========================================
const threeContainer = document.getElementById("three-container");
const scene = new THREE.Scene();

// Camera setup dengan FOV yang cocok dengan perspektif mata alami
const camera3D = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera3D.position.set(0, 0, 5);

const renderer3D = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer3D.setSize(window.innerWidth, window.innerHeight);
renderer3D.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer3D.shadowMap.enabled = true;
threeContainer.appendChild(renderer3D.domElement);

// Ambient & Soft Spotlight (visionOS Lighting Style)
const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambientLight);

const spotLight = new THREE.SpotLight(0xffffff, 0.8);
spotLight.position.set(0, 5, 5);
spotLight.castShadow = true;
scene.add(spotLight);

// Jendela Virtual Windows Statis Awal (Apple Vision Pro Style Window Container)
let virtualWindow = null;
function createVirtualWindow() {
    const geometry = new THREE.PlaneGeometry(1.6, 0.9);
    const material = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.15,
        roughness: 0.1,
        transmission: 0.6, 
        thickness: 0.05,
        ior: 1.5,
        side: THREE.DoubleSide
    });
    virtualWindow = new THREE.Mesh(geometry, material);
    virtualWindow.position.set(0, 0.5, -1.5);
    virtualWindow.userData = { id: "Virtual_Window_1", isWindow: true, type: "Glass Window" };
    scene.add(virtualWindow);
}
createVirtualWindow();

// ==========================================
// STABLE MATHEMATICS ENGINE: HAND DATA PROCESSING
// ==========================================
class TrackedHand {
    constructor(landmarks, handedness) {
        this.id = Math.random().toString(36).substring(2, 9);
        this.label = handedness.label; // "Left" atau "Right"
        this.lastSeen = performance.now();

        this.smoothedLandmarks = landmarks.map(p => ({ x: p.x, y: p.y, z: p.z }));
        this.velocities = landmarks.map(() => ({ x: 0, y: 0, z: 0 }));

        // Gesture Buffer & Debouncing Counters
        this.pinchActive = false;
        this.pinchFrames = 0;
        this.openPalmFrames = 0;
        this.fistFrames = 0;
        this.peaceFrames = 0;
    }

    update(newLandmarks, handedness, dt) {
        this.lastSeen = performance.now();
        if (handedness.score > 0.80) this.label = handedness.label;

        const MIN_ALPHA = 0.08;
        const MAX_ALPHA = 0.85;

        for (let i = 0; i < 21; i++) {
            const current = newLandmarks[i];
            const prevSmooth = this.smoothedLandmarks[i];

            const dx = current.x - prevSmooth.x;
            const dy = current.y - prevSmooth.y;
            const dz = current.z - prevSmooth.z;
            const distance = Math.sqrt(dx*dx + dy*dy);

            if (distance < DEADZONE) {
                this.velocities[i] = { x: 0, y: 0, z: 0 };
                continue;
            }

            const instVx = dt > 0 ? dx / dt : 0;
            const instVy = dt > 0 ? dy / dt : 0;
            const instVz = dt > 0 ? dz / dt : 0;

            this.velocities[i].x = this.velocities[i].x * 0.3 + instVx * 0.7;
            this.velocities[i].y = this.velocities[i].y * 0.3 + instVy * 0.7;
            this.velocities[i].z = this.velocities[i].z * 0.3 + instVz * 0.7;

            const speed = Math.sqrt(this.velocities[i].x**2 + this.velocities[i].y**2);
            const speedNorm = Math.min(speed / 2.5, 1.0);
            const adaptiveAlpha = MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * speedNorm;

            this.smoothedLandmarks[i].x += adaptiveAlpha * dx;
            this.smoothedLandmarks[i].y += adaptiveAlpha * dy;
            this.smoothedLandmarks[i].z += adaptiveAlpha * dz;
        }

        this.evaluateGestures();
    }

    extrapolate(dt) {
        for (let i = 0; i < 21; i++) {
            this.velocities[i].x *= 0.85;
            this.velocities[i].y *= 0.85;
            this.velocities[i].z *= 0.85;

            this.smoothedLandmarks[i].x += this.velocities[i].x * dt;
            this.smoothedLandmarks[i].y += this.velocities[i].y * dt;
            this.smoothedLandmarks[i].z += this.velocities[i].z * dt;
        }
    }

    getPredictedLandmarks() {
        const timeFactor = PREDICTION_FACTOR_MS / 1000;
        return this.smoothedLandmarks.map((p, i) => ({
            x: p.x + this.velocities[i].x * timeFactor,
            y: p.y + this.velocities[i].y * timeFactor,
            z: p.z + this.velocities[i].z * timeFactor
        }));
    }

    evaluateGestures() {
        // Hysteresis Pinch Validation
        const thumbTip = this.smoothedLandmarks[THUMB_LANDMARK];
        const indexTip = this.smoothedLandmarks[POINTER_LANDMARK];
        const pDist = Math.sqrt(Math.pow(thumbTip.x - indexTip.x, 2) + Math.pow(thumbTip.y - indexTip.y, 2)) * 1000;

        if (!this.pinchActive && pDist < 25) { 
            this.pinchFrames++;
            if (this.pinchFrames >= 5) this.pinchActive = true;
        } else if (this.pinchActive && pDist > 40) { 
            this.pinchFrames = 0;
            this.pinchActive = false;
        } else if (!this.pinchActive) {
            this.pinchFrames = 0;
        }

        // Hitung jarak jari lain untuk Open Palm & Fist
        const wrist = this.smoothedLandmarks[0];
        const midTip = this.smoothedLandmarks[12];
        const ringTip = this.smoothedLandmarks[16];
        const extDist = Math.sqrt(Math.pow(midTip.x - wrist.x, 2) + Math.pow(midTip.y - wrist.y, 2)) * 100;

        // Open Palm Gesture Engine (✋)
        if (extDist > 35 && pDist > 60) {
            this.openPalmFrames++;
            this.fistFrames = 0;
        } 
        // Fist Gesture Engine (✊)
        else if (extDist < 16) {
            this.fistFrames++;
            this.openPalmFrames = 0;
        } else {
            this.openPalmFrames = 0;
            this.fistFrames = 0;
        }

        // Peace Sign (✌️)
        const ringPip = this.smoothedLandmarks[14];
        if (indexTip.y < ringPip.y && midTip.y < ringPip.y && ringTip.y > ringPip.y) {
            this.peaceFrames++;
        } else {
            this.peaceFrames = 0;
        }
    }

    getOrientation() {
        // Ekstraksi Yaw, Pitch, Roll matematika spasial dari landmark dasar tangan
        const w = this.smoothedLandmarks[WRIST_LANDMARK];
        const i = this.smoothedLandmarks[5];
        const m = this.smoothedLandmarks[17];

        const v1 = new THREE.Vector3(i.x - w.x, i.y - w.y, i.z - w.z).normalize();
        const v2 = new THREE.Vector3(m.x - w.x, m.y - w.y, m.z - w.z).normalize();
        const normal = new THREE.Vector3().crossVectors(v1, v2).normalize();

        return {
            pitch: Math.asin(-v1.y),
            yaw: Math.atan2(v1.x, v1.z),
            roll: Math.atan2(normal.x, normal.y)
        };
    }
}

// ==========================================
// OBJECT CREATION & PHYSICS SYSTEM
// ==========================================
const objectTypes = ["Cube", "Sphere", "GlassPanel"];
let typeCounter = 0;

function spawnSpatialObject(positionX, positionY) {
    if (spatialObjects.length >= 20) return;

    const type = objectTypes[typeCounter % objectTypes.length];
    typeCounter++;

    let geometry;
    let material = new THREE.MeshPhysicalMaterial({
        color: type === "Cube" ? 0x00e5ff : type === "Sphere" ? 0xff0077 : 0xffffff,
        roughness: 0.1,
        transmission: type === "GlassPanel" ? 0.6 : 0.2,
        thickness: 0.2,
        transparent: true,
        opacity: 0.85
    });

    if (type === "Cube") geometry = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    else if (type === "Sphere") geometry = new THREE.SphereGeometry(0.18, 32, 32);
    else geometry = new THREE.BoxGeometry(0.4, 0.25, 0.05);

    const mesh = new THREE.Mesh(geometry, material);
    
    // Normalisasi koordinat layar ke koordinat dunia 3D Three.js
    mesh.position.set((positionX - 0.5) * 3.5, -(positionY - 0.5) * 2.2, -1.0);
    mesh.castShadow = true;

    const id = "SPATIAL_" + Math.random().toString(36).substring(2, 7).toUpperCase();
    mesh.userData = {
        id: id,
        type: type,
        velocity: new THREE.Vector3(0, 0, 0),
        isGrabbed: false
    };

    scene.add(mesh);
    spatialObjects.push(mesh);
    selectedObjectId = id;
}

function deleteSelectedObject() {
    if (!selectedObjectId) return;
    const index = spatialObjects.findIndex(obj => obj.userData.id === selectedObjectId);
    if (index !== -1) {
        const obj = spatialObjects[index];
        
        // Animasi Dissolve Out
        let shrinkInterval = setInterval(() => {
            obj.scale.subScalar(0.08);
            if (obj.scale.x <= 0.1) {
                clearInterval(shrinkInterval);
                scene.remove(obj);
                spatialObjects.splice(index, 1);
                selectedObjectId = null;
                document.getElementById("object-inspector").classList.add("hidden");
            }
        }, 16);
    }
}

// ==========================================
// PIPELINE INTEGRATION DATA PIPELINE (MEDIAPIPE)
// ==========================================
function onResults(results) {
    const now = performance.now();
    const dt = (now - lastTimestamp) / 1000;
    lastTimestamp = now;

    let currentDetections = [];
    if (results.multiHandLandmarks && results.multiHandedness) {
        for (let i = 0; i < results.multiHandLandmarks.length; i++) {
            currentDetections.push({ landmarks: results.multiHandLandmarks[i], info: results.multiHandedness[i] });
        }
    }

    let nextTrackedHands = [];

    currentDetections.forEach((det) => {
        let matchedIndex = -1;
        let closestDistance = 0.20;

        for (let j = 0; j < trackedHands.length; j++) {
            const th = trackedHands[j];
            const distance = Math.sqrt(
                Math.pow(det.landmarks[WRIST_LANDMARK].x - th.smoothedLandmarks[WRIST_LANDMARK].x, 2) +
                Math.pow(det.landmarks[WRIST_LANDMARK].y - th.smoothedLandmarks[WRIST_LANDMARK].y, 2)
            );
            if (distance < closestDistance) {
                closestDistance = distance;
                matchedIndex = j;
            }
        }

        if (matchedIndex !== -1) {
            const handInstance = trackedHands[matchedIndex];
            handInstance.update(det.landmarks, det.info, dt);
            nextTrackedHands.push(handInstance);
            trackedHands.splice(matchedIndex, 1);
        } else {
            nextTrackedHands.push(new TrackedHand(det.landmarks, det.info));
        }
    });

    trackedHands.forEach((th) => {
        if (now - th.lastSeen < TRACKING_PERSISTENCE_MS) {
            th.extrapolate(dt);
            nextTrackedHands.push(th);
        }
    });

    trackedHands = nextTrackedHands;
    processSpatialInteractions();
}

// ==========================================
// INTERACTION & ENGINE MANIPULATION LOGIC
// ==========================================
function processSpatialInteractions() {
    if (trackedHands.length === 0) return;

    // Toggle Focus Mode (Peace Sign ✌️)
    const peaceHand = trackedHands.find(h => h.peaceFrames >= 10);
    if (peaceHand) viewport.classList.add("focus-mode");
    else viewport.classList.remove("focus-mode");

    // Spawn Trigger (Palm ✋ ditahan 1 detik / 60 frame)
    const spawnHand = trackedHands.find(h => h.openPalmFrames >= 60);
    if (spawnHand) {
        const p = spawnHand.smoothedLandmarks[POINTER_LANDMARK];
        spawnSpatialObject(p.x, p.y);
        spawnHand.openPalmFrames = 0; 
    }

    // Delete Trigger (Fist ✊ ditahan 1 detik / 60 frame)
    const deleteHand = trackedHands.find(h => h.fistFrames >= 60);
    if (deleteHand) {
        deleteSelectedObject();
        deleteHand.fistFrames = 0;
    }

    // MULTI-HAND SCALING INTERACTION
    if (trackedHands.length === 2 && selectedObjectId) {
        const h1 = trackedHands[0].smoothedLandmarks[WRIST_LANDMARK];
        const h2 = trackedHands[1].smoothedLandmarks[WRIST_LANDMARK];
        const currentHandDist = Math.sqrt(Math.pow(h1.x - h2.x, 2) + Math.pow(h1.y - h2.y, 2));
        
        const targetObj = spatialObjects.find(o => o.userData.id === selectedObjectId);
        if (targetObj) {
            if (!targetObj.userData.baseDist) {
                targetObj.userData.baseDist = currentHandDist;
                targetObj.userData.baseScale = targetObj.scale.x;
            } else {
                const scaleFactor = currentHandDist / targetObj.userData.baseDist;
                const finalScale = THREE.MathUtils.lerp(targetObj.scale.x, targetObj.userData.baseScale * scaleFactor, 0.15);
                targetObj.scale.set(finalScale, finalScale, finalScale);
            }
            return; 
        }
    } else {
        spatialObjects.forEach(o => delete o.userData.baseDist);
    }

    // SINGLE HAND GRAB, ROTATION & POSITION TRANSLATION (3-AXIS)
    const activeHand = trackedHands[0];
    if (!activeHand) return;

    const pointerPos = activeHand.getPredictedLandmarks()[POINTER_LANDMARK];
    const worldX = (pointerPos.x - 0.5) * 3.5;
    const worldY = -(pointerPos.y - 0.5) * 2.2;
    // Skalasi kedalaman depth berbasis kedekatan Z telapak tangan
    const worldZ = -1.0 + (activeHand.smoothedLandmarks[WRIST_LANDMARK].z * 2.5); 

    let hoveredObject = null;

    // Deteksi Tabrakan / Jarak Dekat (Raycast alternative untuk kestabilan gesture)
    spatialObjects.forEach((obj) => {
        const dist = obj.position.distanceTo(new THREE.Vector3(worldX, worldY, obj.position.z));
        if (dist < 0.35) hoveredObject = obj;
    });

    // Cek juga tabrakan dengan Jendela Virtual Window
    if (virtualWindow) {
        const winDist = virtualWindow.position.distanceTo(new THREE.Vector3(worldX, worldY, virtualWindow.position.z));
        if (winDist < 0.6) hoveredObject = virtualWindow;
    }

    // Efek Hover Khas visionOS UI
    if (hoveredObject) {
        if (!hoveredObject.userData.isWindow) {
            hoveredObject.material.emissive = new THREE.Color(0x004466);
            if (activeHand.pinchActive) {
                selectedObjectId = hoveredObject.userData.id;
                hoveredObject.userData.isGrabbed = true;
            }
        } else {
            // Jika hover ke Jendela virtual
            if (activeHand.pinchActive) virtualWindow.userData.isGrabbed = true;
        }
    } else {
        spatialObjects.forEach(o => o.material.emissive = new THREE.Color(0x000000));
    }

    // Jika Pinch Hold / Dragging Aktif
    if (activeHand.pinchActive) {
        if (selectedObjectId) {
            const grabObj = spatialObjects.find(o => o.userData.id === selectedObjectId);
            if (grabObj && grabObj.userData.isGrabbed) {
                // Hitung kecepatan instan untuk efek melempar (Throw Physics)
                grabObj.userData.velocity.set(
                    (worldX - grabObj.position.x) * 12,
                    (worldY - grabObj.position.y) * 12,
                    (worldZ - grabObj.position.z) * 12
                );

                // Lerp smoothing pemindahan posisi agar menempel halus tanpa hentakan (No Snap)
                grabObj.position.x = THREE.MathUtils.lerp(grabObj.position.x, worldX, 0.25);
                grabObj.position.y = THREE.MathUtils.lerp(grabObj.position.y, worldY, 0.25);
                grabObj.position.z = THREE.MathUtils.lerp(grabObj.position.z, worldZ, 0.25);

                // Integrasi Rotasi Sudut Orientasi Tangan (Pitch, Yaw, Roll) secara real-time
                const rot = activeHand.getOrientation();
                grabObj.rotation.x = THREE.MathUtils.lerp(grabObj.rotation.x, rot.pitch * 2, 0.15);
                grabObj.rotation.y = THREE.MathUtils.lerp(grabObj.rotation.y, rot.yaw * 2, 0.15);
                grabObj.rotation.z = THREE.MathUtils.lerp(grabObj.rotation.z, rot.roll, 0.15);
                
                updateInspector(grabObj);
            }
        }
        
        if (virtualWindow && virtualWindow.userData.isGrabbed) {
            virtualWindow.position.x = THREE.MathUtils.lerp(virtualWindow.position.x, worldX, 0.2);
            virtualWindow.position.y = THREE.MathUtils.lerp(virtualWindow.position.y, worldY, 0.2);
        }
    } else {
        // Release / Drop Object
        spatialObjects.forEach(o => o.userData.isGrabbed = false);
        if (virtualWindow) virtualWindow.userData.isGrabbed = false;
    }
}

// ==========================================
// REAL-TIME WINDOW OBJECT INSPECTOR UI
// ==========================================
function updateInspector(obj) {
    const panel = document.getElementById("object-inspector");
    panel.classList.remove("hidden");
    
    document.getElementById("insp-id").innerText = obj.userData.id;
    document.getElementById("insp-type").innerText = obj.userData.type;
    document.getElementById("insp-pos").innerText = `X:${obj.position.x.toFixed(2)} Y:${obj.position.y.toFixed(2)} Z:${obj.position.z.toFixed(2)}`;
    document.getElementById("insp-rot").innerText = `X:${obj.rotation.x.toFixed(1)}° Y:${obj.rotation.y.toFixed(1)}°`;
    document.getElementById("insp-scale").innerText = obj.scale.x.toFixed(2) + "x";
    document.getElementById("insp-vel").innerText = obj.userData.velocity.length().toFixed(1) + " m/s";
    document.getElementById("insp-status").innerText = obj.userData.isGrabbed ? "SELECTED / GRAB" : "STABLE";
}

// ==========================================
// HIGH PERFORMANCE RENDERING LOOP (60 FPS)
// ==========================================
function renderLoop() {
    requestAnimationFrame(renderLoop);

    // Otomatisasi sinkronisasi ukuran internal resolusi aspek rasio viewports
    if (video.videoWidth && canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        camera3D.aspect = window.innerWidth / window.innerHeight;
        camera3D.updateProjectionMatrix();
        renderer3D.setSize(window.innerWidth, window.innerHeight);
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // PHYSICS INERTIA SIMULATION (Simulasi fisika luncur memantul ringan saat objek dilepas cepat)
    spatialObjects.forEach((obj) => {
        if (!obj.userData.isGrabbed) {
            obj.position.add(obj.userData.velocity);
            obj.userData.velocity.multiplyScalar(0.88); // Efek gesekan udara (Air Friction slowing down)
            
            // Batas dinding pemantul spasial ringkas (Soft Bounce)
            if (Math.abs(obj.position.x) > 1.8) obj.userData.velocity.x *= -0.5;
            if (Math.abs(obj.position.y) > 1.1) obj.userData.velocity.y *= -0.5;
        }
    });

    // RENDER SKELETON PREMIUM (visionOS Style Glow Line Hand Layering)
    trackedHands.forEach((hand) => {
        const renderLandmarks = hand.getPredictedLandmarks();

        // 1. Smooth Glow Bone Connections
        drawConnectors(ctx, renderLandmarks, HAND_CONNECTIONS, {
            color: hand.label === "Right" ? "rgba(0, 229, 255, 0.45)" : "rgba(255, 0, 119, 0.45)",
            lineWidth: 3
        });

        // 2. Premium Translucent Joint Points
        drawLandmarks(ctx, renderLandmarks, {
            color: "rgba(255, 255, 255, 0.8)",
            fillColor: hand.label === "Right" ? "#00e5ff" : "#ff0077",
            radius: 3
        });

        // 3. Floating Interactive Ring Cursor on Index Tip
        const cursor = renderLandmarks[POINTER_LANDMARK];
        ctx.beginPath();
        ctx.arc(cursor.x * canvas.width, cursor.y * canvas.height, hand.pinchActive ? 6 : 11, 0, 2 * Math.PI);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = hand.pinchActive ? 3 : 2;
        ctx.shadowBlur = 12;
        ctx.shadowColor = hand.label === "Right" ? "#00e5ff" : "#ff0077";
        ctx.stroke();
        ctx.shadowBlur = 0;
    });

    // Render WebGL Graphics Scene
    renderer3D.render(scene, camera3D);
}

// Jalankan pipeline camera utils standard bawaan mediaPipe yang sudah ada
const hands = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.78, minTrackingConfidence: 0.80 });
hands.onResults(onResults);

const camera = new Camera(video, {
    onFrame: async () => { await hands.send({ image: video }); },
    width: 1280,
    height: 720
});
camera.start();

// Aktifkan visual grafik konstan
requestAnimationFrame(renderLoop);
