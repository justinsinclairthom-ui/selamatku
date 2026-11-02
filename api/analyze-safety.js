/**
 * Vercel Serverless Function — AI Safety Analysis
 * POST /api/analyze-safety
 * Body: { image: base64String, disasterType: string, context?: string }
 * Returns: { riskLevel, summary, recommendations[], dangerZones[], confidence }
 *
 * Uses DashScope (ModelScope/Alibaba) Qwen-VL via OpenAI-compatible API
 * Env: DASHSCOPE_API_KEY (get from modelscope.cn → Profile → Access Token)
 */

const API_KEY = process.env.DASHSCOPE_API_KEY || process.env.ANTHROPIC_API_KEY;
const API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'qwen-vl-max';

// Simple in-memory rate limiter
const rateLimits = new Map();
const RATE_LIMIT = 15; // requests per minute
const WINDOW_MS = 60000;

function checkRateLimit(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const now = Date.now();
  if (!rateLimits.has(ip)) rateLimits.set(ip, []);
  const entries = rateLimits.get(ip).filter(t => now - t < WINDOW_MS);
  if (entries.length >= RATE_LIMIT) return false;
  entries.push(now);
  rateLimits.set(ip, entries);
  return true;
}

const SYSTEM_PROMPT = `Kamu adalah analis keselamatan darurat spesialis bencana alam Indonesia. Analisis gambar dari kamera pengguna dan berikan rekomendasi berlindung yang spesifik dan actionable.

Balas HANYA dalam format JSON valid (tanpa markdown, tanpa code fence) dengan struktur persis:
{
  "riskLevel": "safe" | "caution" | "danger",
  "summary": "Satu kalimat Bahasa Indonesia tentang kondisi keselamatan",
  "recommendations": [
    { "action": "Apa yang harus dilakukan (Bahasa Indonesia)", "location": "Di mana (Bahasa Indonesia)", "priority": 1 },
    { "action": "...", "location": "...", "priority": 2 }
  ],
  "dangerZones": ["Deskripsi bahaya terlihat di gambar (Bahasa Indonesia)"],
  "confidence": 0.85
}

Aturan:
- SEMUA teks user-facing WAJIB Bahasa Indonesia
- Priority 1 = tindakan SEGERA, 2 = penting, 3 = baik diketahui
- Maksimum 4 rekomendasi, urutkan by priority
- confidence: 0.0-1.0 (rendah jika gambar gelap/blur)

Panduan per jenis bencana:
- GEMPA: Drop-Cover-Hold. Jauhi jendela, lemari tinggi, lampu gantung. Cari meja/tiang kuat. Outdoor: jauhi bangunan, tiang listrik, pohon.
- TSUNAMI: Ke tempat tinggi (min 30m dari pantai atau 15m dpl). Jauhi sungai/muara/pantai. Ikuti jalur evakuasi.
- BANJIR: Ke lantai atas/tempat tinggi. Jauhi listrik/genangan. Jangan jalan di air mengalir.
- ANGIN KENCANG: Ruangan interior tanpa jendela. Jauhi kaca/reklame/pohon. Berbaring rendah jika perlu.
- UMUM: Jauhi puing/debu. Gunakan jalur keluar terdekat. Lindungi kepala.`;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit
  if (!checkRateLimit(req)) {
    return res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi dalam 1 menit.' });
  }

  // Validate input
  const { image, disasterType, context } = req.body || {};
  if (!image) return res.status(400).json({ error: 'Image is required' });
  if (!disasterType) return res.status(400).json({ error: 'disasterType is required' });

  if (!API_KEY) {
    return res.status(500).json({ error: 'Server belum dikonfigurasi. Set DASHSCOPE_API_KEY di Vercel environment variables.' });
  }

  try {
    // Parse base64 image — support both raw base64 and data URL
    let imageDataUrl = image;
    if (!image.startsWith('data:')) {
      imageDataUrl = `data:image/jpeg;base64,${image}`;
    }

    const requestBody = {
      model: MODEL,
      max_tokens: 1024,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: imageDataUrl }
            },
            {
              type: 'text',
              text: `Analisis gambar ini. Jenis bencana saat ini: ${disasterType.toUpperCase()}.${context ? ' Konteks: ' + context : ''}\n\nBerikan rekomendasi berlindung berdasarkan apa yang kamu lihat.`
            }
          ]
        }
      ]
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);

    const apiRes = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!apiRes.ok) {
      const errBody = await apiRes.text().catch(() => '');
      console.error('DashScope API error:', apiRes.status, errBody.substring(0, 500));

      // Try to extract useful error message
      let errMsg = 'AI service sedang tidak tersedia. Coba lagi.';
      try {
        const parsed = JSON.parse(errBody);
        if (parsed.error?.message) errMsg = parsed.error.message;
        else if (parsed.message) errMsg = parsed.message;
      } catch(e) {}

      if (apiRes.status === 401) errMsg = 'API key tidak valid. Periksa konfigurasi server.';
      if (apiRes.status === 429) errMsg = 'Limit API tercapai. Tunggu sebentar lalu coba lagi.';

      return res.status(502).json({ error: errMsg });
    }

    const data = await apiRes.json();
    const text = data.choices?.[0]?.message?.content || '';

    console.log('[AI Response]', text.substring(0, 200));

    // Parse JSON from response
    let result;
    try {
      // Handle potential markdown wrapping or extra text
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch (e) {
      console.warn('JSON parse failed, using fallback');
      result = {
        riskLevel: 'caution',
        summary: text.substring(0, 200) || 'Analisis tidak dapat diproses. Ikuti instruksi petugas.',
        recommendations: [
          { action: 'Tetap tenang dan cari tempat aman terdekat', location: 'Lokasi Anda sekarang', priority: 1 },
          { action: 'Lindungi kepala dengan benda di sekitar', location: '-', priority: 2 },
          { action: 'Ikuti instruksi petugas darurat', location: '-', priority: 3 }
        ],
        dangerZones: [],
        confidence: 0.3
      };
    }

    // Ensure required fields exist
    if (!result.riskLevel) result.riskLevel = 'caution';
    if (!Array.isArray(result.recommendations)) result.recommendations = [];
    if (!Array.isArray(result.dangerZones)) result.dangerZones = [];
    if (result.confidence == null) result.confidence = 0.5;

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(result);

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Analisis melebihi waktu (35 detik). Coba lagi.' });
    }
    console.error('Handler error:', err.message);
    res.status(500).json({ error: 'Terjadi kesalahan server. Coba lagi.' });
  }
}

export const config = { maxDuration: 40 };
