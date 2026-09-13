export interface MultiviewPoseFeatureFlags {
  readonly qrCourierPairing: boolean;
  readonly webgpuMoveNetMultiPose: boolean;
  readonly protocolV1Codec: boolean;
  readonly cameraCalibrationV1: boolean;
  readonly avatarRetargetV1: boolean;
  readonly frameSyncPatternV1: boolean;
}

interface FeatureFlagGlobal {
  readonly __TWMP_FEATURE_FLAGS__?: Partial<MultiviewPoseFeatureFlags>;
}

const overrides = (globalThis as FeatureFlagGlobal).__TWMP_FEATURE_FLAGS__;

/** Startup-fixed flags. Experimental QR and pose paths stay independently opt-in. */
export const featureFlags: MultiviewPoseFeatureFlags = Object.freeze({
  qrCourierPairing: overrides?.qrCourierPairing === true,
  webgpuMoveNetMultiPose: overrides?.webgpuMoveNetMultiPose === true,
  protocolV1Codec: overrides?.protocolV1Codec === true,
  cameraCalibrationV1: overrides?.cameraCalibrationV1 === true,
  avatarRetargetV1: overrides?.avatarRetargetV1 === true,
  frameSyncPatternV1: overrides?.frameSyncPatternV1 === true,
});
