/**
 * Vercel Serverless Function — AI Safety Analysis
 * POST /api/analyze-safety
 * Body: { image: base64String, disasterType: string, context?: string }
 * Returns: { riskLevel, summary, recommendations[], dangerZones[], confidence }
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5-5';

// Simple in-memory rate limiter (per deployment instance)
const rateLimits = new Map();
const RATE_LIMIT = 10; // requests per minute
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

const SYSTEM_PROMPT = `You are an emergency safety analyst specializing in Indonesian disaster response. Analyze the camera image of the user's immediate surroundings during a disaster event and provide specific, actionable shelter recommendations.

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{
  "riskLevel": "safe" | "caution" | "danger",
  "summary": "Satu kalimat dalam Bahasa Indonesia menggambarkan kondisi keselamatan keseluruhan",
  "recommendations": [
    { "action": "Apa yang harus dilakukan (Bahasa Indonesia)", "location": "Di mana (Bahasa Indonesia)", "priority": 1 },
    { "action": "...", "location": "...", "priority": 2 }
  ],
  "dangerZones": ["Deskripsi bahaya yang terlihat di gambar (Bahasa Indonesia)"],
  "confidence": 0.85
}

Rules:
- ALL user-facing text MUST be in Bahasa Indonesia
- Priority 1 = tindakan segera (sekarang!), 2 = penting, 3 = baik diketahui
- Maximum 4 recommendations, sorted by priority
- confidence: 0.0-1.0 (lower if image is dark, blurry, or unclear)

Disaster-specific guidance:
- GEMPA (earthquake): Drop-Cover-Hold. Jauhi jendela, lemari tinggi, lampu gantung. Cari meja kuat, tiang承重. Jika outdoor: jauhi bangunan, tiang listrik, pohon besar.
- TSUNAMI: Segera ke tempat tinggi (minimal 30m dari pantai atau 15m dpl). Jauhi sungai, muara, pantai. Ikuti jalur evakuasi vertikal.
- BANJIR (flood): Ke lantai atas/tempat tinggi. Jauhi sumber listrik, genangan. Jangan berjalan di air mengalir.
- ANGIN KENCANG / BAHAN (storm/wind): Ruangan interior tanpa jendela. Jauhi kaca, papan reklame, pohon besar. Berbaring rendah jika tidak ada perlindungan.
- UMUM (general): Jauhi area terbuka jika ada puing. Gunakan jalur keluar terdekat. Lindungi kepala.`;

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

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured. ANTHROPIC_API_KEY missing.' });
  }

  try {
    // Parse base64 image
    const imageBase64 = image.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = image.match(/^data:(image\/\w+);/)?.[1] || 'image/jpeg';

    const requestBody = {
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageBase64 }
          },
          {
            type: 'text',
            text: `Analisis gambar ini. Jenis bencana saat ini: ${disasterType.toUpperCase()}.${context ? ' Konteks tambahan: ' + context : ''}\n\nBerikan rekomendasi berlindung yang spesifik berdasarkan apa yang kamu lihat di gambar.`
          }
        ]
      }]
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const apiRes = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      console.error('Anthropic API error:', apiRes.status, errBody);
      return res.status(502).json({ error: 'AI service temporarily unavailable. Try again.' });
    }

    const data = await apiRes.json();
    const text = data.content?.[0]?.text || '';

    // Parse JSON from response (handle potential markdown wrapping)
    let result;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch (e) {
      // Fallback: return raw text as summary
      result = {
        riskLevel: 'caution',
        summary: text.substring(0, 200),
        recommendations: [{ action: 'Ikuti instruksi petugas darurat', location: 'Lokasi Anda sekarang', priority: 1 }],
        dangerZones: [],
        confidence: 0.3
      };
    }

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(result);

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Analisis melebihi waktu. Coba lagi.' });
    }
    console.error('Handler error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan. Coba lagi.' });
  }
}

export const config = { maxDuration: 35 };
