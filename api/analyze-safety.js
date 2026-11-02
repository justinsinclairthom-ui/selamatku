/**
 * Vercel Serverless Function — AI Safety Analysis
 * POST /api/analyze-safety
 * Body: { image: base64String, disasterType: string, context?: string }
 * Returns: { riskLevel, summary, recommendations[], dangerZones[], confidence }
 *
 * Strategy:
 * 1. Try DashScope Qwen-VL (if DASHSCOPE_API_KEY set with sk-... format)
 * 2. Fallback: Rule-based analysis (always works, no API key needed)
 */

const API_KEY = process.env.DASHSCOPE_API_KEY || '';
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'qwen-vl-max';

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

// ── RULE-BASED FALLBACK (always works) ────────────────────────
function ruleBasedAnalysis(disasterType) {
  const rules = {
    gempa: {
      riskLevel: 'danger',
      summary: 'Gempa terdeteksi! Segera lindungi diri Anda.',
      recommendations: [
        { action: 'BERHENTI, LINDUNGI, BERPEGANGAN (Drop-Cover-Hold)', location: 'Di bawah meja/kursi kuat di dekat Anda', priority: 1 },
        { action: 'Jauhi jendela, lemari tinggi, dan lampu gantung', location: 'Pindah ke area terbuka di ruangan', priority: 1 },
        { action: 'Lindungi kepala dengan tangan/bantal', location: 'Posisi Anda sekarang', priority: 2 },
        { action: 'Setelah goncangan berhenti, keluar melalui jalur evakuasi', location: 'Pintu keluar terdekat', priority: 3 }
      ],
      dangerZones: ['Jendela kaca', 'Lemari/gudang tinggi', 'Lampu gantung', 'Rak buku', 'Benda berat yang tergantung'],
      confidence: 0.7
    },
    tsunami: {
      riskLevel: 'danger',
      summary: 'PERINGATAN TSUNAMI! Evakuasi segera ke tempat tinggi!',
      recommendations: [
        { action: 'SEGERA pergi ke tempat tinggi (min. 15m dpl atau 30m dari pantai)', location: 'Bukit/bangunan tinggi terdekat', priority: 1 },
        { action: 'Jauhi pantai, sungai, dan muara', location: 'Arah内陆/jauh dari air', priority: 1 },
        { action: 'Jangan gunakan kendaraan jika macet — jalan kaki lebih cepat', location: 'Jalur evakuasi vertikal', priority: 2 },
        { action: 'Bawa dokumen penting & HP jika sempat (maks 1 menit)', location: 'Tas/ransel Anda', priority: 3 }
      ],
      dangerZones: ['Pantai & tepian air', 'Sungai & muara', 'Area rendah/depressed', 'Jembatan dekat air'],
      confidence: 0.8
    },
    banjir: {
      riskLevel: 'caution',
      summary: 'Waspada banjir! Cari tempat yang lebih tinggi.',
      recommendations: [
        { action: 'Pindah ke lantai atas atau tempat tinggi', location: 'Lantai 2+ / atap / bukit', priority: 1 },
        { action: 'Matikan listrik di panel utama jika air sudah masuk', location: 'Panel listrik rumah', priority: 1 },
        { action: 'Jangan berjalan/mengendarai melewati genangan air', location: 'Hindari jalan tergenang', priority: 2 },
        { action: 'Siapkan tas darurat: obat, air, dokumen, powerbank', location: 'Tempat mudah dijangkau', priority: 3 }
      ],
      dangerZones: ['Genangan air (potensi arus bawah)', 'Kolam listrik/pascn', 'Area rendah', 'Bawah jembatan'],
      confidence: 0.7
    },
    angin: {
      riskLevel: 'caution',
      summary: 'Angin kencang! Cari perlindungan interior.',
      recommendations: [
        { action: 'Masuk ke ruangan interior (tanpa jendela)', location: 'Ruangan tengah bangunan / lorong', priority: 1 },
        { action: 'Jauhi jendela, pintu kaca, dan area dengan reklame', location: 'Dinding dalam tanpa kaca', priority: 1 },
        { action: 'Tunduk rendah, lindungi kepala', location: 'Di bawah meja/bangku kokoh', priority: 2 },
        { action: 'Jika outdoor dan tidak ada bangunan, berbaring face-down di parit/turunan', location: 'Area rendah terbuka', priority: 3 }
      ],
      dangerZones: ['Jendela & kaca', 'Papan reklame/spanduk', 'Pohon besar', 'Bangunan reyot', 'Tiang listrik'],
      confidence: 0.7
    },
    umum: {
      riskLevel: 'caution',
      summary: 'Kondisi darurat terdeteksi. Tetap tenang dan cari tempat aman.',
      recommendations: [
        { action: 'Tetap tenang, amati lingkungan sekitar', location: 'Posisi Anda sekarang', priority: 1 },
        { action: 'Cari jalur keluar terdekat yang aman', location: 'Pintu keluar / exit', priority: 1 },
        { action: 'Lindungi kepala dari benda jatuh', location: 'Di bawah meja/benda kokoh', priority: 2 },
        { action: 'Ikuti instruksi petugas darurat', location: '-', priority: 3 }
      ],
      dangerZones: ['Benda yang bisa jatuh', 'Jalan rusak', 'Area kerumunan'],
      confidence: 0.5
    }
  };

  return rules[disasterType] || rules.umum;
}

// ── AI ANALYSIS (if valid API key) ────────────────────────────
async function aiAnalysis(imageDataUrl, disasterType, context) {
  const systemPrompt = `Kamu adalah analis keselamatan darurat Indonesia. Analisis gambar dan berikan rekomendasi berlindung untuk bencana: ${disasterType.toUpperCase()}.
Balas HANYA JSON valid: {"riskLevel":"safe|caution|danger","summary":"...Bahasa Indonesia...","recommendations":[{"action":"...","location":"...","priority":1}],"dangerZones":["..."],"confidence":0.8}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  const resp = await fetch(DASHSCOPE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text: `Analisis lingkungan ini untuk bencana ${disasterType}. Berikan rekomendasi spesifik berdasarkan apa yang terlihat di gambar.${context ? ' Konteks: ' + context : ''}` }
        ]}
      ]
    }),
    signal: controller.signal
  });

  clearTimeout(timeout);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${errText.substring(0, 100)}`);
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Invalid AI response');
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

  const { image, disasterType, context } = req.body || {};
  if (!disasterType) return res.status(400).json({ error: 'disasterType is required' });

  let result;
  let usedAI = false;

  // Try AI first if we have a valid-looking key (sk-... for DashScope)
  const hasValidKey = API_KEY.startsWith('sk-');

  if (image && hasValidKey) {
    try {
      let imageDataUrl = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
      console.log('[API] Trying AI analysis with DashScope...');
      result = await aiAnalysis(imageDataUrl, disasterType, context);
      usedAI = true;
      console.log('[API] AI analysis successful');
    } catch (err) {
      console.warn('[API] AI failed, falling back to rules:', err.message);
    }
  }

  // Fallback: rule-based (always works)
  if (!result) {
    result = ruleBasedAnalysis(disasterType);
    if (!usedAI) {
      result.summary = '[Mode Offline] ' + result.summary;
      result.confidence = Math.min(result.confidence, 0.6);
    }
  }

  // Ensure structure
  if (!result.riskLevel) result.riskLevel = 'caution';
  if (!Array.isArray(result.recommendations)) result.recommendations = [];
  if (!Array.isArray(result.dangerZones)) result.dangerZones = [];
  if (result.confidence == null) result.confidence = 0.5;
  result.source = usedAI ? 'ai' : 'rule-based';

  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(result);
}

export const config = { maxDuration: 30 };
