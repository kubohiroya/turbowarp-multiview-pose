import type { Coco17KeypointId } from "../pose/types.js";

export interface MarkerPatch {
  /** Patch center in frame pixels. */
  x: number;
  y: number;
  radius: number;
}

export interface SampledColor {
  colorHex: string;
  /** Fraction of the patch that carried the saturated color, 0 to 1. */
  coverage: number;
}

export interface MarkerFrame {
  element: HTMLVideoElement;
  width: number;
  height: number;
}

/** Reads the dominant saturated color of each patch of one video frame. */
export interface MarkerImageSamplerPort {
  readonly name: string;
  sample(
    frame: MarkerFrame,
    patches: readonly MarkerPatch[],
  ): Array<SampledColor | undefined>;
}

export interface MarkerSamplingOptions {
  /** Keypoints that may carry a glow stick. */
  keypointIds: Coco17KeypointId[];
  /** Keypoint score required before its patch is sampled. */
  minKeypointScore: number;
  /** Saturation and value required of a glow stick pixel. */
  minSaturation: number;
  minValue: number;
  /** Fraction of the patch that must qualify before a marker is reported. */
  minCoverage: number;
}

export const DEFAULT_MARKER_SAMPLING_OPTIONS: MarkerSamplingOptions = {
  keypointIds: ["right_wrist", "left_wrist"],
  minKeypointScore: 0.3,
  minSaturation: 0.45,
  minValue: 0.3,
  minCoverage: 0.08,
};
