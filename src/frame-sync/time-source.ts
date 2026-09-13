import type { TimeSourcePort } from "./types.js";

export const WEBRTC_EXTENSION_KEY = "ext_kubohiroyawebrtc";

/**
 * Reads the shared clock from the WebRTC extension.
 *
 * The WebRTC extension owns clock probing between peers; this extension only
 * needs the resulting timestamp, so it calls the published reporter and keeps no
 * clock of its own.
 */
export function requireSynchronizedTimeSource(
  runtime: TurboWarpRuntime,
): TimeSourcePort {
  const candidate = runtime[WEBRTC_EXTENSION_KEY];
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("localTime" in candidate) ||
    typeof (candidate as { localTime: unknown }).localTime !== "function"
  ) {
    throw new Error(
      "TurboWarp WebRTC does not provide the synchronized time reporter.",
    );
  }
  const source = candidate as { localTime(): unknown };
  return {
    nowUs(): number {
      const value = Number(source.localTime());
      if (!Number.isFinite(value)) {
        throw new Error("Synchronized time service returned no timestamp.");
      }
      return value;
    },
  };
}
