import { describe, expect, it } from "vitest";
import {
  createCameraModel,
  meanReprojectionError,
  normalizedFromPixel,
  pixelFromNormalized,
  projectPoint,
  triangulate,
} from "../src/fusion/geometry.js";
import type { KeypointObservation, Vector3 } from "../src/fusion/types.js";
import { lookAtCalibration } from "./fusion-fixtures.js";

function observe(
  calibration: ReturnType<typeof lookAtCalibration>,
  point: Vector3,
  score = 0.9,
): KeypointObservation {
  const model = createCameraModel(calibration);
  const pixel = projectPoint(model, point);
  if (!pixel) throw new Error("point is behind the camera");
  const normalized = normalizedFromPixel(model, pixel.x, pixel.y);
  return {
    model,
    x: normalized.x,
    y: normalized.y,
    pixelX: pixel.x,
    pixelY: pixel.y,
    score,
  };
}

describe("fusion geometry", () => {
  it("projects through the inverted worldFromCameraMatrix", () => {
    const calibration = lookAtCalibration(
      "camera-1",
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
    );
    const model = createCameraModel(calibration);
    const projected = projectPoint(model, { x: 1, y: 0, z: 9 });
    expect(projected?.x).toBeCloseTo(1280 / 2 - 100, 6);
    expect(projected?.y).toBeCloseTo(720 / 2, 6);
    expect(projectPoint(model, { x: 0, y: 0, z: -1 })).toBeUndefined();
  });

  it("round-trips the OpenCV rational distortion model", () => {
    const calibration = lookAtCalibration(
      "camera-1",
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      [-0.21, 0.043, 0.0012, -0.0009, 0.0007, 0.001, -0.0004, 0.0002],
    );
    const model = createCameraModel(calibration);
    for (const [x, y] of [
      [0.02, -0.31],
      [-0.44, 0.18],
      [0.35, 0.4],
    ] as const) {
      const pixel = pixelFromNormalized(model, x, y);
      const recovered = normalizedFromPixel(model, pixel.x, pixel.y);
      expect(recovered.x).toBeCloseTo(x, 9);
      expect(recovered.y).toBeCloseTo(y, 9);
    }
  });

  it("triangulates a world point from three calibrated views", () => {
    const point = { x: 0.4, y: 1.35, z: -0.2 };
    const observations = [
      observe(lookAtCalibration("camera-1", { x: 3, y: 1.6, z: 3 }), point),
      observe(
        lookAtCalibration("camera-2", { x: -3.2, y: 1.4, z: 2.6 }),
        point,
      ),
      observe(lookAtCalibration("camera-3", { x: 0.1, y: 2.6, z: -4 }), point),
    ];
    const fused = triangulate(observations);
    expect(fused?.x).toBeCloseTo(point.x, 6);
    expect(fused?.y).toBeCloseTo(point.y, 6);
    expect(fused?.z).toBeCloseTo(point.z, 6);
    expect(meanReprojectionError(fused ?? point, observations)).toBeLessThan(
      1e-6,
    );
  });

  it("weights a noisy low-score view less than confident views", () => {
    const point = { x: 0, y: 1.2, z: 0 };
    const confident = [
      observe(
        lookAtCalibration("camera-1", { x: 3, y: 1.6, z: 3 }),
        point,
        0.95,
      ),
      observe(
        lookAtCalibration("camera-2", { x: -3, y: 1.6, z: 3 }),
        point,
        0.95,
      ),
    ];
    const noisy = observe(
      lookAtCalibration("camera-3", { x: 0, y: 2.4, z: -3.5 }),
      { x: 0.25, y: 1.2, z: 0 },
      0.05,
    );
    const weighted = triangulate([...confident, noisy]);
    const unweighted = triangulate([...confident, { ...noisy, score: 0.95 }]);
    expect(Math.abs((weighted?.x ?? 1) - point.x)).toBeLessThan(
      Math.abs((unweighted?.x ?? 1) - point.x),
    );
  });

  it("rejects a single view and degenerate calibration matrices", () => {
    const calibration = lookAtCalibration("camera-1", { x: 0, y: 1.5, z: 3 });
    expect(
      triangulate([observe(calibration, { x: 0, y: 1, z: 0 })]),
    ).toBeUndefined();

    const mirrored = lookAtCalibration("camera-2", { x: 1, y: 1.5, z: 3 });
    mirrored.worldFromCameraMatrix = [
      ...mirrored.worldFromCameraMatrix.slice(0, 16),
    ];
    mirrored.worldFromCameraMatrix[0] = -(
      mirrored.worldFromCameraMatrix[0] ?? 0
    );
    mirrored.worldFromCameraMatrix[4] = -(
      mirrored.worldFromCameraMatrix[4] ?? 0
    );
    mirrored.worldFromCameraMatrix[8] = -(
      mirrored.worldFromCameraMatrix[8] ?? 0
    );
    expect(() => createCameraModel(mirrored)).toThrow(/right-handed/u);

    const skewed = lookAtCalibration("camera-3", { x: 2, y: 1.5, z: 3 });
    skewed.intrinsicMatrix = [0, 0, 640, 0, 900, 360, 0, 0, 1];
    expect(() => createCameraModel(skewed)).toThrow(/focal lengths/u);

    const unsupported = lookAtCalibration("camera-4", { x: 2, y: 1.5, z: 3 });
    unsupported.distortionCoefficients = [0.1, 0.2, 0.3];
    expect(() => createCameraModel(unsupported)).toThrow(/distortion/u);
  });
});
