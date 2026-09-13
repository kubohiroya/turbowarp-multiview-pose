import type { Coco17KeypointId } from "../pose/types.js";

export interface AFramePublicBlockPort {
  readonly version: 1;
  requireVersion(version: number): AFramePublicBlockPort;
  loadTemplate(id: string, source: string): void;
  createFromTemplate(template: string, instance: string, parent: string): void;
  setPosition(selector: string, x: number, y: number, z: number): void;
  setRotation(selector: string, x: number, y: number, z: number): void;
  emitEvent(type: string, selector: string, data: string): void;
  deleteSelector(selector: string): void;
  countSelector(selector: string): number;
}

export interface AvatarRigBone {
  selector: string;
  rig: KalidokitRigKey;
  offsetDegrees: readonly [number, number, number];
}

export const KALIDOKIT_RIG_KEYS = [
  "RightUpperArm",
  "RightLowerArm",
  "LeftUpperArm",
  "LeftLowerArm",
  "RightHand",
  "LeftHand",
  "RightUpperLeg",
  "RightLowerLeg",
  "LeftUpperLeg",
  "LeftLowerLeg",
  "Spine",
  "Hips",
] as const;

export type KalidokitRigKey = (typeof KALIDOKIT_RIG_KEYS)[number];

export interface Rotation3 {
  x: number;
  y: number;
  z: number;
}

export interface KalidokitPoseRig {
  RightUpperArm: Rotation3;
  RightLowerArm: Rotation3;
  LeftUpperArm: Rotation3;
  LeftLowerArm: Rotation3;
  RightHand: Rotation3;
  LeftHand: Rotation3;
  RightUpperLeg: Rotation3;
  RightLowerLeg: Rotation3;
  LeftUpperLeg: Rotation3;
  LeftLowerLeg: Rotation3;
  Spine: Rotation3;
  Hips: {
    position: Rotation3;
    worldPosition?: Rotation3;
    rotation?: Rotation3;
  };
}

export interface AvatarRigMapping {
  rootScale: number;
  rootOffset: readonly [number, number, number];
  recognitionStartEvent: string;
  recognitionEndEvent: string;
  bones: readonly AvatarRigBone[];
}

export interface PoseFrame3DKeypoint {
  id: Coco17KeypointId;
  x: number;
  y: number;
  z: number;
  score: number;
}

export interface PoseFrame3DPerson {
  personId: string;
  score: number;
  keypoints: PoseFrame3DKeypoint[];
}

export interface PoseFrame2DPerson {
  trackingId: string;
  score: number;
  keypoints: Array<{
    id: Coco17KeypointId;
    x: number;
    y: number;
    score: number;
  }>;
}

export interface PoseFrame2D {
  schema: "twmp/pose-frame-2d";
  version: 1;
  captureTimestampUs: number;
  frameWidth: number;
  frameHeight: number;
  persons: PoseFrame2DPerson[];
}

export interface AvatarPoseSolverPort {
  solve(
    worldPerson: PoseFrame3DPerson,
    screenPerson: PoseFrame2DPerson,
    imageSize: { width: number; height: number },
  ): KalidokitPoseRig;
}

export interface PoseFrame3D {
  schema: "twmp/pose-frame-3d";
  version: 1;
  sequence: number;
  timestampUs: number;
  persons: PoseFrame3DPerson[];
}
