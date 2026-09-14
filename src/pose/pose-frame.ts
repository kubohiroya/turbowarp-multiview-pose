import {
  COCO_17_KEYPOINT_IDS,
  type ModelPose,
  type PoseFrame2DPersonV1,
  type PoseFrame2DV1,
  type PoseFrame2DV2,
  type PoseMarkerV2,
} from "./types.js";

export interface PoseFrameContext {
  cameraId: string;
  peerId: string;
  calibrationId: string;
  sequence: number;
  captureTimestampUs: number;
  frameWidth: number;
  frameHeight: number;
}

/**
 * Builds a v1 frame, or a v2 frame when glow stick markers were sampled for the
 * same video frame. Markers are keyed by the index of the pose they belong to.
 */
export function createPoseFrame2D(
  poses: readonly ModelPose[],
  context: PoseFrameContext,
  markersByPose?: ReadonlyMap<number, PoseMarkerV2[]>,
): PoseFrame2DV1 | PoseFrame2DV2 {
  const header = {
    schema: "twrmc/pose-frame-2d",
    cameraId: identifier(context.cameraId, "camera ID"),
    peerId: identifier(context.peerId, "peer ID"),
    sequence: safeInteger(context.sequence, "sequence"),
    captureTimestampUs: safeInteger(
      context.captureTimestampUs,
      "capture timestamp",
    ),
    frameWidth: dimension(context.frameWidth, "frame width"),
    frameHeight: dimension(context.frameHeight, "frame height"),
    calibrationId: identifier(context.calibrationId, "calibration ID"),
  } as const;
  const retained = poses.slice(0, 6);
  if (!markersByPose) {
    return { ...header, version: 1, persons: retained.map(toPerson) };
  }
  return {
    ...header,
    version: 2,
    persons: retained.map((pose, index) => ({
      ...toPerson(pose),
      markers: (markersByPose.get(index) ?? []).map(marker),
    })),
  };
}

function marker(value: PoseMarkerV2): PoseMarkerV2 {
  if (!/^#[0-9A-Fa-f]{6}$/u.test(value.colorHex)) {
    throw new Error(`Invalid glow stick color: ${value.colorHex}`);
  }
  if (!isScore(value.coverage)) {
    throw new Error("Glow stick coverage must be between 0 and 1.");
  }
  return value;
}

function toPerson(pose: ModelPose): PoseFrame2DPersonV1 {
  if (!Number.isSafeInteger(pose.id) || Number(pose.id) < 0) {
    throw new Error("MoveNet tracking did not provide a valid person ID.");
  }
  if (!isScore(pose.score))
    throw new Error("MoveNet pose score is missing or invalid.");
  const byName = new Map(
    pose.keypoints.map((keypoint) => [keypoint.name, keypoint]),
  );
  return {
    trackingId: `movenet-${pose.id}`,
    score: pose.score,
    keypoints: COCO_17_KEYPOINT_IDS.map((id) => {
      const keypoint = byName.get(id);
      if (
        !keypoint ||
        !isCoordinate(keypoint.x) ||
        !isCoordinate(keypoint.y) ||
        !isScore(keypoint.score)
      ) {
        throw new Error(`MoveNet keypoint ${id} is missing or invalid.`);
      }
      return { id, x: keypoint.x, y: keypoint.y, score: keypoint.score };
    }),
  };
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(value))
    throw new Error(`Invalid ${label}.`);
  return value;
}

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid ${label}.`);
  return value;
}

function dimension(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 16384) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function isCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -1_000_000 &&
    value <= 1_000_000
  );
}

function isScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}
