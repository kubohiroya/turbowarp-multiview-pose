export interface MultiviewPoseFeatureFlags {
  readonly qrCourierPairing: boolean;
  readonly webgpuMoveNetMultiPose: boolean;
}

interface FeatureFlagGlobal {
  readonly __TWMP_FEATURE_FLAGS__?: Partial<MultiviewPoseFeatureFlags>;
}

const overrides = (globalThis as FeatureFlagGlobal).__TWMP_FEATURE_FLAGS__;

/** Startup-fixed flags. Experimental QR and pose paths stay independently opt-in. */
export const featureFlags: MultiviewPoseFeatureFlags = Object.freeze({
  qrCourierPairing: overrides?.qrCourierPairing === true,
  webgpuMoveNetMultiPose: overrides?.webgpuMoveNetMultiPose === true,
});
