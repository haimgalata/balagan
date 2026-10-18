/**
 * Camera barcode reading for the owner's scan screen. Loaded ONLY by ScanPage through a dynamic import, so neither the
 * library nor its WebAssembly file is part of any other bundle. The .wasm is served from this site (Vite copies it into
 * dist/assets) instead of the library's default CDN.
 */
import { BarcodeDetector, prepareZXingModule } from "barcode-detector/ponyfill";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
});

/** Shop barcodes: EAN-13 on almost every pack, plus the shorter retail formats. */
const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] as const;

export interface Scanner {
  /** Reads the current video frame; resolves the first barcode text, or null. */
  read: (video: HTMLVideoElement) => Promise<string | null>;
}

export function createScanner(): Scanner {
  const detector = new BarcodeDetector({ formats: [...FORMATS] });
  return {
    async read(video) {
      if (video.readyState < 2 || video.videoWidth === 0) return null;
      const found = await detector.detect(video);
      const value = found.find((b) => b.rawValue.trim() !== "")?.rawValue.trim();
      return value ?? null;
    },
  };
}
