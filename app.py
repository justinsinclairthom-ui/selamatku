"""
SelamatKu — Disaster Detection & Evacuation App
Entry point for ModelScope Studio deployment.

Strategy: Serve the PWA as a pure static site via FastAPI. The root URL (/)
returns index.html directly, all assets (CSS, JS, icons, manifest) are served
from the repo root. A minimal Gradio demo is attached so ModelScope's harness
is satisfied, but users will see the full PWA when they open the space URL.

The AI safety scanner endpoint POST /api/analyze-safety is also exposed here.
"""

import os
import re
import json
import urllib.request
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

# ── Paths ──────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _get_api_key(body: dict) -> str:
    return (
        body.get("msApiKey")
        or os.environ.get("DASHSCOPE_API_KEY")
        or os.environ.get("MS_API_KEY")
        or ""
    )


# ── Rule-based analysis ────────────────────────────────────────
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


# ── Qwen Vision via DashScope ──────────────────────────────────
async def qwen_vision_analysis(image_b64: str, disaster_type: str, context: str, api_key: str):
    if not api_key or not image_b64:
        return None

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
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            result = json.loads(m.group())
            result["source"] = "qwen-vision"
            return result
    except Exception as e:
        print(f"[Qwen Vision] Error: {e}")
    return None


# ── FastAPI app ────────────────────────────────────────────────
app = FastAPI(title="SelamatKu — Disaster Safety App")


@app.get("/", response_class=HTMLResponse)
async def index():
    path = os.path.join(BASE_DIR, "index.html")
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return HTMLResponse("<h1>SelamatKu</h1><p>index.html tidak ditemukan.</p>")


@app.post("/api/analyze-safety")
async def analyze_safety(request: Request):
    body = await request.json()
    images = body.get("images", [])
    image = body.get("image")
    disaster_type = body.get("disasterType", "umum")
    is_video = body.get("isVideo", False)
    context = body.get("context", "")

    frames = images if isinstance(images, list) else ([image] if image else [])

    result = None
    if frames:
        first_frame = frames[0]
        if first_frame.startswith("data:image"):
            first_frame = first_frame.split(",", 1)[1]
        result = await qwen_vision_analysis(first_frame, disaster_type, context, _get_api_key(body))

    if not result:
        result = rule_based_analysis(disaster_type, len(frames) > 0, context)

    result["framesAnalyzed"] = len(frames)
    return JSONResponse(result)


# Mount static files at root (style.css, app.js, icons, manifest, etc.)
app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="static")


# ── Launch ─────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=7860)
