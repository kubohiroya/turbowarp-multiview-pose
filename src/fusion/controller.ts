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
import {
  DEFAULT_GLOW_STICK_MATCH_OPTIONS,
  GlowStickPalette,
  type GlowStickAssignment,
} from "./glow-stick.js";
import { PersonIdentityRegistry } from "./identity.js";
import {
  DEFAULT_JITTER_BUFFER_OPTIONS,
  MultiCameraJitterBuffer,
  type JitterBufferOptions,
} from "./jitter-buffer.js";
import type { CameraModel, SynchronizedPoseSample } from "./types.js";
import { COCO_17_KEYPOINT_IDS } from "../pose/types.js";
import type { Coco17KeypointId } from "../pose/types.js";

export type PoseFusionState =
  "idle" | "buffering" | "fusing" | "ready" | "error";

export type PoseFusionErrorCode =
  | ""
  | "calibration-invalid"
  | "calibration-mismatch"
  | "performance-dsl-invalid"
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
  private readonly palette = new GlowStickPalette();
  private identifiedPerformers = 0;
  private mirroredViews = 0;
  private jitterOptions: JitterBufferOptions = DEFAULT_JITTER_BUFFER_OPTIONS;
  private geometryOptions: FusionGeometryOptions =
    DEFAULT_FUSION_GEOMETRY_OPTIONS;
  private delayUs = 0;
  private rejectedFrames = 0;
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
    this.rejectedFrames = 0;
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
    this.rejectedFrames = 0;
    this.sequence = 0;
    this.latestFrame = undefined;
    this.latestFrameJsonValue = "";
    this.latestSample = undefined;
    this.identifiedPerformers = 0;
    this.mirroredViews = 0;
    this.started = false;
    this.fusionState = "idle";
    this.clearError();
  }

  /** Releases buffers, calibration profiles, and the glow stick palette. */
  public cleanup(): void {
    this.stop();
    this.models.clear();
    this.palette.clear();
  }

  /**
   * Loads the performer palette from a Performance DSL v1 payload. The DSL owns
   * the colors; the keypoint each performer carries the light at is a
   * fusion-side setting because that contract does not describe it.
   */
  public loadPerformanceDsl(json: string): void {
    const decoded = decodeProtocolJson(json, Date.now());
    if (!decoded.ok || decoded.schema !== "twmp/performance-dsl") {
      const message = decoded.ok
        ? `Expected twmp/performance-dsl, received ${decoded.schema}.`
        : formatProtocolDiagnostic(decoded.diagnostic);
      this.fail("performance-dsl-invalid", message);
    }
    const performers = (
      decoded.value as unknown as {
        performers: Array<{ performerId: string; glowStickColor: string }>;
      }
    ).performers;
    try {
      this.palette.loadPerformers(performers);
    } catch (error) {
      this.fail("performance-dsl-invalid", errorMessage(error));
    }
    this.clearError();
  }

  public setPerformerKeypoint(performerId: string, keypointId: string): void {
    const resolved = COCO_17_KEYPOINT_IDS.find((id) => id === keypointId);
    if (!resolved) {
      this.fail(
        "performance-dsl-invalid",
        `Unknown COCO-17 keypoint: ${keypointId}`,
      );
    }
    try {
      this.palette.setKeypoint(performerId, resolved as Coco17KeypointId);
    } catch (error) {
      this.fail("performance-dsl-invalid", errorMessage(error));
    }
    this.clearError();
  }

  public paletteSize(): number {
    return this.palette.size();
  }

  /** Performers identified by glow stick color in the last fusion. */
  public identifiedPerformerCount(): number {
    return this.identifiedPerformers;
  }

  /** Camera views whose left/right labels the last fusion corrected. */
  public mirrorCorrectedViewCount(): number {
    return this.mirroredViews;
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

  /**
   * Buffers one PoseFrame2D. Malformed or foreign JSON throws; a frame without a
   * matching calibration profile, a duplicate, and a late arrival are counted as
   * dropped so a misconfigured peer cannot break a running project script.
   */
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
    const model = this.models.get(frame.cameraId);
    if (!model) {
      this.drop(
        "unknown-camera",
        `No calibration profile is loaded for camera ${frame.cameraId}.`,
      );
      return;
    }
    const mismatch = describeCalibrationMismatch(frame, model);
    if (mismatch) {
      this.drop("calibration-mismatch", mismatch);
      return;
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
    const resampled = this.buffer.sampleAt(timestampUs);
    // A profile replaced after buffering leaves stale frames behind; they are
    // excluded here until they age out of the ring.
    const sample = {
      timestampUs,
      cameras: resampled.cameras.filter((camera) => {
        const model = this.models.get(camera.cameraId);
        return (
          model !== undefined && !describeCalibrationMismatch(camera, model)
        );
      }),
    };
    this.latestSample = sample;
    if (sample.cameras.length < this.geometryOptions.minCamerasPerPerson) {
      this.reject(
        "insufficient-cameras",
        `Only ${sample.cameras.length} calibrated camera(s) covered ${timestampUs} us.`,
      );
      return false;
    }

    const assignments = new Map<string, Map<string, GlowStickAssignment>>();
    let mirrored = 0;
    if (this.palette.size() > 0) {
      for (const camera of sample.cameras) {
        const assigned = this.palette.assign(
          camera,
          DEFAULT_GLOW_STICK_MATCH_OPTIONS,
        );
        assignments.set(camera.cameraId, assigned);
        for (const assignment of assigned.values()) {
          if (assignment.mirrored) mirrored += 1;
        }
      }
    }

    const persons = fuseSynchronizedSample(
      sample,
      this.models,
      this.geometryOptions,
      assignments,
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
        const personId = person.performerId
          ? this.identities.adopt(
              person.performerId,
              person.members,
              this.sequence,
            )
          : this.identities.resolve(person.members, this.sequence);
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
    this.identifiedPerformers = new Set(
      persons
        .map((person) => person.performerId)
        .filter(
          (performerId): performerId is string => performerId !== undefined,
        ),
    ).size;
    this.mirroredViews = mirrored;
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
    return this.buffer.droppedFrameCount() + this.rejectedFrames;
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

  /** Rejected before buffering: counted as dropped instead of thrown. */
  private drop(code: PoseFusionErrorCode, message: string): void {
    this.rejectedFrames += 1;
    this.fusionErrorCode = code;
    this.fusionErrorMessage = `${code}: ${message}`;
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

/** Rejects frames that a profile cannot describe, instead of fusing them. */
function describeCalibrationMismatch(
  frame: {
    cameraId: string;
    calibrationId: string;
    frameWidth: number;
    frameHeight: number;
  },
  model: CameraModel,
): string | undefined {
  if (frame.calibrationId !== model.calibrationId) {
    return `Camera ${frame.cameraId} reports calibration ${frame.calibrationId} but profile ${model.calibrationId} is loaded.`;
  }
  if (
    frame.frameWidth !== model.imageWidth ||
    frame.frameHeight !== model.imageHeight
  ) {
    return `Camera ${frame.cameraId} reports ${frame.frameWidth}x${frame.frameHeight} but profile ${model.calibrationId} was solved at ${model.imageWidth}x${model.imageHeight}.`;
  }
  return undefined;
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
