/**
 * The camera scanner, shared by the mechanic app (m/) and the Detail Tracker
 * (d/), so both read a work order or winter quote the same way. Moved here
 * out of m/index.html unchanged but for the ZXing path, which is relative to
 * this file now.
 */
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');


const NATIVE_FORMATS = {
  qr: ['qr_code'],
  any: ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'],
};

/**
 * Chrome on Android has a barcode detector built into the browser and it is
 * far faster than anything shipped in JavaScript. Safari — which is what the
 * shop iPad and half the phones run — has no such thing, so ZXing is loaded
 * on demand as the fallback. It is a big download, which is exactly why it is
 * not loaded until someone actually opens the camera.
 */
export async function startScanner(element, mode, onResult) {
  let stream = null;
  let raf = 0;
  let reader = null;
  let stopped = false;
  const video = element.querySelector('video');

  const stop = () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    if (reader) try { reader.reset(); } catch { /* already torn down */ }
    if (stream) stream.getTracks().forEach((track) => track.stop());
  };
  const finish = (value) => {
    if (stopped) return;
    stop();
    if (navigator.vibrate) navigator.vibrate(40);
    onResult(value);
  };
  const fail = (message) => {
    if (stopped) return;
    element.querySelector('.hintline').textContent = message;
  };

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    fail('This browser cannot open the camera. Type the number instead.');
    return stop;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    });
  } catch (error) {
    fail(error && error.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow it for this site, or type the number instead.'
      : 'Could not start the camera. Type the number instead.');
    return stop;
  }
  if (stopped) { stream.getTracks().forEach((t) => t.stop()); return stop; }

  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  video.muted = true;
  try { await video.play(); } catch { /* Safari resolves late; the loop copes */ }

  if (window.BarcodeDetector) {
    const detector = new window.BarcodeDetector({ formats: NATIVE_FORMATS[mode] });
    const tick = async () => {
      if (stopped) return;
      try {
        const hits = await detector.detect(video);
        if (hits.length && hits[0].rawValue) return finish(hits[0].rawValue);
      } catch { /* a dropped frame is not worth showing anyone */ }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return stop;
  }

  try {
    const zxing = await import('../vendor/zxing.min.js');
    const lib = zxing.default || zxing;
    if (stopped) return stop;
    const hints = new Map();
    hints.set(lib.DecodeHintType.POSSIBLE_FORMATS, mode === 'any'
      ? [lib.BarcodeFormat.QR_CODE, lib.BarcodeFormat.EAN_13, lib.BarcodeFormat.EAN_8,
         lib.BarcodeFormat.UPC_A, lib.BarcodeFormat.UPC_E, lib.BarcodeFormat.CODE_128,
         lib.BarcodeFormat.CODE_39, lib.BarcodeFormat.ITF, lib.BarcodeFormat.CODABAR]
      : [lib.BarcodeFormat.QR_CODE]);
    reader = new lib.BrowserMultiFormatReader(hints, 250);
    await reader.decodeFromStream(stream, video, (result) => {
      const text = result && result.getText();
      if (text) finish(text);
    });
  } catch {
    fail('The scanner could not start. Type the number instead.');
  }
  return stop;
}

export function scannerHtml(hint) {
  return `<div class="scanner">
    <video playsinline muted></video>
    <div class="reticle"></div>
    <div class="hintline">${esc(hint)}</div>
  </div>`;
}

