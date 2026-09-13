export const WEBRTC_CAPABILITY_KEY = "kubohiroyaWebRtcCapability";
export const REQUIRED_WEBRTC_CAPABILITY_VERSION = 2;

export interface WebRtcOfferCapabilityV2 {
  readonly version: number;
  requireVersion(version: number): WebRtcOfferCapabilityV2;
  createOffer(peer: string): Promise<string | void>;
  getOffer(peer: string): string;
}

export function requireWebRtcOfferCapability(
  runtime: TurboWarpRuntime,
): WebRtcOfferCapabilityV2 {
  const candidate = runtime[WEBRTC_CAPABILITY_KEY];
  if (!isRecord(candidate)) {
    throw new Error("TurboWarp WebRTC is not loaded.");
  }
  if (
    typeof candidate.requireVersion !== "function" ||
    typeof candidate.createOffer !== "function" ||
    typeof candidate.getOffer !== "function"
  ) {
    throw new Error("TurboWarp WebRTC does not provide the offer runtime API.");
  }
  try {
    candidate.requireVersion(REQUIRED_WEBRTC_CAPABILITY_VERSION);
  } catch (error) {
    throw new Error(
      `TurboWarp WebRTC runtime capability v${REQUIRED_WEBRTC_CAPABILITY_VERSION} is required.`,
      { cause: error },
    );
  }
  return candidate as unknown as WebRtcOfferCapabilityV2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
