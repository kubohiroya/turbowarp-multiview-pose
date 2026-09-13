import type { CameraCalibrationV1 } from "../src/calibration/types.js";
import { createCameraModel, projectPoint } from "../src/fusion/geometry.js";
import type { Vector3 } from "../src/fusion/types.js";
import { COCO_17_KEYPOINT_IDS } from "../src/pose/types.js";
import type { PoseFrame2DPersonV1, PoseFrame2DV1 } from "../src/pose/types.js";

export const IMAGE_WIDTH = 1280;
export const IMAGE_HEIGHT = 720;

/** Builds a CameraCalibration v1 profile for a camera that looks at a target. */
export function lookAtCalibration(
  cameraId: string,
  position: Vector3,
  target: Vector3 = { x: 0, y: 1, z: 0 },
  distortion: number[] = [],
): CameraCalibrationV1 {
  const forward = normalize(subtract(target, position));
  const right = normalize(cross(forward, { x: 0, y: 1, z: 0 }));
  const down = cross(forward, right);
  return {
    schema: "twmp/camera-calibration",
    version: 1,
    calibrationId: `${cameraId}-profile`,
    cameraId,
    imageWidth: IMAGE_WIDTH,
    imageHeight: IMAGE_HEIGHT,
    intrinsicMatrix: [
      900,
      0,
      IMAGE_WIDTH / 2,
      0,
      900,
      IMAGE_HEIGHT / 2,
      0,
      0,
      1,
    ],
    distortionCoefficients: distortion,
    worldFromCameraMatrix: [
      right.x,
      down.x,
      forward.x,
      position.x,
      right.y,
      down.y,
      forward.y,
      position.y,
      right.z,
      down.z,
      forward.z,
      position.z,
      0,
      0,
      0,
      1,
    ],
    worldUnit: "meter",
    calibratedAt: "2026-01-01T00:00:00Z",
  };
}

/** Projects one 3D skeleton into a camera as a PoseFrame2D person. */
export function projectPerson(
  calibration: CameraCalibrationV1,
  trackingId: string,
  points: readonly Vector3[],
  scores: readonly number[] = [],
): PoseFrame2DPersonV1 {
  const model = createCameraModel(calibration);
  return {
    trackingId,
    score: 0.9,
    keypoints: COCO_17_KEYPOINT_IDS.map((id, index) => {
      const point = points[index] ?? points[0];
      if (!point) throw new Error("A skeleton needs at least one point.");
      const projected = projectPoint(model, point);
      if (!projected)
        throw new Error(`${id} is behind camera ${calibration.cameraId}.`);
      return {
        id,
        x: projected.x,
        y: projected.y,
        score: scores[index] ?? 0.9,
      };
    }),
  };
}

/** A 17-point skeleton standing at one world position. */
export function skeleton(origin: Vector3): Vector3[] {
  return COCO_17_KEYPOINT_IDS.map((_, index) => ({
    x: origin.x + (index % 3) * 0.08 - 0.08,
    y: origin.y + 1.7 - index * 0.09,
    z: origin.z + ((index % 2) - 0.5) * 0.05,
  }));
}

export function poseFrame2D(
  cameraId: string,
  captureTimestampUs: number,
  persons: PoseFrame2DPersonV1[],
  sequence = 0,
): PoseFrame2DV1 {
  return {
    schema: "twmp/pose-frame-2d",
    version: 1,
    cameraId,
    peerId: `${cameraId}-peer`,
    sequence,
    captureTimestampUs,
    frameWidth: IMAGE_WIDTH,
    frameHeight: IMAGE_HEIGHT,
    calibrationId: `${cameraId}-profile`,
    persons,
  };
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function normalize(vector: Vector3): Vector3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length === 0) throw new Error("Cannot normalize a zero vector.");
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}
