import type { QrErrorCorrectionLevel } from "../src/qr-courier.js";

interface QrConfigGlobal {
  readonly __TWMP_QR_CONFIG__?: {
    readonly errorCorrectionLevel?: QrErrorCorrectionLevel;
  };
}

const configuredLevel = (globalThis as QrConfigGlobal).__TWMP_QR_CONFIG__
  ?.errorCorrectionLevel;

/** Startup-fixed QR settings. M is the initial software-validated default. */
export const qrConfig = Object.freeze({
  errorCorrectionLevel: isLevel(configuredLevel) ? configuredLevel : "M",
});

function isLevel(value: unknown): value is QrErrorCorrectionLevel {
  return value === "L" || value === "M" || value === "Q" || value === "H";
}
