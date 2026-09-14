import { Value } from "@sinclair/typebox/value";
import { CameraCalibrationSchema } from "../protocol/schemas.js";
import type { CameraLeasePort, CameraSourcePort } from "../pose/types.js";
import type {
  CalibrationBackendPort,
  CalibrationBoard,
  CalibrationSample,
  CameraCalibrationV1,
} from "./types.js";

const MINIMUM_SAMPLES = 8;
const MAXIMUM_SAMPLES = 40;
const MINIMUM_SAMPLE_QUALITY = 0.2;
const MINIMUM_NORMALIZED_NOVELTY = 0.015;

export type CalibrationState =
  | "idle"
  | "acquiring-camera"
  | "sampling"
  | "ready"
  | "solving"
  | "solved"
  | "cancelling"
  | "error";

export type CalibrationErrorCode =
  | ""
  | "invalid-board"
  | "camera-unavailable"
  | "camera-ended"
  | "resolution-mismatch"
  | "board-not-found"
  | "sample-low-quality"
  | "sample-too-similar"
  | "sample-limit"
  | "sample-insufficient"
  | "sample-failed"
  | "solve-failed"
  | "reprojection-too-high"
  | "invalid-calibration"
  | "credential-forbidden";

export interface CalibrationStartOptions {
  cameraId: string;
  calibrationId: string;
  board: CalibrationBoard;
  maximumReprojectionErrorPx: number;
}

interface CalibrationControllerOptions {
  runtime: TurboWarpRuntime;
  backend: CalibrationBackendPort;
  nowMilliseconds?: () => number;
}

export class CameraCalibrationController {
  private readonly runtime: TurboWarpRuntime;
  private readonly backendPort: CalibrationBackendPort;
  private readonly nowMilliseconds: () => number;
  private session: CalibrationStartOptions | undefined;
  private lease: CameraLeasePort | undefined;
  private imageWidth = 0;
  private imageHeight = 0;
  private samples: CalibrationSample[] = [];
  private sampling: Promise<void> | undefined;
  private solving: Promise<void> | undefined;
  private profile: CameraCalibrationV1 | undefined;
  private sessionSampleCount = 0;
  private sampleQuality = 0;
  private reprojectionError = 0;
  private calibrationState: CalibrationState = "idle";
  private calibrationErrorCode: CalibrationErrorCode = "";
  private calibrationErrorMessage = "";
  private operation = 0;

  public constructor(options: CalibrationControllerOptions) {
    this.runtime = options.runtime;
    this.backendPort = options.backend;
    this.nowMilliseconds = options.nowMilliseconds ?? Date.now;
  }

  public async start(options: CalibrationStartOptions): Promise<void> {
    await this.cancel();
    let normalized: CalibrationStartOptions;
    try {
      normalized = normalizeStartOptions(options);
    } catch (error) {
      this.fail("invalid-board", error);
    }
    const operation = ++this.operation;
    this.calibrationState = "acquiring-camera";
    this.clearError();
    let lease: CameraLeasePort;
    try {
      lease = await requireCameraSource(this.runtime).acquireCamera({
        owner: "turbowarp-realtime-motion-capture-calibration",
        cameraId: normalized.cameraId,
      });
    } catch (error) {
      this.fail("camera-unavailable", error);
    }
    if (operation !== this.operation) {
      await lease.release();
      return;
    }
    let frame;
    try {
      frame = lease.getFrameSource();
      if (frame.kind !== "video" || frame.width < 1 || frame.height < 1) {
        throw new Error("Camera Source has no current video frame.");
      }
    } catch (error) {
      await lease.release();
      this.fail("camera-ended", error);
    }
    this.session = normalized;
    this.lease = lease;
    this.imageWidth = frame.width;
    this.imageHeight = frame.height;
    this.samples = [];
    this.sessionSampleCount = 0;
    this.sampleQuality = 0;
    this.reprojectionError = 0;
    this.calibrationState = "ready";
  }

  public addSample(): Promise<void> {
    if (this.sampling) return this.sampling;
    if (!this.session || !this.lease || this.calibrationState !== "ready") {
      throw new Error("Camera calibration is not ready to sample.");
    }
    const operation = this.operation;
    const sampling = this.captureSample(operation);
    this.sampling = sampling;
    const clear = () => {
      if (this.sampling === sampling) this.sampling = undefined;
    };
    void sampling.then(clear, clear);
    return sampling;
  }

  public solve(): Promise<void> {
    if (this.solving) return this.solving;
    if (!this.session || !this.lease || this.calibrationState !== "ready") {
      throw new Error("Camera calibration is not ready to solve.");
    }
    if (this.samples.length < MINIMUM_SAMPLES) {
      this.reject(
        "sample-insufficient",
        `At least ${MINIMUM_SAMPLES} accepted samples are required.`,
      );
    }
    const operation = this.operation;
    const solving = this.solveSession(operation);
    this.solving = solving;
    const clear = () => {
      if (this.solving === solving) this.solving = undefined;
    };
    void solving.then(clear, clear);
    return solving;
  }

  public async cancel(): Promise<void> {
    this.operation += 1;
    if (this.lease || this.sampling || this.solving) {
      this.calibrationState = "cancelling";
    }
    const sampling = this.sampling;
    const solving = this.solving;
    const lease = this.lease;
    this.lease = undefined;
    this.session = undefined;
    await Promise.allSettled([sampling, solving].filter(isPromise));
    await lease?.release();
    this.samples = [];
    this.sessionSampleCount = 0;
    this.sampleQuality = 0;
    this.reprojectionError = 0;
    this.calibrationState = "idle";
    this.clearError();
  }

  public async cleanup(): Promise<void> {
    await this.cancel();
    this.profile = undefined;
  }

  public async importProfile(json: string): Promise<void> {
    try {
      const profile = parseCalibrationProfile(json);
      await this.cancel();
      this.profile = profile;
      this.calibrationState = "solved";
    } catch (error) {
      const code =
        error instanceof CalibrationValidationError
          ? error.code
          : "invalid-calibration";
      const detail = error instanceof Error ? error.message : String(error);
      this.calibrationErrorCode = code;
      this.calibrationErrorMessage = `${code}: ${detail}`;
      throw new Error(this.calibrationErrorMessage, { cause: error });
    }
  }

  public validateProfile(json: string): boolean {
    try {
      parseCalibrationProfile(json);
      this.clearError();
      return true;
    } catch (error) {
      const code =
        error instanceof CalibrationValidationError
          ? error.code
          : "invalid-calibration";
      const detail = error instanceof Error ? error.message : String(error);
      this.calibrationErrorCode = code;
      this.calibrationErrorMessage = `${code}: ${detail}`;
      return false;
    }
  }

  public state(): CalibrationState {
    return this.calibrationState;
  }

  public ready(): boolean {
    return this.calibrationState === "ready";
  }

  public backend(): string {
    return this.backendPort.name;
  }

  public sampleCount(): number {
    return this.sessionSampleCount;
  }

  public latestSampleQuality(): number {
    return this.sampleQuality;
  }

  public latestReprojectionError(): number {
    return this.reprojectionError;
  }

  public errorCode(): CalibrationErrorCode {
    return this.calibrationErrorCode;
  }

  public errorMessage(): string {
    return this.calibrationErrorMessage;
  }

  public profileJson(): string {
    return this.profile ? JSON.stringify(this.profile) : "";
  }

  private async captureSample(operation: number): Promise<void> {
    const session = this.session;
    const lease = this.lease;
    if (!session || !lease) return;
    if (this.samples.length >= MAXIMUM_SAMPLES) {
      this.reject(
        "sample-limit",
        `At most ${MAXIMUM_SAMPLES} samples may be retained.`,
      );
    }
    this.calibrationState = "sampling";
    let frame;
    try {
      frame = lease.getFrameSource();
      if (frame.kind !== "video" || frame.width < 1 || frame.height < 1) {
        throw new Error("Camera Source has no current video frame.");
      }
    } catch (error) {
      this.fail("camera-ended", error);
    }
    if (frame.width !== this.imageWidth || frame.height !== this.imageHeight) {
      this.reject(
        "resolution-mismatch",
        `Expected ${this.imageWidth}x${this.imageHeight}, received ${frame.width}x${frame.height}.`,
      );
    }
    let sample: CalibrationSample | undefined;
    try {
      sample = await this.backendPort.captureSample(
        {
          element: frame.element,
          width: frame.width,
          height: frame.height,
        },
        session.board,
      );
    } catch (error) {
      this.fail("sample-failed", error);
    }
    if (operation !== this.operation) return;
    if (!sample) {
      this.reject("board-not-found", "The complete chessboard was not found.");
    }
    const expectedCorners = session.board.columns * session.board.rows;
    if (
      sample.corners.length !== expectedCorners ||
      !Number.isFinite(sample.quality) ||
      sample.quality < MINIMUM_SAMPLE_QUALITY
    ) {
      this.reject(
        "sample-low-quality",
        `Sample quality must be at least ${MINIMUM_SAMPLE_QUALITY}.`,
      );
    }
    if (
      this.samples.some(
        (previous) =>
          normalizedCornerDistance(
            previous,
            sample,
            this.imageWidth,
            this.imageHeight,
          ) < MINIMUM_NORMALIZED_NOVELTY,
      )
    ) {
      this.reject(
        "sample-too-similar",
        "Move or tilt the board before capturing another sample.",
      );
    }
    this.samples.push(sample);
    this.sessionSampleCount = this.samples.length;
    this.sampleQuality = sample.quality;
    this.calibrationState = "ready";
    this.clearError();
  }

  private async solveSession(operation: number): Promise<void> {
    const session = this.session;
    const lease = this.lease;
    if (!session || !lease) return;
    this.calibrationState = "solving";
    let solution;
    try {
      solution = await this.backendPort.solve(
        [...this.samples],
        session.board,
        this.imageWidth,
        this.imageHeight,
      );
    } catch (error) {
      this.fail("solve-failed", error);
    }
    if (operation !== this.operation) return;
    this.reprojectionError = solution.reprojectionErrorPx;
    if (
      !Number.isFinite(this.reprojectionError) ||
      this.reprojectionError > session.maximumReprojectionErrorPx
    ) {
      this.calibrationState = "ready";
      this.reject(
        "reprojection-too-high",
        `Reprojection RMS ${this.reprojectionError} px exceeds ${session.maximumReprojectionErrorPx} px.`,
      );
    }
    const profile: CameraCalibrationV1 = {
      schema: "twrmc/camera-calibration",
      version: 1,
      calibrationId: session.calibrationId,
      cameraId: session.cameraId,
      imageWidth: this.imageWidth,
      imageHeight: this.imageHeight,
      intrinsicMatrix: solution.intrinsicMatrix,
      distortionCoefficients: solution.distortionCoefficients,
      worldFromCameraMatrix: solution.worldFromCameraMatrix,
      worldUnit: "meter",
      calibratedAt: new Date(this.nowMilliseconds()).toISOString(),
    };
    if (!Value.Check(CameraCalibrationSchema, profile)) {
      const first = Value.Errors(CameraCalibrationSchema, profile).First();
      this.fail(
        "invalid-calibration",
        new Error(
          `${first?.path || "/"}: ${first?.message ?? "Invalid solution."}`,
        ),
      );
    }
    this.profile = profile;
    this.sessionSampleCount = this.samples.length;
    this.samples = [];
    this.lease = undefined;
    this.session = undefined;
    await lease.release();
    this.calibrationState = "solved";
    this.clearError();
  }

  private reject(code: CalibrationErrorCode, message: string): never {
    this.calibrationErrorCode = code;
    this.calibrationErrorMessage = `${code}: ${message}`;
    if (this.calibrationState !== "ready") this.calibrationState = "ready";
    throw new Error(this.calibrationErrorMessage);
  }

  private fail(code: CalibrationErrorCode, cause: unknown): never {
    const detail = cause instanceof Error ? cause.message : String(cause);
    this.calibrationState = "error";
    this.calibrationErrorCode = code;
    this.calibrationErrorMessage = `${code}: ${detail}`;
    throw new Error(this.calibrationErrorMessage, { cause });
  }

  private clearError(): void {
    this.calibrationErrorCode = "";
    this.calibrationErrorMessage = "";
  }
}

function normalizeStartOptions(
  options: CalibrationStartOptions,
): CalibrationStartOptions {
  const columns = integerInRange(options.board.columns, 3, 20, "columns");
  const rows = integerInRange(options.board.rows, 3, 20, "rows");
  if (
    !Number.isFinite(options.board.squareSizeMeters) ||
    options.board.squareSizeMeters <= 0 ||
    options.board.squareSizeMeters > 1
  ) {
    throw new Error("invalid-board: square size must be within (0, 1] meter.");
  }
  if (
    !Number.isFinite(options.maximumReprojectionErrorPx) ||
    options.maximumReprojectionErrorPx <= 0 ||
    options.maximumReprojectionErrorPx > 100
  ) {
    throw new Error(
      "invalid-board: maximum reprojection error must be within (0, 100] px.",
    );
  }
  return {
    cameraId: identifier(options.cameraId, "camera ID"),
    calibrationId: identifier(options.calibrationId, "calibration ID"),
    board: {
      columns,
      rows,
      squareSizeMeters: options.board.squareSizeMeters,
    },
    maximumReprojectionErrorPx: options.maximumReprojectionErrorPx,
  };
}

function normalizedCornerDistance(
  left: CalibrationSample,
  right: CalibrationSample,
  width: number,
  height: number,
): number {
  let squared = 0;
  for (let index = 0; index < left.corners.length; index += 1) {
    const a = left.corners[index];
    const b = right.corners[index];
    if (!a || !b) return Number.POSITIVE_INFINITY;
    squared += (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  }
  return Math.sqrt(squared / left.corners.length) / Math.hypot(width, height);
}

function findPairingCredential(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findPairingCredential(item, `${path}/${index}`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, "");
    if (
      /^(?:offer|answer|sdp|icecandidate|icecandidates|icepwd|iceufrag|dtlsfingerprint|credential|credentials)$/u.test(
        normalized,
      )
    ) {
      return itemPath;
    }
    const found = findPairingCredential(item, itemPath);
    if (found) return found;
  }
  return undefined;
}

function parseCalibrationProfile(json: string): CameraCalibrationV1 {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new CalibrationValidationError("invalid-calibration", String(error));
  }
  const credentialPath = findPairingCredential(value);
  if (credentialPath) {
    throw new CalibrationValidationError(
      "credential-forbidden",
      `Pairing credential is forbidden at ${credentialPath}.`,
    );
  }
  if (!Value.Check(CameraCalibrationSchema, value)) {
    const first = Value.Errors(CameraCalibrationSchema, value).First();
    throw new CalibrationValidationError(
      "invalid-calibration",
      `${first?.path || "/"}: ${first?.message ?? "Invalid v1 profile."}`,
    );
  }
  return value as CameraCalibrationV1;
}

class CalibrationValidationError extends Error {
  public constructor(
    public readonly code: Extract<
      CalibrationErrorCode,
      "invalid-calibration" | "credential-forbidden"
    >,
    message: string,
  ) {
    super(message);
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

function identifier(value: string, label: string): string {
  const text = value.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(text)) {
    throw new Error(`invalid-board: invalid ${label}.`);
  }
  return text;
}

function integerInRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `invalid-board: ${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function isPromise(value: Promise<void> | undefined): value is Promise<void> {
  return value !== undefined;
}
