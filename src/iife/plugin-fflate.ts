/** x3.fflate.js – synchronous gzip for the last recording packet when CompressionStream is missing (≤ 4 KB) */
import { gzipSync } from "fflate";

(window as Window & { __x3gz?: (data: Uint8Array) => Uint8Array }).__x3gz = (data) => gzipSync(data, { level: 6 });
