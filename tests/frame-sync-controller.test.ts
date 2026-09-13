import { describe, expect, it, vi } from "vitest";
import { FrameSyncPatternController } from "../src/frame-sync/controller.js";
import {
  PATTERN_COLUMNS,
  PATTERN_ROWS,
  PATTERN_STEP_US,
  encodePatternCells,
} from "../src/frame-sync/pattern.js";
import type { LuminanceFrame, PanelRect } from "../src/frame-sync/detector.js";
import type {
  CameraFrameSourcePort,
  CameraLeasePort,
} from "../src/pose/types.js";
import type { CapturedFrame, FramePumpPort } from "../src/frame-sync/types.js";

const WIDTH = 96;
const HEIGHT = 72;
const PANEL: PanelRect = { x: 24, y: 12, width: 48, height: 48 };
const FRAME_STEP_US = 100_000;
const CALIBRATION_SECONDS = 8;

function renderFrame(code: number | undefined): LuminanceFrame {
  const data = new Uint8Array(WIDTH * HEIGHT).fill(12);
  if (code === undefined) return { width: WIDTH, height: HEIGHT, data };
  const cells = encodePatternCells(code);
  const cellWidth = PANEL.width / PATTERN_COLUMNS;
  const cellHeight = PANEL.height / PATTERN_ROWS;
  for (let row = 0; row < PATTERN_ROWS; row += 1) {
    for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
      const value = cells[row * PATTERN_COLUMNS + column] ? 220 : 18;
      const startX = Math.round(PANEL.x + column * cellWidth);
      const startY = Math.round(PANEL.y + row * cellHeight);
      for (let y = startY; y < startY + cellHeight; y += 1) {
        for (let x = startX; x < startX + cellWidth; x += 1) {
          data[y * WIDTH + x] = value;
        }
      }
    }
  }
  return { width: WIDTH, height: HEIGHT, data };
}

function setup(options: { cameraSource?: boolean } = {}) {
  let clockUs = 1_700_000_000_000_000;
  let handler: ((frame: CapturedFrame) => void) | undefined;
  const pump: FramePumpPort = {
    start: vi.fn((next: (frame: CapturedFrame) => void) => {
      handler = next;
    }),
    stop: vi.fn(() => {
      handler = undefined;
    }),
  };
  const frameSource: CameraFrameSourcePort = {
    kind: "video",
    element: {} as HTMLVideoElement,
    width: 1280,
    height: 720,
    mirrored: false,
    deviceId: "device-1",
  };
  const release = vi.fn(async () => undefined);
  const lease: CameraLeasePort = { getFrameSource: () => frameSource, release };
  const acquireCamera = vi.fn(async () => lease);
  const runtime: TurboWarpRuntime =
    options.cameraSource === false
      ? {}
      : { ext_kubohiroyacamerasource: { acquireCamera } };
  const controller = new FrameSyncPatternController({
    runtime,
    timeSource: { nowUs: () => clockUs },
    createFramePump: () => pump,
    // Frames, not timers, drive this controller in tests.
    wait: () => new Promise<void>(() => undefined),
    analysisWidth: WIDTH,
    analysisHeight: HEIGHT,
  });

  return {
    controller,
    pump,
    release,
    acquireCamera,
    now: () => clockUs,
    async settle(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    feed(code: number | undefined, frameAgeUs = 0): void {
      clockUs += FRAME_STEP_US;
      handler?.({ luminance: renderFrame(code), frameAgeUs });
    },
    /** Feeds frames until calibration settles, either way. */
    feedUntilSettled(next: (index: number) => number | undefined): void {
      const limit = (CALIBRATION_SECONDS * 1_000_000) / FRAME_STEP_US + 10;
      for (let index = 0; index < limit; index += 1) {
        if (controller.state() === "ready" || controller.state() === "error") {
          return;
        }
        this.feed(next(index));
      }
    },
  };
}

function alternatingPattern(index: number): number {
  return index % 2 === 0 ? 0 : 4095;
}

describe("FrameSyncPatternController", () => {
  it("calibrates against the projected pattern and then decodes frames", async () => {
    const harness = setup();
    const started = harness.controller.start({
      cameraId: "camera-1",
      calibrationSeconds: CALIBRATION_SECONDS,
    });
    await harness.settle();
    expect(harness.controller.state()).toBe("calibrating");
    harness.feedUntilSettled(alternatingPattern);
    await started;

    expect(harness.controller.state()).toBe("ready");
    expect(harness.controller.errorCode()).toBe("");
    expect(harness.controller.cameraId()).toBe("camera-1");
    expect(harness.acquireCamera).toHaveBeenCalledWith({
      owner: "frame-sync",
      cameraId: "camera-1",
    });

    harness.feed(2024, 13_000);
    const timestampUs = harness.now();
    expect(harness.controller.pendingObservations()).toBe(1);
    expect(harness.controller.takeObservation()).toEqual({
      frameTimestampUs: timestampUs,
      frameAgeUs: 13_000,
      patternTimestampUs: 2024 * PATTERN_STEP_US,
    });
    expect(harness.controller.pendingObservations()).toBe(0);
    expect(harness.controller.decodeRate()).toBe(1);
  });

  it("counts frames it could not read in the decode rate", async () => {
    const harness = setup();
    const started = harness.controller.start({
      cameraId: "camera-1",
      calibrationSeconds: CALIBRATION_SECONDS,
    });
    await harness.settle();
    harness.feedUntilSettled(alternatingPattern);
    await started;

    harness.feed(2024);
    harness.feed(undefined);
    expect(harness.controller.decodeRate()).toBe(0.5);
    expect(harness.controller.pendingObservations()).toBe(1);
  });

  it("reports an unreadable room instead of measuring", async () => {
    const harness = setup();
    const started = harness.controller.start({
      cameraId: "camera-1",
      calibrationSeconds: CALIBRATION_SECONDS,
    });
    await harness.settle();
    harness.feedUntilSettled(() => undefined);

    await expect(started).rejects.toThrow("No projected frame sync pattern");
    expect(harness.controller.state()).toBe("error");
    expect(harness.controller.errorCode()).toBe("panel-not-found");
    expect(harness.pump.stop).toHaveBeenCalled();
    expect(harness.release).toHaveBeenCalled();
  });

  it("rejects a window too short for every pattern cell to change", async () => {
    const harness = setup();
    // The slowest cell toggles once per 2048 ms and the levels phase is 40% of
    // the window, so 5 seconds cannot see every cell at both levels.
    await expect(
      harness.controller.start({
        cameraId: "camera-1",
        calibrationSeconds: 5,
      }),
    ).rejects.toThrow("every pattern cell changes at least once");
    expect(harness.controller.errorCode()).toBe("invalid-duration");
    expect(harness.acquireCamera).not.toHaveBeenCalled();
  });

  it("does not report a camera fault when it is stopped while calibrating", async () => {
    const harness = setup();
    const started = harness.controller.start({
      cameraId: "camera-1",
      calibrationSeconds: CALIBRATION_SECONDS,
    });
    await harness.settle();
    harness.feed(0);
    harness.feed(4095);
    expect(harness.controller.state()).toBe("calibrating");

    await harness.controller.stop();
    await started;

    expect(harness.controller.state()).toBe("idle");
    expect(harness.controller.errorCode()).toBe("");
    expect(harness.controller.errorMessage()).toBe("");
    expect(harness.release).toHaveBeenCalled();
  });

  it("reports a missing camera source", async () => {
    const harness = setup({ cameraSource: false });
    await expect(
      harness.controller.start({
        cameraId: "camera-1",
        calibrationSeconds: CALIBRATION_SECONDS,
      }),
    ).rejects.toThrow("Camera Source is not loaded.");
    expect(harness.controller.errorCode()).toBe("camera-unavailable");
  });

  it("releases the camera when it stops", async () => {
    const harness = setup();
    const started = harness.controller.start({
      cameraId: "camera-1",
      calibrationSeconds: CALIBRATION_SECONDS,
    });
    await harness.settle();
    harness.feedUntilSettled(alternatingPattern);
    await started;

    await harness.controller.stop();
    expect(harness.release).toHaveBeenCalled();
    expect(harness.pump.stop).toHaveBeenCalled();
    expect(harness.controller.state()).toBe("idle");
    expect(harness.controller.pendingObservations()).toBe(0);
  });
});
