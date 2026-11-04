"""
SelamatKu — Disaster Detection & Evacuation App
Entry point for ModelScope Studio deployment.

Serves the static PWA (index.html + app.js + style.css) via Gradio gr.HTML().
Also exposes /api/analyze-safety endpoint for the AI safety scanner.
"""

import os
import json
import base64
import urllib.request
import urllib.error
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import gradio as gr

# ── Paths ──────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def _read_file(filename: str, default: str = "") -> str:
    path = os.path.join(BASE_DIR, filename)
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    return default


# ── Load assets at import time ─────────────────────────────────
HTML_TEMPLATE = _read_file("index.html")
CSS_CONTENT   = _read_file("style.css")
JS_CONTENT    = _read_file("app.js")


def build_embedded_html() -> str:
    """Inject CSS and JS inline into the HTML template so everything is self-contained."""
    html = HTML_TEMPLATE

    # Replace <link rel="stylesheet" href="style.css?v=5" /> with inline <style>
    css_tag = f"<style>\n{CSS_CONTENT}\n</style>"
    html = html.replace(
        '<link rel="stylesheet" href="style.css?v=5" />',
        css_tag
    )

    # Replace <script src="app.js?v=3"></script> with inline <script>
    js_tag = f"<script>\n{JS_CONTENT}\n</script>"
    html = html.replace(
        '<script src="app.js?v=3"></script>',
        js_tag
    )

    # Fix icon paths (icons are in root, not icons/ subdir)
    html = html.replace('href="icons/icon-192.png"', 'href="icon-192.png"')
    html = html.replace('href="icons/maskable-192.png"', 'href="maskable-192.png"')

    return html


EMBEDDED_HTML = build_embedded_html() if HTML_TEMPLATE else """
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>SelamatKu</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f4f6fb; color: #1a1d2e; }
    .container { max-width: 480px; margin: 40px auto; padding: 24px; text-align: center; }
    h1 { font-size: 2rem; margin-bottom: 8px; }
    .badge { display: inline-block; background: #4f46e5; color: #fff; padding: 4px 12px; border-radius: 20px; font-size: .8rem; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🛡️ SelamatKu</h1>
    <p>Aplikasi Deteksi &amp; Evakuasi Bencana</p>
    <p style="color:#666;font-size:.9rem;margin-top:16px">
      File index.html tidak ditemukan.<br/>
      Pastikan semua file deploy ke root folder.
    </p>
    <span class="badge">ModelScope Deployment</span>
  </div>
</body>
</html>
"""


# ── Rule-based analysis (same logic as analyze-safety.js) ─────
def rule_based_analysis(disaster_type: str, has_visual_context: bool, context: str) -> dict:
    loc = context.replace("Lokasi: ", "") if context else ""
    is_video = has_visual_context

    rules = {
        "gempa": {
            "riskLevel": "danger",
            "summary": (f"Dari rekaman lingkungan Anda ({loc}): identifikasi struktur terlindung terdekat dan ambil posisi Drop-Cover-Hold SEKARANG."
                        if is_video else
                        f"Gempa aktif{' di area ' + loc if loc else ''}. Ambil posisi melindungi diri segera."),
            "recommendations": [
                {"action": "DROP: Turunkan tubuh ke posisi merangkak/berlutut — JANGAN berdiri", "location": "Tanpa bergerak dari posisi Anda", "priority": 1},
                {"action": "COVER: Selipkan diri di bawah meja/kursi terkuat yang Anda lihat di depan/samping Anda. Pegang kaki meja erat-erat", "location": "Meja/kursi terdekat (radius 1-2m dari Anda)", "priority": 1},
                {"action": "JAUHI: Pindah minimal 2m menjauh dari jendela kaca, lemari >1.5m, lampu gantung, rak buku", "location": "Ke area dinding dalam (tanpa jendela) atau kolom beton", "priority": 1},
                {"action": "HOLD: Berpegangan pada struktur sampai goncangan berhenti total (bisa 30-90 detik). Jangan keluar selama masih bergoncang", "location": "Posisi berlindung Anda", "priority": 2},
                {"action": "SETELAH AMAN: Matikan gas/listrik jika bisa, keluar via tangga (JANGAN lift), kumpul di area terbuka 50m dari bangunan", "location": "Titik kumpul: lapangan/ruang terbuka terdekat", "priority": 3},
            ],
            "dangerZones": [
                "Jendela & partisi kaca — risiko pecah & potong",
                "Lemari/rak >1.5m — risiko roboh menimpa",
                "Lampu gantung & plafon — risiko jatuh",
                "D bata ringan/plafon gypsum — risiko runtuh",
                "Kolom/struktur retak — indikasi kerusakan",
            ],
            "nearestSafety": (f"Cari titik kumpul/open space terdekat dari {loc}. Dalam radius 50km: lapangan olahraga, alun-alun, parkiran luas tanpa gedung di sekeliling."
                              if loc else "Area terbuka minimal 50m dari bangunan tertinggi di sekitar Anda."),
            "confidence": 0.75 if is_video else 0.6,
        },
        "tsunami": {
            "riskLevel": "danger",
            "summary": f"ALERT TSUNAMI{' — posisi Anda: ' + loc if loc else ''}. Waktu evakuasi: 15-30 menit. Bergerak SEKARANG.",
            "recommendations": [
                {"action": "NAIK: Langsung menuju tempat dengan elevasi >15m dari permukaan laut ATAU jarak >30m horizontal dari pantai. Jika di gedung: naik ke lantai tertinggi", "location": "Bukit/bangunan tinggi/gedung bertingkat TERDEKAT dari posisi Anda", "priority": 1},
                {"action": "JARAK: Jauhi SEMUA area air — pantai, sungai, muara, drainase besar. Air bisa datang dari arah mana saja", "location": "Arah JAUH dari garis pantai/sungai (vertical evacuation preferred)", "priority": 1},
                {"action": "CEPAT: Jalan kaki > kendaraan (lalu lintas pasti macet/panik). Ikuti tanda panah evakuasi tsunami jika ada", "location": "Jalur evakuasi vertikal terdekat (biasanya ke atas/bukit)", "priority": 2},
                {"action": "MINIMAL: Bawa hanya HP + dompet. Jangan buang waktu mengumpulkan barang. Maks 60 detik persiapan", "location": "Ambil dari saku/meja dekat Anda", "priority": 3},
            ],
            "dangerZones": [
                "Garis pantai & area <30m dari air",
                "Sungai, muara, kanal (air naik dari hulu)",
                "Area cekungan/rendah (banjir bandang)",
                "Jembatan & jalan dekat air (runtuh/dibawa arus)",
                "Batu karang/tebing pantai (slump saat gelombang)",
            ],
            "nearestSafety": (f"Dari {loc}, cari: (1) Bukit/gunung terdekat, (2) Gedung >5 lantai, (3) Tangga evakuasi tsunami. Radius 50km: identifikasi elevated road atau perbukitan."
                              if loc else "Tempat tinggi terdekat: bukit, gedung tinggi (>5 lantai), atau tangga evakuasi bertanda."),
            "confidence": 0.8,
        },
        "banjir": {
            "riskLevel": "caution",
            "summary": f"Potensi banjir{' di area ' + loc if loc else ''}. Ketinggian air bisa naik 30-60cm/jam. Naik sekarang sebelum terlambat.",
            "recommendations": [
                {"action": "NAIK: Pindah ke lantai 2+ atau atap. Jika di ruko: stok barang di lantai atas dulu (10 menit)", "location": "Lantai atas bangunan Anda / tangga ke rooftop", "priority": 1},
                {"action": "MATIKAN: Cabut semua stopkontak, matikan MCB utama. Listrik + air = kematian", "location": "Panel listrik (biasanya di dekat pintu masuk/lantai 1)", "priority": 1},
                {"action": "HINDARI: JANGAN lewat genangan >30cm. Arus 15cm sudah bisa membalik motor, 30cm membalik mobil", "location": "Semua jalan/area tergenang — cari rute kering", "priority": 2},
                {"action": "SIAPKAN: Tas berisi obat, air mineral x2, powerbank, dokumen foto di HP, senter", "location": "Letakkan di samping pintu keluar lantai atas", "priority": 3},
            ],
            "dangerZones": [
                "Genangan >15cm — arus bawah tidak terlihat",
                "Kolam listrik, trafo, kabel putus",
                "Balkon/terras lantai 1 (air langsung masuk)",
                "Bawah jembatan (air terkonsentrasi)",
                "Area tanah urugan (longsor saat jenuh)",
            ],
            "nearestSafety": (f"Dari {loc}: cari bangunan >2 lantai dalam radius 200m. Alternatif 50km: area perbukitan atau gedung perkantoran tinggi."
                              if loc else "Bangunan bertingkat terdekat (minimal 2 lantai) atau area elevated."),
            "confidence": 0.7,
        },
        "angin": {
            "riskLevel": "caution",
            "summary": f"Angin kencang/badai{' di ' + loc if loc else ''}. Risiko: benda terbang, kaca pecah, pohon tumbang. Masuk ke interior sekarang.",
            "recommendations": [
                {"action": "MASUK: Langsung ke ruangan paling dalam (tanpa jendela/pintu kaca). Lorong, kamar mandi, atau ruang tanpa kaca", "location": "Ruangan interior terdalam dari sisi angin", "priority": 1},
                {"action": "TURUNKAN: Tutup semua jendela/pintu. Tarik tirai tebal sebagai lapisan tambahan anti pecah", "location": "Semua jendela yang masih terbuka", "priority": 1},
                {"action": "RENDAH: Jika tidak bisa ke interior: berbaring prone (face down) di parit/turunan, lindungi kepala dengan lengan + tas", "location": "Area rendah terlindung dari arah angin", "priority": 2},
                {"action": "JAUHI: Pohon besar, tiang listrik, reklame, spanduk, bangunan seng/prefab — semua bisa jadi peluru", "location": "Minimal 10m dari objek tersebut", "priority": 3},
            ],
            "dangerZones": [
                "Jendela & kaca (pecah → pecahan proyektil)",
                "Papan reklame & spanduk (terbang)",
                "Pohon besar (cabang patah/tumbang)",
                "Atap seng/prefab (terangkat)",
                "Tiang listrik & kabel (jatuh → listrik)",
            ],
            "nearestSafety": (f"Dari {loc}: basement, bunker, atau ruangan interior gedung terdekat. Outdoor: parit/median jalan sebagai shelter sementara."
                              if loc else "Interior bangunan tanpa kaca, atau area terlindung (di balik tembok beton)."),
            "confidence": 0.7,
        },
        "umum": {
            "riskLevel": "caution",
            "summary": f"Kondisi darurat terdeteksi{' di ' + loc if loc else ''}. Tetap tenang, amati, dan bergerak ke tempat aman.",
            "recommendations": [
                {"action": "AMATI: 5 detik — lihat ke segala arah. Identifikasi: apa bahayanya? Dari arah mana? Ada jalur keluar?", "location": "Posisi Anda sekarang", "priority": 1},
                {"action": "GERAK: Arahkan diri ke pintu keluar/exit TERDEKAT. Jauhi sumber bahaya (jarak >5m)", "location": "Jalur keluar terdekat (bukan lift)", "priority": 1},
                {"action": "LINDUNGI: Kepala selalu dilindungi (tangan, tas, benda keras di atas kepala)", "location": "Selama bergerak", "priority": 2},
                {"action": "KUMPUL: Setelah di area aman, hubungi keluarga/kontak darurat. Laporkan kondisi", "location": "Titik kumpul / area terbuka", "priority": 3},
            ],
            "dangerZones": ["Sumber bahaya utama (identifikasi visual)", "Jalur sempit/sumpek", "Benda yang bisa jatuh"],
            "nearestSafety": "Area terbuka tanpa struktur overhead, minimal 20m dari sumber bahaya.",
            "confidence": 0.5,
        },
    }

    result = dict(rules.get(disaster_type, rules["umum"]))
    if is_video:
        result["summary"] = "[Analisis video lingkungan] " + result["summary"]
    result["source"] = "rule-based"
    return result


# ── Qwen Vision via DashScope (optional, uses env var or MS key) ──
async def qwen_vision_analysis(image_b64: str, disaster_type: str, context: str) -> dict | None:
    """Call Qwen-VL-Plus via DashScope API. Returns None on any failure."""
    api_key = (
        os.environ.get("DASHSCOPE_API_KEY")
        or os.environ.get("MS_API_KEY")
        or ""
    )
    if not api_key or not image_b64:
        return None

    # Strip data URL prefix if present
    if image_b64.startswith("data:image"):
        image_b64 = image_b64.split(",", 1)[1]

    prompt = (
        f"Kamu analis keselamatan darurat Indonesia. Lihat gambar ini PERHATI.\n\n"
        f"JENIS BENCANA: {disaster_type.upper()}\n"
        f"LOKASI PENGGUNA: {context or 'Lokasi tidak diketahui'}\n\n"
        f"LANGKAH:\n"
        f"1. DAFTARKAN semua objek besar yang terlihat — sebutkan POSISI relatifnya\n"
        f"2. IDENTIFIKASI bahaya spesifik berdasarkan jenis bencana + objek\n"
        f"3. BERIKAN rekomendasi SPESIFIK merujuk objek yang kamu lihat\n\n"
        f'Balas HANYA JSON valid:\n'
        f'{{"objectsSeen":["objek1 di posisi X"],"riskLevel":"safe|caution|danger",'
        f'"summary":"1-2 kalimat kondisi + risiko",'
        f'"recommendations":[{{"action":"...","location":"...","priority":1}}],'
        f'"dangerZones":["Bahaya + posisi"],"nearestSafety":"Tempat aman terdekat","confidence":0.85}}'
    )

    url = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    payload = {
        "model": "qwen-vl-plus",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                {"type": "text", "text": prompt},
            ],
        }],
        "max_tokens": 1024,
        "temperature": 0.3,
    }

    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        import re
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            result = json.loads(m.group())
            result["source"] = "qwen-vision"
            return result
    except Exception as e:
        print(f"[Qwen Vision] Error: {e}")
    return None


# ── FastAPI app ────────────────────────────────────────────────
fastapi_app = FastAPI(title="SelamatKu — Disaster Safety App")


@fastapi_app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse(EMBEDDED_HTML)


@fastapi_app.post("/api/analyze-safety")
async def analyze_safety(request: Request):
    body = await request.json()
    images = body.get("images", [])
    image = body.get("image")
    disaster_type = body.get("disasterType", "umum")
    is_video = body.get("isVideo", False)
    context = body.get("context", "")

    frames = images if isinstance(images, list) else ([image] if image else [])

    # Try Qwen Vision first (if API key available)
    result = None
    if frames:
        first_frame = frames[0]
        # Strip data URL prefix
        if first_frame.startswith("data:image"):
            first_frame = first_frame.split(",", 1)[1]
        result = await qwen_vision_analysis(first_frame, disaster_type, context)

    # Fallback to rule-based
    if not result:
        result = rule_based_analysis(disaster_type, len(frames) > 0, context)

    result["framesAnalyzed"] = len(frames)
    return JSONResponse(result)


# Mount static files (icons, manifest, service-worker, etc.)
static_dir = os.path.join(BASE_DIR, "static")
os.makedirs(static_dir, exist_ok=True)
# Copy needed static files to static/ dir if they exist in root
for fname in ["manifest.json", "service-worker.js",
              "icon-192.png", "icon-512.png",
              "maskable-192.png", "maskable-512.png"]:
    src = os.path.join(BASE_DIR, fname)
    dst = os.path.join(static_dir, fname)
    if os.path.isfile(src) and not os.path.isfile(dst):
        import shutil
        shutil.copy2(src, dst)

fastapi_app.mount("/static", StaticFiles(directory=static_dir), name="static")


# ── Gradio UI ──────────────────────────────────────────────────
def build_gradio() -> gr.Blocks:
    with gr.Blocks(
        title="SelamatKu — AI Safety Scanner",
        theme=gr.themes.Soft(),
        css="""
          body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
          .sk-header {
            background: linear-gradient(135deg, #3730a3, #4f46e5, #818cf8);
            color: #fff;
            padding: 20px 24px;
            border-radius: 0 0 20px 20px;
          }
          .sk-header h1 { margin: 0; font-size: 1.5rem; font-weight: 800; }
          .sk-header p { margin: 4px 0 0; opacity: .8; font-size: .85rem; }
          .sk-fullscreen { width: 100%; height: 100vh; border: none !important; border-radius: 0 !important; }
        """,
    ) as demo:
        gr.HTML("""
        <div class="sk-header">
          <h1>🛡️ SelamatKu — Deteksi & Evakuasi Bencana</h1>
          <p>AI Safety Scanner · Qwen Vision · ModelScope</p>
        </div>
        """)

        gr.HTML(EMBEDDED_HTML)

    return demo


demo = build_gradio()

# Attach FastAPI routes to Gradio's underlying FastAPI app
demo.app = fastapi_app

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860)
