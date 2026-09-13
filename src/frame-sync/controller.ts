import type { CameraLeasePort, CameraSourcePort } from "../pose/types.js";
import {
  CellLevels,
  PanelRangeAccumulator,
  patternCellRects,
  sampleCells,
  type PanelRect,
} from "./detector.js";
import { patternTimestampUs } from "./pattern.js";
import type {
  CapturedFrame,
  FramePumpPort,
  FrameSyncObservation,
  TimeSourcePort,
} from "./types.js";

export type FrameSyncState =
  "idle" | "acquiring-camera" | "calibrating" | "ready" | "error";

export type FrameSyncErrorCode =
  | ""
  | "invalid-duration"
  | "camera-unavailable"
  | "camera-ended"
  | "panel-not-found"
  | "low-contrast"
  | "decode-unstable";

export interface FrameSyncStartOptions {
  cameraId: string;
  calibrationSeconds: number;
}

export interface FrameSyncControllerOptions {
  runtime: TurboWarpRuntime;
  timeSource: TimeSourcePort;
  createFramePump: (lease: CameraLeasePort) => FramePumpPort;
  wait?: (milliseconds: number) => Promise<void>;
  analysisWidth?: number;
  analysisHeight?: number;
  observationLimit?: number;
  minimumDecodeRate?: number;
  minimumContrast?: number;
}

type CalibrationPhase = "range" | "levels";

interface Calibration {
  phase: CalibrationPhase;
  rangeDeadlineUs: number;
  levelsDeadlineUs: number;
  range: PanelRangeAccumulator;
  levels: CellLevels;
  rects: PanelRect[];
  attempts: number;
  decodes: number;
  settle: (error?: Error) => void;
}

const DEFAULT_ANALYSIS_WIDTH = 240;
const DEFAULT_ANALYSIS_HEIGHT = 180;
const DEFAULT_OBSERVATION_LIMIT = 600;
const DEFAULT_MINIMUM_DECODE_RATE = 0.2;
const DEFAULT_MINIMUM_CONTRAST = 24;
const DECODE_RATE_WINDOW = 120;
const RANGE_PHASE_SHARE = 0.6;
const MINIMUM_CALIBRATION_SECONDS = 1;
const MAXIMUM_CALIBRATION_SECONDS = 60;

/**
 * Decodes the projected frame sync pattern out of one camera.
 *
 * Calibration runs in two phases against the live pattern. The first watches
 * which pixels change to locate the panel; the second learns the light and dark
 * level of every cell and checks that readings decode often enough to be worth
 * measuring. Both phases end on the shared clock, so a stalled camera never
 * leaves the controller waiting on a frame that will not arrive.
 */
export class FrameSyncPatternController {
  private readonly runtime: TurboWarpRuntime;
  private readonly timeSource: TimeSourcePort;
  private readonly createFramePump: (lease: CameraLeasePort) => FramePumpPort;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly analysisWidth: number;
  private readonly analysisHeight: number;
  private readonly observationLimit: number;
  private readonly minimumDecodeRate: number;
  private readonly minimumContrast: number;
  private readonly observations: FrameSyncObservation[] = [];
  private readonly recentDecodes: boolean[] = [];
  private lease: CameraLeasePort | undefined;
  private pump: FramePumpPort | undefined;
  private levels: CellLevels | undefined;
  private rects: PanelRect[] = [];
  private calibration: Calibration | undefined;
  private observation: FrameSyncObservation | undefined;
  private pipelineState: FrameSyncState = "idle";
  private code: FrameSyncErrorCode = "";
  private message = "";
  private activeCameraId = "";

  public constructor(options: FrameSyncControllerOptions) {
    this.runtime = options.runtime;
    this.timeSource = options.timeSource;
    this.createFramePump = options.createFramePump;
    this.wait = options.wait ?? defaultWait;
    this.analysisWidth = options.analysisWidth ?? DEFAULT_ANALYSIS_WIDTH;
    this.analysisHeight = options.analysisHeight ?? DEFAULT_ANALYSIS_HEIGHT;
    this.observationLimit =
      options.observationLimit ?? DEFAULT_OBSERVATION_LIMIT;
    this.minimumDecodeRate =
      options.minimumDecodeRate ?? DEFAULT_MINIMUM_DECODE_RATE;
    this.minimumContrast = options.minimumContrast ?? DEFAULT_MINIMUM_CONTRAST;
  }

  public analysisSize(): { width: number; height: number } {
    return { width: this.analysisWidth, height: this.analysisHeight };
  }

  public state(): FrameSyncState {
    return this.pipelineState;
  }

  public errorCode(): FrameSyncErrorCode {
    return this.code;
  }

  public errorMessage(): string {
    return this.message;
  }

  public cameraId(): string {
    return this.activeCameraId;
  }

  public decodeRate(): number {
    if (this.recentDecodes.length === 0) return 0;
    const decoded = this.recentDecodes.filter((value) => value).length;
    return decoded / this.recentDecodes.length;
  }

  public pendingObservations(): number {
    return this.observations.length;
  }

  public takeObservation(): FrameSyncObservation | undefined {
    this.observation = this.observations.shift();
    return this.observation;
  }

  public currentObservation(): FrameSyncObservation | undefined {
    return this.observation;
  }

  public async start(options: FrameSyncStartOptions): Promise<void> {
    await this.stop();
    const cameraId = options.cameraId.trim();
    const seconds = options.calibrationSeconds;
    if (!cameraId) {
      this.fail(
        "camera-unavailable",
        new Error("Camera ID must not be empty."),
      );
    }
    if (
      !Number.isFinite(seconds) ||
      seconds < MINIMUM_CALIBRATION_SECONDS ||
      seconds > MAXIMUM_CALIBRATION_SECONDS
    ) {
      this.fail(
        "invalid-duration",
        new Error(
          `Calibration must run between ${MINIMUM_CALIBRATION_SECONDS} and ${MAXIMUM_CALIBRATION_SECONDS} seconds.`,
        ),
      );
    }
    this.pipelineState = "acquiring-camera";
    this.code = "";
    this.message = "";
    let lease: CameraLeasePort;
    try {
      lease = await requireCameraSource(this.runtime).acquireCamera({
        owner: "frame-sync",
        cameraId,
      });
    } catch (error) {
      this.fail("camera-unavailable", error);
    }
    this.lease = lease;
    this.activeCameraId = cameraId;
    const pump = this.createFramePump(lease);
    this.pump = pump;
    pump.start((frame) => this.consume(frame));
    await this.runCalibration(seconds);
  }

  public async recalibrate(seconds: number): Promise<void> {
    if (!this.pump) {
      this.fail(
        "camera-unavailable",
        new Error("Start the frame sync decoder before calibrating."),
      );
    }
    await this.runCalibration(seconds);
  }

  public async stop(): Promise<void> {
    this.calibration?.settle(new Error("Frame sync decoding stopped."));
    this.calibration = undefined;
    this.pump?.stop();
    this.pump = undefined;
    const lease = this.lease;
    this.lease = undefined;
    this.levels = undefined;
    this.rects = [];
    this.observations.length = 0;
    this.recentDecodes.length = 0;
    this.observation = undefined;
    this.activeCameraId = "";
    if (this.pipelineState !== "error") {
      this.pipelineState = "idle";
      this.code = "";
      this.message = "";
    }
    if (lease) await lease.release().catch(() => undefined);
  }

  private async runCalibration(seconds: number): Promise<void> {
    if (
      !Number.isFinite(seconds) ||
      seconds < MINIMUM_CALIBRATION_SECONDS ||
      seconds > MAXIMUM_CALIBRATION_SECONDS
    ) {
      this.fail(
        "invalid-duration",
        new Error(
          `Calibration must run between ${MINIMUM_CALIBRATION_SECONDS} and ${MAXIMUM_CALIBRATION_SECONDS} seconds.`,
        ),
      );
    }
    this.pipelineState = "calibrating";
    this.code = "";
    this.message = "";
    this.levels = undefined;
    this.rects = [];
    this.observations.length = 0;
    this.recentDecodes.length = 0;
    const startUs = this.timeSource.nowUs();
    const totalUs = seconds * 1_000_000;
    const finished = new Promise<void>((resolve, reject) => {
      this.calibration = {
        phase: "range",
        rangeDeadlineUs: startUs + totalUs * RANGE_PHASE_SHARE,
        levelsDeadlineUs: startUs + totalUs,
        range: new PanelRangeAccumulator(
          this.analysisWidth,
          this.analysisHeight,
        ),
        levels: new CellLevels(),
        rects: [],
        attempts: 0,
        decodes: 0,
        settle: (error) => {
          this.calibration = undefined;
          if (error) reject(error);
          else resolve();
        },
      };
    });
    const pending = this.calibration;
    void this.wait(seconds * 1000 + 2000).then(() => {
      if (this.calibration !== pending) return;
      pending?.settle(
        new Error("The camera stopped delivering frames while calibrating."),
      );
    });
    try {
      await finished;
    } catch (error) {
      this.fail(this.code || "camera-ended", error);
    }
  }

  private consume(frame: CapturedFrame): void {
    const calibration = this.calibration;
    if (calibration) {
      this.calibrateWith(calibration, frame);
      return;
    }
    if (this.pipelineState !== "ready") return;
    const levels = this.levels;
    if (!levels) return;
    const frameTimestampUs = this.timeSource.nowUs();
    const code = levels.decode(sampleCells(frame.luminance, this.rects));
    this.recordDecodeAttempt(code !== undefined);
    if (code === undefined) return;
    this.observations.push({
      frameTimestampUs,
      frameAgeUs: frame.frameAgeUs,
      patternTimestampUs: patternTimestampUs(code),
    });
    while (this.observations.length > this.observationLimit) {
      this.observations.shift();
    }
  }

  private calibrateWith(calibration: Calibration, frame: CapturedFrame): void {
    const now = this.timeSource.nowUs();
    if (calibration.phase === "range") {
      calibration.range.add(frame.luminance);
      if (now < calibration.rangeDeadlineUs) return;
      const panel = calibration.range.detect();
      if (!panel) {
        this.code = "panel-not-found";
        calibration.settle(
          new Error(
            "No projected frame sync pattern was found in the camera image.",
          ),
        );
        return;
      }
      calibration.rects = patternCellRects(panel);
      calibration.phase = "levels";
      return;
    }
    const samples = sampleCells(frame.luminance, calibration.rects);
    calibration.levels.add(samples);
    calibration.attempts += 1;
    if (calibration.levels.decode(samples) !== undefined) {
      calibration.decodes += 1;
    }
    if (now < calibration.levelsDeadlineUs) return;
    if (calibration.levels.contrast() < this.minimumContrast) {
      this.code = "low-contrast";
      calibration.settle(
        new Error(
          "The projected pattern is too dim or too washed out to read.",
        ),
      );
      return;
    }
    const rate =
      calibration.attempts === 0
        ? 0
        : calibration.decodes / calibration.attempts;
    if (rate < this.minimumDecodeRate) {
      this.code = "decode-unstable";
      calibration.settle(
        new Error(
          `Only ${Math.round(rate * 100)}% of the frames decoded during calibration.`,
        ),
      );
      return;
    }
    this.levels = calibration.levels;
    this.rects = calibration.rects;
    this.recentDecodes.length = 0;
    this.pipelineState = "ready";
    this.code = "";
    this.message = "";
    calibration.settle();
  }

  private recordDecodeAttempt(decoded: boolean): void {
    this.recentDecodes.push(decoded);
    while (this.recentDecodes.length > DECODE_RATE_WINDOW) {
      this.recentDecodes.shift();
    }
  }

  private fail(code: FrameSyncErrorCode, error: unknown): never {
    this.pipelineState = "error";
    this.code = code;
    this.message = error instanceof Error ? error.message : String(error);
    this.pump?.stop();
    this.pump = undefined;
    const lease = this.lease;
    this.lease = undefined;
    if (lease) void lease.release().catch(() => undefined);
    throw error instanceof Error ? error : new Error(this.message);
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
    throw new Error("Camera Source is not loaded.");
  }
  return candidate as unknown as CameraSourcePort;
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
