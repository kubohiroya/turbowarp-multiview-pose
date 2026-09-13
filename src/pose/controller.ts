import { createPoseFrame2D } from "./pose-frame.js";
import type {
  CameraLeasePort,
  CameraSourcePort,
  PoseDetectorPort,
  PoseFrame2DV1,
  PoseModelPort,
} from "./types.js";

export type PosePipelineState =
  | "idle"
  | "initializing-webgpu"
  | "loading-model"
  | "acquiring-camera"
  | "ready"
  | "inferencing"
  | "stopping"
  | "error";

export type PosePipelineErrorCode =
  | ""
  | "webgpu-unavailable"
  | "model-load-failed"
  | "camera-unavailable"
  | "camera-ended"
  | "inference-failed"
  | "invalid-output";

export interface PoseStartOptions {
  cameraId: string;
  peerId: string;
  calibrationId: string;
}

export interface PosePipelineControllerOptions {
  runtime: TurboWarpRuntime;
  model: PoseModelPort;
}

export class PosePipelineController {
  private readonly runtime: TurboWarpRuntime;
  private readonly model: PoseModelPort;
  private detector: PoseDetectorPort | undefined;
  private lease: CameraLeasePort | undefined;
  private startOptions: PoseStartOptions | undefined;
  private starting: Promise<void> | undefined;
  private inference: Promise<void> | undefined;
  private operation = 0;
  private sequence = 0;
  private latestFrame: PoseFrame2DV1 | undefined;
  private pipelineState: PosePipelineState = "idle";
  private pipelineErrorCode: PosePipelineErrorCode = "";
  private pipelineErrorMessage = "";

  public constructor(options: PosePipelineControllerOptions) {
    this.runtime = options.runtime;
    this.model = options.model;
  }

  public async start(options: PoseStartOptions): Promise<void> {
    const normalized = normalizeStartOptions(options);
    await this.stop();
    const operation = ++this.operation;
    const starting = this.initialize(normalized, operation);
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  public inferLatestFrame(captureTimestampUs: number): Promise<void> {
    if (!Number.isSafeInteger(captureTimestampUs) || captureTimestampUs < 0) {
      throw new Error(
        "Capture timestamp must be an externally synchronized non-negative integer in microseconds.",
      );
    }
    if (this.inference) return this.inference;
    if (!this.detector || !this.lease || !this.startOptions) {
      throw new Error("WebGPU MoveNet MultiPose is not ready.");
    }
    const operation = this.operation;
    const inference = this.runInference(operation, captureTimestampUs);
    this.inference = inference;
    const clear = () => {
      if (this.inference === inference) this.inference = undefined;
    };
    void inference.then(clear, clear);
    return inference;
  }

  public async stop(): Promise<void> {
    this.operation += 1;
    if (
      this.pipelineState !== "idle" ||
      this.detector ||
      this.lease ||
      this.starting ||
      this.inference
    ) {
      this.pipelineState = "stopping";
    }
    const starting = this.starting;
    const inference = this.inference;
    const detector = this.detector;
    const lease = this.lease;
    this.detector = undefined;
    this.lease = undefined;
    this.startOptions = undefined;
    await Promise.allSettled([starting, inference].filter(isPromise));
    detector?.dispose();
    await lease?.release();
    this.latestFrame = undefined;
    this.sequence = 0;
    this.pipelineState = "idle";
    this.clearError();
  }

  public state(): PosePipelineState {
    return this.pipelineState;
  }

  public ready(): boolean {
    return Boolean(this.detector && this.lease && this.startOptions);
  }

  public backend(): string {
    return this.model.backend();
  }

  public errorCode(): PosePipelineErrorCode {
    return this.pipelineErrorCode;
  }

  public errorMessage(): string {
    return this.pipelineErrorMessage;
  }

  public latestFrameJson(): string {
    return this.latestFrame ? JSON.stringify(this.latestFrame) : "";
  }

  private async initialize(
    options: PoseStartOptions,
    operation: number,
  ): Promise<void> {
    this.clearError();
    this.pipelineState = "initializing-webgpu";
    try {
      await this.model.initializeWebGpu();
      if (this.model.backend() !== "webgpu") {
        throw new Error(
          `Selected backend is ${this.model.backend() || "none"}.`,
        );
      }
    } catch (error) {
      this.fail("webgpu-unavailable", error);
    }
    if (operation !== this.operation) return;

    this.pipelineState = "loading-model";
    let detector: PoseDetectorPort;
    try {
      detector = await this.model.createMultiPoseDetector();
    } catch (error) {
      this.fail("model-load-failed", error);
    }
    if (operation !== this.operation) {
      detector.dispose();
      return;
    }

    this.pipelineState = "acquiring-camera";
    let lease: CameraLeasePort;
    try {
      lease = await requireCameraSource(this.runtime).acquireCamera({
        owner: "turbowarp-multiview-pose",
        cameraId: options.cameraId,
      });
    } catch (error) {
      detector.dispose();
      this.fail("camera-unavailable", error);
    }
    if (operation !== this.operation) {
      detector.dispose();
      await lease.release();
      return;
    }

    this.detector = detector;
    this.lease = lease;
    this.startOptions = options;
    this.sequence = 0;
    this.pipelineState = "ready";
  }

  private async runInference(
    operation: number,
    captureTimestampUs: number,
  ): Promise<void> {
    const detector = this.detector;
    const lease = this.lease;
    const options = this.startOptions;
    if (!detector || !lease || !options) return;
    this.pipelineState = "inferencing";
    let frame;
    try {
      frame = lease.getFrameSource();
      if (frame.kind !== "video" || frame.width < 1 || frame.height < 1) {
        throw new Error(
          "Camera frame source has ended or has no current frame.",
        );
      }
    } catch (error) {
      this.fail("camera-ended", error);
    }
    let poses;
    try {
      poses = await detector.estimatePoses(frame.element, {
        maxPoses: 6,
        flipHorizontal: false,
      });
    } catch (error) {
      this.fail("inference-failed", error);
    }
    if (operation !== this.operation) return;
    try {
      this.latestFrame = createPoseFrame2D(poses, {
        cameraId: options.cameraId,
        peerId: options.peerId,
        calibrationId: options.calibrationId,
        sequence: this.sequence,
        captureTimestampUs,
        frameWidth: frame.width,
        frameHeight: frame.height,
      });
      this.sequence += 1;
      this.pipelineState = "ready";
      this.clearError();
    } catch (error) {
      this.fail("invalid-output", error);
    }
  }

  private fail(
    code: Exclude<PosePipelineErrorCode, "">,
    cause: unknown,
  ): never {
    const detail = cause instanceof Error ? cause.message : String(cause);
    this.pipelineState = "error";
    this.pipelineErrorCode = code;
    this.pipelineErrorMessage = `${code}: ${detail}`;
    throw new Error(this.pipelineErrorMessage, { cause });
  }

  private clearError(): void {
    this.pipelineErrorCode = "";
    this.pipelineErrorMessage = "";
  }
}

function requireCameraSource(runtime: TurboWarpRuntime): CameraSourcePort {
  const candidate = runtime.ext_kubohiroyacamerasource;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("acquireCamera" in candidate) ||
    typeof candidate.acquireCamera !== "function"
  ) {
    throw new Error("TurboWarp Camera Source is not loaded.");
  }
  return candidate as CameraSourcePort;
}

function normalizeStartOptions(options: PoseStartOptions): PoseStartOptions {
  return {
    cameraId: identifier(options.cameraId, "camera ID"),
    peerId: identifier(options.peerId, "peer ID"),
    calibrationId: identifier(options.calibrationId, "calibration ID"),
  };
}

function identifier(value: string, label: string): string {
  const text = value.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(text))
    throw new Error(`Invalid ${label}.`);
  return text;
}

function isPromise(value: Promise<void> | undefined): value is Promise<void> {
  return value !== undefined;
}
