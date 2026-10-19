// Yüklemeden önce resim küçültme / sıkıştırma (tablet ve telefon kameraları 12–50 MP çeker).
// Uzun kenar en fazla maxSide piksele indirilir, JPEG (saydam PNG ise WebP) olarak yeniden kodlanır; EXIF (konum vb.)
// bilgisi de böylece atılır. Resim olmayan, zaten küçük olan, GIF / SVG ya da tarayıcının çözemediği (ör. Chrome'da HEIC)
// dosyalar olduğu gibi gönderilir. Küçültülen dosya asıldan büyük çıkarsa asıl gönderilir.
const SKIP = /^image\/(gif|svg\+xml)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|bmp)$/i;
const SMALL = 600 * 1024;   // bundan küçük ve boyutu sınırda olan resim dokunulmadan gider

function isImage(file) {
  return file instanceof Blob && ((file.type && file.type.startsWith('image/')) || IMAGE_EXT.test(file.name || '')) && !SKIP.test(file.type || '');
}

async function decode(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* aşağıdaki yol */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const toBlob = (canvas, type, quality) => new Promise(res => canvas.toBlob(res, type, quality));

function hasAlpha(ctx, w, h) {
  // köşelerden ve ortadan örnek: saydam piksel varsa PNG'nin saydamlığı korunur
  const pts = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [w >> 1, h >> 1]];
  return pts.some(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3] < 255);
}

export async function optimizeImage(file, { maxSide = 2560, quality = 0.82 } = {}) {
  if (!isImage(file)) return file;
  let src;
  try { src = await decode(file); } catch { return file; }   // çözülemeyen biçim (ör. Chrome'da HEIC): olduğu gibi
  const w0 = src.width, h0 = src.height;
  if (!w0 || !h0) return file;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  if (scale === 1 && file.size <= SMALL) { src.close?.(); return file; }
  const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  src.close?.();
  let type = 'image/jpeg', ext = 'jpg';
  if (/png|webp/i.test(file.type) && hasAlpha(ctx, w, h)) { type = 'image/webp'; ext = 'webp'; }
  else { ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }   // JPEG: saydam yer beyaz
  const blob = await toBlob(canvas, type, quality);
  if (!blob || blob.type !== type || blob.size >= file.size) return file;   // tarayıcı bu biçimi kodlayamadı ya da kazanç yok
  const name = (file.name || 'resim').replace(/\.[^.]+$/, '') + `.${ext}`;
  return new File([blob], name, { type, lastModified: Date.now() });
}

// FormData içindeki resimleri sıkıştırır (diğer alanlar aynen kalır)
export async function optimizeForm(fd, opts) {
  if (!(fd instanceof FormData)) return fd;
  const entries = [...fd.entries()];
  if (!entries.some(([, v]) => isImage(v))) return fd;
  const out = new FormData();
  for (const [k, v] of entries) {
    if (isImage(v)) {
      const f = await optimizeImage(v, opts);
      out.append(k, f, f.name);
    } else {
      out.append(k, v);
    }
  }
  return out;
}
