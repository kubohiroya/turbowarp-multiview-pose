import type { Coco17KeypointId } from "../pose/types.js";

/** One glow stick color observed near one keypoint of one tracked person. */
export interface MarkerObservation {
  trackingId: string;
  keypointId: Coco17KeypointId;
  colorHex: string;
  /** Fraction of the sampled patch that carried the saturated color. */
  coverage: number;
  x: number;
  y: number;
}

/**
 * Extension-local courier for glow stick observations. It is deliberately not a
 * pinned multiview-pose contract: PoseFrame2D v1 is hash-pinned and cannot
 * carry color, so the camera app sends this envelope next to its pose frames.
 */
export interface MarkerFrameV1 {
  schema: "twmp-marker/1";
  cameraId: string;
  captureTimestampUs: number;
  frameWidth: number;
  frameHeight: number;
  observations: MarkerObservation[];
}

export interface MarkerPatch {
  x: number;
  y: number;
  radius: number;
}

export interface SampledColor {
  colorHex: string;
  coverage: number;
}

export interface MarkerFrame {
  element: HTMLVideoElement;
  width: number;
  height: number;
}

export interface MarkerImageSamplerPort {
  readonly name: string;
  /** Returns the dominant saturated color of each patch, or undefined. */
  sample(
    frame: MarkerFrame,
    patches: readonly MarkerPatch[],
  ): Array<SampledColor | undefined>;
}
