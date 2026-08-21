'use client';

import { useEffect, useRef, useState } from 'react';

type Mode = 'qr' | 'any';

const NATIVE_FORMATS: Record<Mode, string[]> = {
  qr: ['qr_code'],
  any: ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'],
};

type BarcodeDetectorLike = {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
};

/**
 * Camera scanner for the shop floor.
 *
 * Chrome on Android has a barcode detector built into the browser and it is
 * far faster than anything shipped in JavaScript, so it is used when present.
 * Safari — which is what the shop iPad and half the phones run — has no such
 * thing, so ZXing is loaded on demand as the fallback. It is a big download,
 * which is exactly why it is not in the main bundle.
 */
export function Scanner({
  mode = 'qr',
  hint,
  onResult,
  onError,
}: {
  mode?: Mode;
  hint?: string;
  onResult: (value: string) => void;
  onError?: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'starting' | 'running' | 'failed'>('starting');
  const [message, setMessage] = useState<string | null>(null);
  // The scan callback fires many times a second; one result is all we want.
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let reader: { reset: () => void } | null = null;
    let cancelled = false;

    const finish = (value: string) => {
      if (done.current || cancelled) return;
      done.current = true;
      if (navigator.vibrate) navigator.vibrate(40);
      onResult(value);
    };

    const fail = (text: string) => {
      if (cancelled) return;
      setStatus('failed');
      setMessage(text);
      onError?.(text);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        fail('This browser cannot open the camera. Type the invoice number instead.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
      } catch (error) {
        const name = (error as DOMException).name;
        fail(
          name === 'NotAllowedError'
            ? 'Camera access was blocked. Allow the camera for this site, or type the invoice number instead.'
            : 'Could not start the camera. Type the invoice number instead.',
        );
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      video.muted = true;
      try {
        await video.play();
      } catch {
        /* Safari resolves this late; the frame loop copes either way. */
      }
      setStatus('running');

      const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => BarcodeDetectorLike })
        .BarcodeDetector;
      if (Native) {
        const detector = new Native({ formats: NATIVE_FORMATS[mode] });
        const tick = async () => {
          if (cancelled || done.current) return;
          try {
            const hits = await detector.detect(video);
            if (hits.length && hits[0].rawValue) {
              finish(hits[0].rawValue);
              return;
            }
          } catch {
            /* A dropped frame is not an error worth showing anyone. */
          }
          raf = requestAnimationFrame(() => void tick());
        };
        raf = requestAnimationFrame(() => void tick());
        return;
      }

      try {
        const zxing = await import('@zxing/library');
        if (cancelled) return;
        const hints = new Map();
        hints.set(zxing.DecodeHintType.POSSIBLE_FORMATS, [
          zxing.BarcodeFormat.QR_CODE,
          ...(mode === 'any'
            ? [
                zxing.BarcodeFormat.EAN_13,
                zxing.BarcodeFormat.EAN_8,
                zxing.BarcodeFormat.UPC_A,
                zxing.BarcodeFormat.UPC_E,
                zxing.BarcodeFormat.CODE_128,
                zxing.BarcodeFormat.CODE_39,
                zxing.BarcodeFormat.ITF,
                zxing.BarcodeFormat.CODABAR,
              ]
            : []),
        ]);
        const multi = new zxing.BrowserMultiFormatReader(hints, 250);
        reader = multi;
        await multi.decodeFromStream(stream, video, (result) => {
          const text = result?.getText();
          if (text) finish(text);
        });
      } catch {
        fail('The scanner could not start. Type the invoice number instead.');
      }
    })();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      reader?.reset();
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [mode, onResult, onError]);

  return (
    <div>
      <div className="scanner">
        <video ref={videoRef} playsInline muted />
        <div className="reticle" />
        <div className="hintline">
          {status === 'starting' && 'Starting the camera…'}
          {status === 'running' && (hint ?? 'Hold the code inside the box')}
        </div>
      </div>
      {status === 'failed' && message && (
        <div className="banner warn" style={{ marginTop: 12 }}>
          {message}
        </div>
      )}
    </div>
  );
}
