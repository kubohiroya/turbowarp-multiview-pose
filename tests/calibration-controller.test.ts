import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { CameraCalibrationController } from "../src/calibration/controller.js";
import type {
  CalibrationBackendPort,
  CalibrationSample,
} from "../src/calibration/types.js";
import type {
  CameraFrameSourcePort,
  CameraLeasePort,
} from "../src/pose/types.js";

const startOptions = {
  cameraId: "camera-1",
  calibrationId: "calibration-1",
  board: { columns: 9, rows: 6, squareSizeMeters: 0.025 },
  maximumReprojectionErrorPx: 1.5,
};

function setup() {
  const frame = {
    kind: "video",
    element: {} as HTMLVideoElement,
    width: 800,
    height: 600,
    mirrored: false,
    deviceId: "device-1",
  } satisfies CameraFrameSourcePort;
  const release = vi.fn(async () => undefined);
  const lease: CameraLeasePort = {
    getFrameSource: vi.fn(() => frame),
    release,
  };
  let sampleIndex = 0;
  const captureSample = vi.fn(
    async (): Promise<CalibrationSample | undefined> => sample(sampleIndex++),
  );
  const solve = vi.fn(async () => ({
    intrinsicMatrix: [700, 0, 400, 0, 700, 300, 0, 0, 1],
    distortionCoefficients: [0.01, -0.02, 0, 0, 0],
    worldFromCameraMatrix: [1, 0, 0, -1, 0, 1, 0, -2, 0, 0, 1, -3, 0, 0, 0, 1],
    reprojectionErrorPx: 0.75,
  }));
  const backend: CalibrationBackendPort = {
    name: "mock-calibration-backend",
    captureSample,
    solve,
  };
  const acquireCamera = vi.fn(async () => lease);
  const runtime: TurboWarpRuntime = {
    ext_kubohiroyacamerasource: { acquireCamera },
  };
  const controller = new CameraCalibrationController({
    runtime,
    backend,
    nowMilliseconds: () => Date.parse("2026-09-13T12:00:00Z"),
  });
  return {
    controller,
    runtime,
    frame,
    lease,
    release,
    acquireCamera,
    backend,
    captureSample,
    solve,
  };
}

describe("CameraCalibrationController", () => {
  it("completes the intrinsic and world-extrinsic workflow at the fixed real resolution", async () => {
    const { controller, acquireCamera, solve, release } = setup();
    await controller.start(startOptions);
    expect(acquireCamera).toHaveBeenCalledWith({
      owner: "turbowarp-realtime-motion-capture-calibration",
      cameraId: "camera-1",
    });
    for (let index = 0; index < 8; index += 1) {
      await controller.addSample();
    }
    expect(controller.sampleCount()).toBe(8);
    expect(controller.latestSampleQuality()).toBe(0.8);
    await controller.solve();
    expect(solve).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ quality: 0.8 })]),
      startOptions.board,
      800,
      600,
    );
    expect(controller.state()).toBe("solved");
    expect(controller.latestReprojectionError()).toBe(0.75);
    expect(release).toHaveBeenCalledOnce();
    expect(JSON.parse(controller.profileJson())).toEqual({
      schema: "twrmc/camera-calibration",
      version: 1,
      calibrationId: "calibration-1",
      cameraId: "camera-1",
      imageWidth: 800,
      imageHeight: 600,
      intrinsicMatrix: [700, 0, 400, 0, 700, 300, 0, 0, 1],
      distortionCoefficients: [0.01, -0.02, 0, 0, 0],
      worldFromCameraMatrix: [
        1, 0, 0, -1, 0, 1, 0, -2, 0, 0, 1, -3, 0, 0, 0, 1,
      ],
      worldUnit: "meter",
      calibratedAt: "2026-09-13T12:00:00.000Z",
    });
  });

  it("rejects insufficient, low-quality, missing, and duplicate samples distinctly", async () => {
    const insufficient = setup();
    await insufficient.controller.start(startOptions);
    expect(() => insufficient.controller.solve()).toThrow(
      /sample-insufficient/u,
    );

    const missing = setup();
    missing.captureSample.mockResolvedValue(undefined);
    await missing.controller.start(startOptions);
    await expect(missing.controller.addSample()).rejects.toThrow(
      /board-not-found/u,
    );

    const lowQuality = setup();
    lowQuality.captureSample.mockResolvedValue({ ...sample(0), quality: 0.1 });
    await lowQuality.controller.start(startOptions);
    await expect(lowQuality.controller.addSample()).rejects.toThrow(
      /sample-low-quality/u,
    );

    const duplicate = setup();
    duplicate.captureSample.mockResolvedValue(sample(0));
    await duplicate.controller.start(startOptions);
    await duplicate.controller.addSample();
    await expect(duplicate.controller.addSample()).rejects.toThrow(
      /sample-too-similar/u,
    );
    expect(duplicate.controller.errorCode()).toBe("sample-too-similar");
  });

  it("rejects camera resolution changes and excessive reprojection error", async () => {
    const resolution = setup();
    await resolution.controller.start(startOptions);
    resolution.frame.width = 1280;
    await expect(resolution.controller.addSample()).rejects.toThrow(
      /resolution-mismatch/u,
    );

    const reprojection = setup();
    reprojection.solve.mockResolvedValue({
      intrinsicMatrix: [700, 0, 400, 0, 700, 300, 0, 0, 1],
      distortionCoefficients: [],
      worldFromCameraMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      reprojectionErrorPx: 2,
    });
    await reprojection.controller.start(startOptions);
    for (let index = 0; index < 8; index += 1) {
      await reprojection.controller.addSample();
    }
    await expect(reprojection.controller.solve()).rejects.toThrow(
      /reprojection-too-high/u,
    );
    expect(reprojection.controller.state()).toBe("ready");
    expect(reprojection.controller.profileJson()).toBe("");
  });

  it("coalesces sampling and releases the lease while cancelling", async () => {
    const { controller, captureSample, release } = setup();
    let finish: ((value: CalibrationSample) => void) | undefined;
    captureSample.mockImplementation(
      () =>
        new Promise<CalibrationSample>((resolve) => {
          finish = resolve;
        }),
    );
    await controller.start(startOptions);
    const first = controller.addSample();
    const second = controller.addSample();
    expect(first).toBe(second);
    expect(captureSample).toHaveBeenCalledOnce();
    finish?.(sample(0));
    await first;
    await controller.cancel();
    expect(release).toHaveBeenCalledOnce();
    expect(controller.sampleCount()).toBe(0);
    expect(controller.state()).toBe("idle");
  });

  it("imports, exports, validates, and cleans exact v1 fixtures without credentials", async () => {
    const { controller } = setup();
    const valid = await fixture("valid-camera-calibration-v1.json");
    const invalidVersion = await fixture("invalid-camera-calibration-v2.json");
    const credential = await fixture(
      "invalid-camera-calibration-with-credential.json",
    );
    expect(controller.validateProfile(valid)).toBe(true);
    await controller.importProfile(valid);
    expect(JSON.parse(controller.profileJson())).toEqual(JSON.parse(valid));
    expect(controller.validateProfile(invalidVersion)).toBe(false);
    expect(controller.errorCode()).toBe("invalid-calibration");
    expect(controller.validateProfile(credential)).toBe(false);
    expect(controller.errorCode()).toBe("credential-forbidden");
    expect(controller.profileJson()).toBe(valid.replaceAll(/\s+/gu, ""));
    await controller.cancel();
    expect(controller.profileJson()).not.toBe("");
    await controller.cleanup();
    expect(controller.profileJson()).toBe("");
  });

  it("distinguishes invalid board, unavailable camera, and ended camera", async () => {
    const invalid = setup();
    await expect(
      invalid.controller.start({
        ...startOptions,
        board: { ...startOptions.board, columns: 2 },
      }),
    ).rejects.toThrow(/invalid-board/u);
    expect(invalid.controller.errorCode()).toBe("invalid-board");

    const unavailable = setup();
    delete unavailable.runtime.ext_kubohiroyacamerasource;
    await expect(unavailable.controller.start(startOptions)).rejects.toThrow(
      /camera-unavailable/u,
    );

    const ended = setup();
    ended.lease.getFrameSource = vi.fn(() => {
      throw new Error("ended");
    });
    await expect(ended.controller.start(startOptions)).rejects.toThrow(
      /camera-ended/u,
    );
    expect(ended.release).toHaveBeenCalledOnce();
  });
});

function sample(offset: number): CalibrationSample {
  return {
    corners: Array.from({ length: 54 }, (_, index) => ({
      x: 100 + (index % 9) * 40 + offset * 30,
      y: 100 + Math.floor(index / 9) * 40,
    })),
    quality: 0.8,
    coverage: 0.25,
    sharpness: 120,
  };
}

async function fixture(name: string): Promise<string> {
  return readFile(
    new URL(`fixtures/calibration/${name}`, import.meta.url),
    "utf8",
  );
}
