// ==========================================
// CONFIGURATION & GLOBAL STABILITY PARAMETERS
// ==========================================
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const TRACKING_PERSISTENCE_MS = 800;  // Durasi mempertahankan tracking saat tangan hilang (ms)
const PREDICTION_FACTOR_MS = 40;      // Faktor prediksi gerakan ke depan untuk memotong delay visual (ms)
const POINTER_LANDMARK = 8;           // Indeks Ujung Jari (Index Finger Tip) untuk presisi pointer
const WRIST_LANDMARK = 0;             // Titik Jangkar Utama (Wrist)

let trackedHands = [];
let lastTimestamp = performance.now();

// ==========================================
// PROFESSIONAL TRACKING CORE: HAND CLASS
// ==========================================
class TrackedHand {
    constructor(landmarks, handedness) {
        this.id = Math.random().toString(36).substring(2, 9);
        this.label = handedness.label; // "Left" atau "Right"
        this.confidence = handedness.score;
        this.lastSeen = performance.now();

        // Alokasi memori koordinat & kecepatan
        this.smoothedLandmarks = landmarks.map(p => ({ x: p.x, y: p.y, z: p.z }));
        this.velocities = landmarks.map(() => ({ x: 0, y: 0, z: 0 }));

        // Buffer untuk kestabilan gesture debouncing
        this.gestureActive = false;
        this.gestureFramesTracked = 0;
    }

    /**
     * Memperbarui posisi landmark menggunakan Adaptive Smooth EMA, Deadzone, dan Velocity Calculation
     */
    update(newLandmarks, handedness, dt) {
        this.lastSeen = performance.now();
        
        // Mempertahankan stabilitas identitas label tangan kiri/kanan melalui seleksi confidence tinggi
        if (handedness.score > 0.85) {
            this.label = handedness.label;
        }

        const MIN_ALPHA = 0.06;   // Reduksi getaran maksimal saat tangan diam statis
        const MAX_ALPHA = 0.80;   // Kecepatan respon instan tanpa delay saat gerakan eksplosif
        const DEADZONE = 0.0007;  // Mengabaikan noise getaran sub-piksel kamera mikro

        for (let i = 0; i < 21; i++) {
            const current = newLandmarks[i];
            const prevSmooth = this.smoothedLandmarks[i];

            const dx = current.x - prevSmooth.x;
            const dy = current.y - prevSmooth.y;
            const dz = current.z - prevSmooth.z;
            const distance = Math.sqrt(dx * dx + dy * dy);

            // Anti-Jitter Deadzone System
            if (distance < DEADZONE) {
                this.velocities[i] = { x: 0, y: 0, z: 0 };
                continue;
            }

            // Hitung kecepatan instan (Unit per detik)
            const instVx = dt > 0 ? dx / dt : 0;
            const instVy = dt > 0 ? dy / dt : 0;
            const instVz = dt > 0 ? dz / dt : 0;

            // Perhalus kecepatan menggunakan EMA Filter
            this.velocities[i].x = this.velocities[i].x * 0.4 + instVx * 0.6;
            this.velocities[i].y = this.velocities[i].y * 0.4 + instVy * 0.6;
            this.velocities[i].z = this.velocities[i].z * 0.4 + instVz * 0.6;

            // Hitung magnitudo kecepatan untuk mengatur nilai Alpha secara Adaptif
            const currentSpeed = Math.sqrt(this.velocities[i].x * this.velocities[i].x + this.velocities[i].y * this.velocities[i].y);
            const speedNormalized = Math.min(currentSpeed / 2.2, 1.0); // Normalisasi batas kecepatan atas
            
            let adaptiveAlpha = MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * speedNormalized;

            // Optimalisasi ekstra presisi tinggi khusus untuk Pointer Utama (Index Tip)
            if (i === POINTER_LANDMARK) {
                adaptiveAlpha = Math.min(adaptiveAlpha * 1.25, 0.90);
            }

            // Terapkan integrasi smoothing akhir
            this.smoothedLandmarks[i].x += adaptiveAlpha * dx;
            this.smoothedLandmarks[i].y += adaptiveAlpha * dy;
            this.smoothedLandmarks[i].z += adaptiveAlpha * dz;
        }
    }

    /**
     * Occlusion Recovery: Memproyeksikan posisi koordinat menggunakan sisa inersia kecepatan saat sensor tertutup
     */
    extrapolate(dt) {
        const inertiaFriction = 0.90; // Reduksi gerak bertahap agar tidak melompat liar
        for (let i = 0; i < 21; i++) {
            this.velocities[i].x *= inertiaFriction;
            this.velocities[i].y *= inertiaFriction;
            this.velocities[i].z *= inertiaFriction;

            this.smoothedLandmarks[i].x += this.velocities[i].x * dt;
            this.smoothedLandmarks[i].y += this.velocities[i].y * dt;
            this.smoothedLandmarks[i].z += this.velocities[i].z * dt;
        }
    }

    /**
     * Motion Prediction System: Menghitung antisipasi posisi koordinat ke depan demi mengunci visual objek
     */
    getPredictedLandmarks() {
        const timeFactor = PREDICTION_FACTOR_MS / 1000;
        return this.smoothedLandmarks.map((p, i) => ({
            x: p.x + this.velocities[i].x * timeFactor,
            y: p.y + this.velocities[i].y * timeFactor,
            z: p.z + this.velocities[i].z * timeFactor
        }));
    }
}

// ==========================================
// CAMERA INITIALIZATION & MEDIAPIPE PIPELINE
// ==========================================
async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, frameRate: { ideal: 60 } }
    });
    video.srcObject = stream;
}
startCamera();

const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});

hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.75, // Ditinggikan untuk mencegah salah deteksi noise background
    minTrackingConfidence: 0.75
});

hands.onResults(onResults);

const camera = new Camera(video, {
    onFrame: async () => {
        await hands.send({ image: video });
    },
    width: 1280,
    height: 720
});
camera.start();

// ==========================================
// DATA ACQUISITION & ANTI-SWAP IDENTITY MATCHING
// ==========================================
function onResults(results) {
    const now = performance.now();
    const dt = (now - lastTimestamp) / 1000;
    lastTimestamp = now;

    // Memastikan canvas sinkron dengan dimensi frame video asli
    if (video.videoWidth && video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }

    let currentDetections = [];
    if (results.multiHandLandmarks && results.multiHandedness) {
        for (let i = 0; i < results.multiHandLandmarks.length; i++) {
            currentDetections.push({
                landmarks: results.multiHandLandmarks[i],
                info: results.multiHandedness[i]
            });
        }
    }

    let nextTrackedHands = [];

    // Nearest Neighbor & Spatial Continuity Matching
    currentDetections.forEach((det) => {
        let matchedIndex = -1;
        let closestDistance = 0.22; // Threshold maksimal jarak pergeseran per frame (Normalized)

        for (let j = 0; j < trackedHands.length; j++) {
            const th = trackedHands[j];
            
            // Validasi berbasis jarak Euclidean pada titik Wrist Anchor
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
            // Perbarui data historis objek tracking yang cocok
            const handInstance = trackedHands[matchedIndex];
            handInstance.update(det.landmarks, det.info, dt);
            nextTrackedHands.push(handInstance);
            trackedHands.splice(matchedIndex, 1); // Buang dari pool antrean agar tidak double-match
        } else {
            // Daftarkan tangan baru jika tidak ditemukan kecocokan historis terdekat
            const newHand = new TrackedHand(det.landmarks, det.info);
            nextTrackedHands.push(newHand);
        }
    });

    // Tracking Persistence Engine: Pertahankan objek jika hilang sesaat (akibat occlusion)
    trackedHands.forEach((th) => {
        if (now - th.lastSeen < TRACKING_PERSISTENCE_MS) {
            th.extrapolate(dt);
            nextTrackedHands.push(th);
        }
    });

    trackedHands = nextTrackedHands;
}

// ==========================================
// HIGH PERFORMANCE 60 FPS DECOUPLED RENDERING LOOP
// ==========================================
function renderLoop() {
    requestAnimationFrame(renderLoop);

    // Bersihkan layar canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (trackedHands.length === 0) return;

    trackedHands.forEach((hand) => {
        // Ambil data posisi yang sudah dikompensasi latency menggunakan algoritma prediksi
        const renderLandmarks = hand.getPredictedLandmarks();

        // 1. Gambar Connectors (Skeleton Tulang)
        drawConnectors(ctx, renderLandmarks, HAND_CONNECTIONS, {
            color: hand.label === "Right" ? "#00FF88" : "#FF0077", // Pembeda warna visual tegas kiri vs kanan
            lineWidth: 3.5
        });

        // 2. Gambar Joint Dots (Titik Landmark)
        drawLandmarks(ctx, renderLandmarks, {
            color: "#00E5FF",
            fillColor: "#FFFFFF",
            radius: 4
        });

        // 3. Apple Vision Pro Style: Render UI Pointer Stabilizer Ring di Ujung Jari Telunjuk
        const indexTip = renderLandmarks[POINTER_LANDMARK];
        ctx.beginPath();
        ctx.arc(indexTip.x * canvas.width, indexTip.y * canvas.height, 9, 0, 2 * Math.PI);
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2.5;
        ctx.shadowBlur = 8;
        ctx.shadowColor = "#00FFFF";
        ctx.stroke();
        ctx.shadowBlur = 0; // Reset efek bayangan shadow
    });
}

// Jalankan loop visual konstan secara asinkronus mendahului AI thread
requestAnimationFrame(renderLoop);
