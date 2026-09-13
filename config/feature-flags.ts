export interface MultiviewPoseFeatureFlags {
  readonly qrCourierPairing: boolean;
}

interface FeatureFlagGlobal {
  readonly __TWMP_FEATURE_FLAGS__?: Partial<MultiviewPoseFeatureFlags>;
}

const overrides = (globalThis as FeatureFlagGlobal).__TWMP_FEATURE_FLAGS__;

/** Startup-fixed flags. QR pairing stays opt-in until the physical courier flow is validated. */
export const featureFlags: MultiviewPoseFeatureFlags = Object.freeze({
  qrCourierPairing: overrides?.qrCourierPairing === true,
});
