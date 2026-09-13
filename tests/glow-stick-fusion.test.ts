import { describe, expect, it } from "vitest";
import { PoseFusionController } from "../src/fusion/controller.js";
import type { CameraCalibrationV1 } from "../src/calibration/types.js";
import type { Vector3 } from "../src/fusion/types.js";
import type { PoseMarkerV2 } from "../src/pose/types.js";
import {
  lookAtCalibration,
  performanceDsl,
  poseFrame2DV2,
  projectPersonV2,
  skeleton,
} from "./fusion-fixtures.js";

const calibrations: CameraCalibrationV1[] = [
  lookAtCalibration("camera-1", { x: 3.4, y: 1.7, z: 3.1 }),
  lookAtCalibration("camera-2", { x: -3.2, y: 1.8, z: 2.9 }),
  // Behind the performers, where MoveNet reads a back view as a front view.
  lookAtCalibration("camera-3", { x: 0.2, y: 2.2, z: -3.8 }),
];

const performers = [
  { performerId: "actor-1", glowStickColor: "#00FFAA" },
  { performerId: "actor-2", glowStickColor: "#FF3300" },
];

const origins: Vector3[] = [
  { x: -0.7, y: 0, z: 0.2 },
  { x: 0.9, y: 0, z: -0.3 },
];

function marker(colorHex: string, keypointId: PoseMarkerV2["keypointId"]) {
  return [{ keypointId, colorHex, coverage: 0.4 }];
}

/**
 * camera-3 sees both performers from behind: its keypoint labels are swapped,
 * so the physical right hand carrying the light is reported as the left wrist.
 */
function feed(controller: PoseFusionController, timestampUs: number): void {
  for (const calibration of calibrations) {
    const mirrored = calibration.cameraId === "camera-3";
    const persons = origins.map((origin, index) =>
      projectPersonV2(calibration, `movenet-${index + 1}`, skeleton(origin), {
        mirrored,
        markers: marker(
          performers[index]?.glowStickColor ?? "#FFFFFF",
          mirrored ? "left_wrist" : "right_wrist",
        ),
      }),
    );
    controller.ingestFrame(
      JSON.stringify(poseFrame2DV2(calibration.cameraId, timestampUs, persons)),
    );
  }
}

function started(withPalette: boolean): PoseFusionController {
  const controller = new PoseFusionController();
  for (const calibration of calibrations) {
    controller.loadCalibration(JSON.stringify(calibration));
  }
  if (withPalette) {
    controller.loadPerformanceDsl(performanceDsl(performers));
    for (const performer of performers) {
      controller.setPerformerKeypoint(performer.performerId, "right_wrist");
    }
  }
  controller.start({
    delayMilliseconds: 0,
    jitterMilliseconds: 80,
    minKeypointScore: 0.3,
  });
  return controller;
}

interface FusedPerson3D {
  personId: string;
  meanReprojectionErrorPx: number;
  cameraIds: string[];
  keypoints: Array<{
    id: string;
    x: number;
    y: number;
    z: number;
    score: number;
  }>;
}

function fused(controller: PoseFusionController): FusedPerson3D[] {
  return (
    JSON.parse(controller.latestFrameJson()) as { persons: FusedPerson3D[] }
  ).persons;
}

function wristError(person: FusedPerson3D, truth: readonly Vector3[]): number {
  const index = 10; // right_wrist in COCO-17 order
  const keypoint = person.keypoints[index];
  const expected = truth[index];
  if (!keypoint || !expected) return Number.POSITIVE_INFINITY;
  return Math.hypot(
    keypoint.x - expected.x,
    keypoint.y - expected.y,
    keypoint.z - expected.z,
  );
}

describe("glow stick assisted fusion", () => {
  it("identifies performers by color and names them in PoseFrame3D", () => {
    const controller = started(true);
    feed(controller, 100_000);
    expect(controller.paletteSize()).toBe(2);
    expect(controller.fuseAt(100_000)).toBe(true);
    expect(controller.identifiedPerformerCount()).toBe(2);
    expect(
      fused(controller)
        .map((person) => person.personId)
        .sort(),
    ).toEqual(["actor-1", "actor-2"]);
    for (const person of fused(controller)) {
      expect(person.cameraIds).toEqual(["camera-1", "camera-2", "camera-3"]);
    }
  });

  it("corrects the back view and recovers the true right wrist", () => {
    const controller = started(true);
    feed(controller, 100_000);
    controller.fuseAt(100_000);
    // Both performers are mirrored in camera-3 only.
    expect(controller.mirrorCorrectedViewCount()).toBe(2);

    for (const [index, person] of fused(controller).entries()) {
      const truth = skeleton(
        origins[person.personId === "actor-1" ? 0 : 1] ?? origins[index]!,
      );
      expect(wristError(person, truth)).toBeLessThan(0.01);
      expect(person.meanReprojectionErrorPx).toBeLessThan(1);
    }
  });

  it("leaves the back view uncorrected when no palette is loaded", () => {
    const withMarkers = started(true);
    feed(withMarkers, 100_000);
    withMarkers.fuseAt(100_000);

    const without = started(false);
    feed(without, 100_000);
    without.fuseAt(100_000);
    expect(without.identifiedPerformerCount()).toBe(0);
    expect(without.mirrorCorrectedViewCount()).toBe(0);

    const corrected = fused(withMarkers)[0];
    const uncorrected = fused(without)[0];
    expect(corrected && uncorrected).toBeTruthy();
    const truth = skeleton(origins[0] ?? { x: 0, y: 0, z: 0 });
    // Without the marker hint, camera-3's swapped labels either drag the wrist
    // away from the truth or leave it unfused with a zero score.
    const correctedError = wristError(corrected!, truth);
    const uncorrectedError = wristError(uncorrected!, truth);
    expect(correctedError).toBeLessThan(0.01);
    expect(
      uncorrectedError > 0.05 || (uncorrected?.keypoints[10]?.score ?? 0) === 0,
    ).toBe(true);
    expect(uncorrected?.personId).toMatch(/^person-\d+$/u);
  });

  it("keeps performer identity stable across fusions and rejects a foreign payload", () => {
    const controller = started(true);
    feed(controller, 100_000);
    controller.fuseAt(100_000);
    const first = fused(controller).map((person) => person.personId);
    feed(controller, 133_000);
    controller.fuseAt(133_000);
    expect(fused(controller).map((person) => person.personId)).toEqual(first);

    expect(() =>
      controller.loadPerformanceDsl(JSON.stringify(calibrations[0])),
    ).toThrow(/performance-dsl-invalid/u);
    expect(() =>
      controller.setPerformerKeypoint("actor-1", "right_hand"),
    ).toThrow(/Unknown COCO-17/u);
    expect(() =>
      controller.setPerformerKeypoint("actor-9", "right_wrist"),
    ).toThrow(/not in the loaded palette/u);
  });
});
