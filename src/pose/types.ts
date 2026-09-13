export const COCO_17_KEYPOINT_IDS = [
  "nose",
  "left_eye",
  "right_eye",
  "left_ear",
  "right_ear",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
] as const;

export type Coco17KeypointId = (typeof COCO_17_KEYPOINT_IDS)[number];

export interface PoseFrame2DKeypointV1 {
  id: Coco17KeypointId;
  x: number;
  y: number;
  score: number;
}

export interface PoseFrame2DPersonV1 {
  trackingId: string;
  score: number;
  keypoints: PoseFrame2DKeypointV1[];
}

/** One glow stick color observed at a COCO-17 keypoint (PoseFrame2D v2). */
export interface PoseMarkerV2 {
  keypointId: Coco17KeypointId;
  colorHex: string;
  coverage: number;
}

export interface PoseFrame2DPersonV2 extends PoseFrame2DPersonV1 {
  markers: PoseMarkerV2[];
}

export interface PoseFrame2DV1 {
  schema: "twmp/pose-frame-2d";
  version: 1;
  cameraId: string;
  peerId: string;
  sequence: number;
  captureTimestampUs: number;
  frameWidth: number;
  frameHeight: number;
  calibrationId: string;
  persons: PoseFrame2DPersonV1[];
}

export interface PoseFrame2DV2 extends Omit<
  PoseFrame2DV1,
  "version" | "persons"
> {
  version: 2;
  persons: PoseFrame2DPersonV2[];
}

export type PoseFrame2D = PoseFrame2DV1 | PoseFrame2DV2;

export interface ModelKeypoint {
  name?: string;
  x: number;
  y: number;
  score?: number;
}

export interface ModelPose {
  id?: number;
  score?: number;
  keypoints: ModelKeypoint[];
}

export interface PoseDetectorPort {
  estimatePoses(
    image: HTMLVideoElement,
    config: { maxPoses: 6; flipHorizontal: false },
  ): Promise<ModelPose[]>;
  dispose(): void;
}

export interface PoseModelPort {
  initializeWebGpu(): Promise<void>;
  backend(): string;
  createMultiPoseDetector(): Promise<PoseDetectorPort>;
}

export interface CameraFrameSourcePort {
  readonly kind: "video";
  readonly element: HTMLVideoElement;
  readonly width: number;
  readonly height: number;
  readonly mirrored: boolean;
  readonly deviceId: string;
}

export interface CameraLeasePort {
  getFrameSource(): CameraFrameSourcePort;
  release(): Promise<void>;
}

export interface CameraSourcePort {
  acquireCamera(options: {
    owner: string;
    cameraId: string;
  }): Promise<CameraLeasePort>;
}
