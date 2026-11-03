/**
 * Vercel Serverless Function — AI Safety Analysis
 * POST /api/analyze-safety
 * Body: { images: [base64...], disasterType, isVideo?, context? }
 *       or { image: base64, disasterType } (legacy)
 * Returns: { riskLevel, summary, recommendations[], dangerZones[], confidence, source }
 *
 * Backends (priority):
 * 1. Cloudflare Workers AI (if CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID set)
 * 2. Rule-based fallback (always works)
 */

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CF_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

// Rate limiter
const rateLimits = new Map();
function checkRateLimit(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const now = Date.now();
  if (!rateLimits.has(ip)) rateLimits.set(ip, []);
  const entries = rateLimits.get(ip).filter(t => now - t < 60000);
  if (entries.length >= 15) return false;
  entries.push(now);
  rateLimits.set(ip, entries);
  return true;
}

// ── RULE-BASED FALLBACK ───────────────────────────────────────
function ruleBasedAnalysis(disasterType, hasVisualContext) {
  const rules = {
    gempa: {
      riskLevel: 'danger',
      summary: hasVisualContext
        ? 'Berdasarkan rekaman lingkungan, segera ambil posisi Drop-Cover-Hold.'
        : 'Gempa terdeteksi! Segera lindungi diri Anda.',
      recommendations: [
        { action: 'BERHENTI, LINDUNGI, BERPEGANGAN (Drop-Cover-Hold)', location: 'Di bawah meja/kursi kuat terdekat', priority: 1 },
        { action: 'Jauhi jendela kaca, lemari tinggi, lampu gantung', location: 'Pindah ke area terbuka di ruangan', priority: 1 },
        { action: 'Lindungi kepala dengan tangan/bantal/tas', location: 'Posisi Anda sekarang', priority: 2 },
        { action: 'Setelah goncangan berhenti, keluar via jalur evakuasi', location: 'Pintu keluar terdekat', priority: 3 }
      ],
      dangerZones: ['Jendela & kaca', 'Lemari/rak tinggi', 'Lampu gantung', 'Benda tergantung', 'Dengan bata ringan tanpa penguat'],
      confidence: hasVisualContext ? 0.75 : 0.6
    },
    tsunami: {
      riskLevel: 'danger',
      summary: 'PERINGATAN TSUNAMI! Evakuasi MENDARAT ke tempat tinggi!',
      recommendations: [
        { action: 'SEGERA naik ke tempat tinggi (min. 15m dpl / 30m dari pantai)', location: 'Bukit/bangunan tinggi/escalator vertikal', priority: 1 },
        { action: 'Jauhi pantai, sungai, muara, dan area rendah', location: 'Arah内陆/jauh dari air', priority: 1 },
        { action: 'Jalan kaki lebih cepat daripada kendaraan saat panik', location: 'Jalur evakuasi vertikal (naik)', priority: 2 },
        { action: 'Bawa HP + dokumen penting (maks 1 menit persiapan)', location: 'Tas/ransel Anda', priority: 3 }
      ],
      dangerZones: ['Pantai & tepian air', 'Sungai/muara', 'Area depressed/rendah', 'Jembatan dekat perairan'],
      confidence: 0.8
    },
    banjir: {
      riskLevel: 'caution',
      summary: 'Waspada banjir! Pindah ke area yang lebih tinggi.',
      recommendations: [
        { action: 'Naik ke lantai atas atau atap bangunan', location: 'Lantai 2+ / rooftop / bukit', priority: 1 },
        { action: 'Matikan listrik panel utama sebelum air naik', location: 'Panel MCB rumah', priority: 1 },
        { action: 'Jangan warkat/kendarai di genangan (arus bawah berbahaya)', location: 'Hindari jalan tergenang', priority: 2 },
        { action: 'Siapkan: obat, air minum, powerbank, dokumen', location: 'Tas darurat siap bawa', priority: 3 }
      ],
      dangerZones: ['Genangan (arus bawah)', 'Kolam listrik', 'Area rendah', 'Bawah jembatan'],
      confidence: 0.7
    },
    angin: {
      riskLevel: 'caution',
      summary: 'Angin kencang! Cari perlindungan di interior bangunan.',
      recommendations: [
        { action: 'Masuk ke ruangan tanpa jendela (lorong, kamar tengah)', location: 'Interior building / basement', priority: 1 },
        { action: 'Jauhi kaca, pintu glass, papan reklame', location: 'Dinding dalam solid', priority: 1 },
        { action: 'Tunduk rendah, lindungi kepala dengan lengan', location: 'Di bawah meja/bangku kokoh', priority: 2 },
        { action: 'Jika outdoor: berbaring face-down di parit/turunan', location: 'Area rendah terbuka', priority: 3 }
      ],
      dangerZones: ['Kaca & jendela', 'Reklame/spanduk', 'Pohon besar', 'Bangunan reyot', 'Tiang listrik'],
      confidence: 0.7
    },
    umum: {
      riskLevel: 'caution',
      summary: 'Kondisi darurat. Tetap tenang dan cari tempat aman.',
      recommendations: [
        { action: 'Tetap tenang, amati keadaan sekitar', location: 'Posisi Anda', priority: 1 },
        { action: 'Identifikasi jalur keluar terdekat', location: 'Pintu/exit terdekat', priority: 1 },
        { action: 'Lindungi kepala dari benda jatuh', location: 'Di bawah struktur kokoh', priority: 2 },
        { action: 'Ikuti instruksi petugas/BPBD', location: '-', priority: 3 }
      ],
      dangerZones: ['Benda berpotensi jatuh', 'Lantai rusak', 'Kerumunan'],
      confidence: 0.5
    }
  };
  return rules[disasterType] || rules.umum;
}

// ── CLOUDFLARE WORKERS AI VISION ──────────────────────────────
async function cloudflareVision(images, disasterType, context) {
  // Use first image for analysis (Workers AI takes one image per request)
  const imageData = images[0];
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');

  const prompt = `Analisis gambar lingkungan ini untuk persiapan menghadapi bencana ${disasterType.toUpperCase()} di Indonesia.
${images.length > 1 ? `(Ini adalah frame dari video ${images.length} detik — lingkungan sekitar pengguna)` : ''}

Deskripsikan apa yang kamu lihat, lalu berikan rekomendasi berlindung spesifik.

Balas HANYA JSON valid:
{"riskLevel":"safe|caution|danger","summary":"Satu kalimat Bahasa Indonesia berdasarkan objek yang terlihat","recommendations":[{"action":"Apa yang harus dilakukan (spesifik基于objek di gambar)","location":"Di mana persisnya","priority":1}],"dangerZones":["Bahaya spesifik yang terlihat"],"confidence":0.85}

Aturan: Semua teks Bahasa Indonesia. Maks 4 recommendations. Priority 1=paling urgent. Berbasis OBJEK YANG KAMU LIHAT di gambar (jika ada meja → sebutkan "di bawah meja tersebut", jika ada jendela → "jauhi jendela di sebelah ${'kiri/kanan'}").`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${CF_MODEL}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } },
            { type: 'text', text: prompt }
          ]}
        ],
        max_tokens: 1024,
        temperature: 0.3
      }),
      signal: controller.signal
    }
  );

  clearTimeout(timeout);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Cloudflare AI ${resp.status}: ${errText.substring(0, 150)}`);
  }

  const data = await resp.json();
  const text = data.result?.response || data.response || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response: ' + text.substring(0, 100));
  return JSON.parse(jsonMatch[0]);
}

// ── HANDLER ───────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkRateLimit(req)) {
    return res.status(429).json({ error: 'Terlalu banyak permintaan. Tunggu 1 menit.' });
  }

  const { images, image, disasterType, isVideo, context } = req.body || {};

  // Support both old (image) and new (images array) format
  let frames = [];
  if (Array.isArray(images)) frames = images;
  else if (image) frames = [image];

  if (!disasterType) return res.status(400).json({ error: 'disasterType is required' });

  let result;
  let usedAI = false;

  // Try Cloudflare Workers AI if configured
  const hasCF = CF_TOKEN && CF_ACCOUNT;

  if (frames.length > 0 && hasCF) {
    try {
      console.log(`[API] Cloudflare Vision: ${frames.length} frame(s), type=${disasterType}`);
      result = await cloudflareVision(frames, disasterType, context);
      usedAI = true;
      console.log('[API] CF success:', result.riskLevel);
    } catch (err) {
      console.warn('[API] CF failed:', err.message);
    }
  }

  // Fallback: rule-based
  if (!result) {
    result = ruleBasedAnalysis(disasterType, frames.length > 0);
    if (isVideo && frames.length > 1) {
      result.summary = `[Video ${frames.length}s] ` + result.summary;
    }
  }

  // Ensure structure
  if (!result.riskLevel) result.riskLevel = 'caution';
  if (!Array.isArray(result.recommendations)) result.recommendations = [];
  if (!Array.isArray(result.dangerZones)) result.dangerZones = [];
  if (result.confidence == null) result.confidence = 0.5;
  result.source = usedAI ? 'cloudflare-ai' : 'rule-based';
  result.framesAnalyzed = frames.length;

  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(result);
}

export const config = { maxDuration: 35 };
