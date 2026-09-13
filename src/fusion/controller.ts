import { Value } from "@sinclair/typebox/value";
import type { CameraCalibrationV1 } from "../calibration/types.js";
import type { PoseFrame2DV1 } from "../pose/types.js";
import {
  decodeProtocolJson,
  formatProtocolDiagnostic,
} from "../protocol/codec.js";
import { PoseFrame3DSchema } from "../protocol/schemas.js";
import {
  DEFAULT_FUSION_GEOMETRY_OPTIONS,
  fuseSynchronizedSample,
  type FusionGeometryOptions,
} from "./fuse.js";
import { createCameraModel } from "./geometry.js";
import { PersonIdentityRegistry } from "./identity.js";
import {
  DEFAULT_JITTER_BUFFER_OPTIONS,
  MultiCameraJitterBuffer,
  type JitterBufferOptions,
} from "./jitter-buffer.js";
import type { CameraModel, SynchronizedPoseSample } from "./types.js";

export type PoseFusionState =
  "idle" | "buffering" | "fusing" | "ready" | "error";

export type PoseFusionErrorCode =
  | ""
  | "calibration-invalid"
  | "frame-invalid"
  | "frame-dropped"
  | "unknown-camera"
  | "empty-buffer"
  | "insufficient-cameras"
  | "no-fused-person"
  | "invalid-output";

export interface PoseFusionStartOptions {
  /** How far behind the newest buffered timestamp the fused instant sits. */
  delayMilliseconds: number;
  /** Accepted out-of-order arrival window. */
  jitterMilliseconds: number;
  minKeypointScore: number;
}

export const MAX_FUSION_CAMERAS = 16;
const MAX_DELAY_MS = 5_000;
const MAX_JITTER_MS = 2_000;
const MIN_RING_SLOTS = 16;
const MAX_RING_SLOTS = 600;
const ASSUMED_MINIMUM_FRAME_INTERVAL_US = 8_000;

export class PoseFusionController {
  private readonly buffer = new MultiCameraJitterBuffer(
    DEFAULT_JITTER_BUFFER_OPTIONS,
  );
  private readonly identities = new PersonIdentityRegistry();
  private readonly models = new Map<string, CameraModel>();
  private jitterOptions: JitterBufferOptions = DEFAULT_JITTER_BUFFER_OPTIONS;
  private geometryOptions: FusionGeometryOptions =
    DEFAULT_FUSION_GEOMETRY_OPTIONS;
  private delayUs = 0;
  private started = false;
  private sequence = 0;
  private fusionState: PoseFusionState = "idle";
  private fusionErrorCode: PoseFusionErrorCode = "";
  private fusionErrorMessage = "";
  private latestFrame: Record<string, unknown> | undefined;
  private latestFrameJsonValue = "";
  private latestSample: SynchronizedPoseSample | undefined;

  public start(options: PoseFusionStartOptions): void {
    const delayMs = requireRange(
      options.delayMilliseconds,
      0,
      MAX_DELAY_MS,
      "fusion delay",
    );
    const jitterMs = requireRange(
      options.jitterMilliseconds,
      1,
      MAX_JITTER_MS,
      "jitter window",
    );
    const minKeypointScore = requireRange(
      options.minKeypointScore,
      0,
      1,
      "minimum keypoint score",
    );
    this.delayUs = Math.round(delayMs * 1000);
    const jitterWindowUs = Math.round(jitterMs * 1000);
    this.jitterOptions = {
      capacityPerCamera: ringSlots(this.delayUs, jitterWindowUs),
      jitterWindowUs,
      maxHoldUs: jitterWindowUs,
      maxGapUs: jitterWindowUs * 2,
      minKeypointScore,
    };
    this.geometryOptions = {
      ...DEFAULT_FUSION_GEOMETRY_OPTIONS,
      minKeypointScore,
    };
    this.buffer.configure(this.jitterOptions);
    this.identities.clear();
    this.sequence = 0;
    this.latestFrame = undefined;
    this.latestFrameJsonValue = "";
    this.latestSample = undefined;
    this.started = true;
    this.fusionState = "buffering";
    this.clearError();
  }

  public stop(): void {
    this.buffer.clear();
    this.identities.clear();
    this.sequence = 0;
    this.latestFrame = undefined;
    this.latestFrameJsonValue = "";
    this.latestSample = undefined;
    this.started = false;
    this.fusionState = "idle";
    this.clearError();
  }

  /** Releases buffers and every loaded calibration profile. */
  public cleanup(): void {
    this.stop();
    this.models.clear();
  }

  public loadCalibration(json: string): void {
    const decoded = decodeProtocolJson(json, Date.now());
    if (!decoded.ok || decoded.schema !== "twmp/camera-calibration") {
      const message = decoded.ok
        ? `Expected twmp/camera-calibration, received ${decoded.schema}.`
        : formatProtocolDiagnostic(decoded.diagnostic);
      this.fail("calibration-invalid", message);
    }
    const calibration = decoded.value as unknown as CameraCalibrationV1;
    if (
      !this.models.has(calibration.cameraId) &&
      this.models.size >= MAX_FUSION_CAMERAS
    ) {
      this.fail(
        "calibration-invalid",
        `At most ${MAX_FUSION_CAMERAS} calibrated cameras can be fused.`,
      );
    }
    let model: CameraModel;
    try {
      model = createCameraModel(calibration);
    } catch (error) {
      this.fail("calibration-invalid", errorMessage(error));
    }
    this.models.set(calibration.cameraId, model);
    this.clearError();
  }

  /** Buffers one PoseFrame2D. Duplicate and late frames are counted, not thrown. */
  public ingestFrame(json: string): void {
    this.requireStarted();
    const decoded = decodeProtocolJson(json, Date.now());
    if (!decoded.ok || decoded.schema !== "twmp/pose-frame-2d") {
      const message = decoded.ok
        ? `Expected twmp/pose-frame-2d, received ${decoded.schema}.`
        : formatProtocolDiagnostic(decoded.diagnostic);
      this.fail("frame-invalid", message);
    }
    const frame = decoded.value as unknown as PoseFrame2DV1;
    if (
      !this.buffer.cameraIds().includes(frame.cameraId) &&
      this.buffer.cameraIds().length >= MAX_FUSION_CAMERAS
    ) {
      this.fail(
        "frame-invalid",
        `At most ${MAX_FUSION_CAMERAS} cameras can be buffered.`,
      );
    }
    const outcome = this.buffer.ingest(frame);
    if (outcome === "accepted") {
      this.clearError();
      if (this.fusionState === "idle") this.fusionState = "buffering";
      return;
    }
    this.fusionErrorCode = "frame-dropped";
    this.fusionErrorMessage = `${outcome}: camera ${frame.cameraId} frame at ${frame.captureTimestampUs} us was not buffered.`;
  }

  /** Fuses the instant that sits one configured delay behind the newest frame. */
  public fuseBufferedInstant(): boolean {
    this.requireStarted();
    const newest = this.buffer.newestTimestampUs();
    if (newest === undefined) {
      this.reject("empty-buffer", "No PoseFrame2D has been buffered.");
      return false;
    }
    return this.fuseAt(Math.max(newest - this.delayUs, 0));
  }

  /** Fuses one explicit past instant expressed in the synchronized time base. */
  public fuseAt(timestampUs: number): boolean {
    this.requireStarted();
    if (!Number.isSafeInteger(timestampUs) || timestampUs < 0) {
      this.fail(
        "invalid-output",
        "Fusion timestamp must be a non-negative integer in microseconds.",
      );
    }
    this.fusionState = "fusing";
    const sample = this.buffer.sampleAt(timestampUs);
    this.latestSample = sample;
    const calibrated = sample.cameras.filter((camera) =>
      this.models.has(camera.cameraId),
    );
    if (calibrated.length < this.geometryOptions.minCamerasPerPerson) {
      this.reject(
        "insufficient-cameras",
        `Only ${calibrated.length} calibrated camera(s) covered ${timestampUs} us.`,
      );
      return false;
    }

    const persons = fuseSynchronizedSample(
      sample,
      this.models,
      this.geometryOptions,
    );
    if (persons.length === 0) {
      this.reject(
        "no-fused-person",
        `No person was observed by ${this.geometryOptions.minCamerasPerPerson} or more cameras.`,
      );
      return false;
    }

    const frame = {
      schema: "twmp/pose-frame-3d",
      version: 1,
      sequence: this.sequence,
      timestampUs,
      persons: persons.map((person) => {
        const personId = this.identities.resolve(person.members, this.sequence);
        return {
          personId,
          score: round(person.score),
          cameraIds: person.cameraIds,
          meanReprojectionErrorPx: round(person.meanReprojectionErrorPx),
          keypoints: person.keypoints.map((keypoint) => {
            if (keypoint.point) {
              this.identities.remember(personId, keypoint.id, keypoint.point);
              return {
                id: keypoint.id,
                x: round(keypoint.point.x),
                y: round(keypoint.point.y),
                z: round(keypoint.point.z),
                score: round(keypoint.score),
              };
            }
            // Unfused keypoint: hold the last triangulated position and report
            // a zero score so consumers can tell it was not measured.
            const held = this.identities.lastPoint(personId, keypoint.id);
            return {
              id: keypoint.id,
              x: round(held?.x ?? 0),
              y: round(held?.y ?? 0),
              z: round(held?.z ?? 0),
              score: 0,
            };
          }),
        };
      }),
    };

    if (!Value.Check(PoseFrame3DSchema, frame)) {
      const first = Value.Errors(PoseFrame3DSchema, frame).First();
      this.latestSample = sample;
      this.fail(
        "invalid-output",
        `${first?.path || "/"}: ${first?.message ?? "Fused frame does not match PoseFrame3D v1."}`,
      );
    }
    this.identities.prune(this.sequence);
    this.sequence += 1;
    this.latestFrame = frame;
    this.latestFrameJsonValue = JSON.stringify(frame);
    this.fusionState = "ready";
    this.clearError();
    return true;
  }

  public state(): PoseFusionState {
    return this.fusionState;
  }

  public ready(): boolean {
    return (
      this.started &&
      this.models.size >= this.geometryOptions.minCamerasPerPerson
    );
  }

  public cameraCount(): number {
    return this.models.size;
  }

  public bufferedFrameCount(): number {
    return this.buffer.bufferedFrameCount();
  }

  public droppedFrameCount(): number {
    return this.buffer.droppedFrameCount();
  }

  public personCount(): number {
    const persons = this.latestFrame?.persons;
    return Array.isArray(persons) ? persons.length : 0;
  }

  public fusedTimestampUs(): number {
    const timestamp = this.latestFrame?.timestampUs;
    return typeof timestamp === "number" ? timestamp : 0;
  }

  public meanReprojectionErrorPx(): number {
    const persons = this.latestFrame?.persons;
    if (!Array.isArray(persons) || persons.length === 0) return 0;
    let total = 0;
    for (const person of persons) {
      const error = (person as { meanReprojectionErrorPx?: unknown })
        .meanReprojectionErrorPx;
      total += typeof error === "number" ? error : 0;
    }
    return round(total / persons.length);
  }

  public latestFrameJson(): string {
    return this.latestFrameJsonValue;
  }

  public synchronizedSampleJson(): string {
    return this.latestSample ? JSON.stringify(this.latestSample) : "";
  }

  public errorCode(): PoseFusionErrorCode {
    return this.fusionErrorCode;
  }

  public errorMessage(): string {
    return this.fusionErrorMessage;
  }

  private requireStarted(): void {
    if (!this.started) {
      throw new Error("Pose fusion has not been started.");
    }
  }

  /** Expected transient shortage: no throw, no replacement of the last frame. */
  private reject(code: PoseFusionErrorCode, message: string): void {
    this.fusionState = "buffering";
    this.fusionErrorCode = code;
    this.fusionErrorMessage = `${code}: ${message}`;
  }

  private fail(code: Exclude<PoseFusionErrorCode, "">, message: string): never {
    this.fusionState = "error";
    this.fusionErrorCode = code;
    this.fusionErrorMessage = `${code}: ${message}`;
    throw new Error(this.fusionErrorMessage);
  }

  private clearError(): void {
    this.fusionErrorCode = "";
    this.fusionErrorMessage = "";
  }
}

function ringSlots(delayUs: number, jitterWindowUs: number): number {
  const span = delayUs + jitterWindowUs * 2;
  const slots = Math.ceil(span / ASSUMED_MINIMUM_FRAME_INTERVAL_US) + 8;
  return Math.min(Math.max(slots, MIN_RING_SLOTS), MAX_RING_SLOTS);
}

function requireRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `Invalid ${label}: expected ${minimum} to ${maximum}, received ${value}.`,
    );
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
