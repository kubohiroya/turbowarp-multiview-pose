import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { PoseFusionController } from "../src/fusion/controller.js";
import { PoseFrame3DSchema } from "../src/protocol/schemas.js";
import type { CameraCalibrationV1 } from "../src/calibration/types.js";
import type { Vector3 } from "../src/fusion/types.js";
import type { PoseFrame2DPersonV1 } from "../src/pose/types.js";
import {
  lookAtCalibration,
  poseFrame2D,
  projectPerson,
  skeleton,
} from "./fusion-fixtures.js";

interface FusedPerson3D {
  personId: string;
  score: number;
  cameraIds: string[];
  meanReprojectionErrorPx: number;
  keypoints: Array<{
    id: string;
    x: number;
    y: number;
    z: number;
    score: number;
  }>;
}

const calibrations: CameraCalibrationV1[] = [
  lookAtCalibration("camera-1", { x: 3.4, y: 1.7, z: 3.1 }),
  lookAtCalibration("camera-2", { x: -3.2, y: 1.8, z: 2.9 }),
  lookAtCalibration("camera-3", { x: 0.2, y: 2.6, z: -3.8 }),
];

/** Moves a skeleton along +x so temporal interpolation is observable. */
function skeletonAt(origin: Vector3, timestampUs: number): Vector3[] {
  const shift = (timestampUs / 1_000_000) * 0.5;
  return skeleton({ x: origin.x + shift, y: origin.y, z: origin.z });
}

function startedController(): PoseFusionController {
  const controller = new PoseFusionController();
  for (const calibration of calibrations) {
    controller.loadCalibration(JSON.stringify(calibration));
  }
  controller.start({
    delayMilliseconds: 100,
    jitterMilliseconds: 80,
    minKeypointScore: 0.3,
  });
  return controller;
}

/** Feeds each camera on its own capture phase, out of order across cameras. */
function feed(
  controller: PoseFusionController,
  origins: readonly Vector3[],
  options: { occludeNose?: boolean } = {},
): void {
  const phases = [0, 7_000, 15_000];
  for (let frame = 0; frame < 12; frame += 1) {
    for (const [index, calibration] of [...calibrations].reverse().entries()) {
      const phase = phases[calibrations.length - 1 - index] ?? 0;
      const timestampUs = frame * 33_000 + phase;
      const persons: PoseFrame2DPersonV1[] = origins.map((origin, person) => {
        const scores =
          options.occludeNose &&
          calibration.cameraId === "camera-3" &&
          person === 0
            ? [0.02]
            : [];
        return projectPerson(
          calibration,
          `movenet-${person + 1}`,
          skeletonAt(origin, timestampUs),
          scores,
        );
      });
      controller.ingestFrame(
        JSON.stringify(
          poseFrame2D(calibration.cameraId, timestampUs, persons, frame),
        ),
      );
    }
  }
}

function persons(controller: PoseFusionController): FusedPerson3D[] {
  const frame = JSON.parse(controller.latestFrameJson()) as {
    persons: FusedPerson3D[];
  };
  return frame.persons;
}

describe("PoseFusionController", () => {
  it("fuses jittered multi-camera frames into a valid PoseFrame3D", () => {
    const controller = startedController();
    const origins = [
      { x: -0.6, y: 0, z: 0.2 },
      { x: 0.9, y: 0, z: -0.4 },
    ];
    feed(controller, origins);

    expect(controller.ready()).toBe(true);
    expect(controller.cameraCount()).toBe(3);
    expect(controller.fuseBufferedInstant()).toBe(true);
    expect(controller.state()).toBe("ready");
    expect(controller.errorCode()).toBe("");

    const frame = JSON.parse(controller.latestFrameJson()) as Record<
      string,
      unknown
    >;
    expect(Value.Check(PoseFrame3DSchema, frame)).toBe(true);
    expect(frame.schema).toBe("twrmc/pose-frame-3d");
    expect(frame.timestampUs).toBe(controller.fusedTimestampUs());
    expect(controller.personCount()).toBe(2);
    expect(controller.meanReprojectionErrorPx()).toBeLessThan(1);

    // The fused instant sits one delay behind the newest buffered timestamp.
    expect(controller.fusedTimestampUs()).toBe(11 * 33_000 + 15_000 - 100_000);

    for (const person of persons(controller)) {
      expect(person.cameraIds).toEqual(["camera-1", "camera-2", "camera-3"]);
      const truth = skeletonAt(
        person.keypoints[0]!.x < 0 ? origins[0]! : origins[1]!,
        controller.fusedTimestampUs(),
      );
      for (const [index, keypoint] of person.keypoints.entries()) {
        expect(keypoint.score).toBeGreaterThan(0.5);
        expect(keypoint.x).toBeCloseTo(truth[index]!.x, 3);
        expect(keypoint.y).toBeCloseTo(truth[index]!.y, 3);
        expect(keypoint.z).toBeCloseTo(truth[index]!.z, 3);
      }
    }
  });

  it("keeps triangulating a keypoint occluded in one of three cameras", () => {
    const controller = startedController();
    const origins = [{ x: -0.6, y: 0, z: 0.2 }];
    feed(controller, origins, { occludeNose: true });
    expect(controller.fuseBufferedInstant()).toBe(true);

    const [person] = persons(controller);
    const nose = person?.keypoints[0];
    const truth = skeletonAt(origins[0]!, controller.fusedTimestampUs())[0]!;
    expect(nose?.score).toBeGreaterThan(0);
    expect(nose?.x).toBeCloseTo(truth.x, 3);
    expect(nose?.y).toBeCloseTo(truth.y, 3);
  });

  it("keeps stable person identifiers across consecutive fusions", () => {
    const controller = startedController();
    const origins = [
      { x: -0.6, y: 0, z: 0.2 },
      { x: 0.9, y: 0, z: -0.4 },
    ];
    feed(controller, origins);
    expect(controller.fuseBufferedInstant()).toBe(true);
    const first = persons(controller).map((person) => person.personId);
    expect(controller.fuseAt(controller.fusedTimestampUs() + 16_000)).toBe(
      true,
    );
    const second = persons(controller).map((person) => person.personId);
    expect(new Set(first).size).toBe(2);
    expect(second).toEqual(first);
  });

  it("reports transient shortages without replacing the last fused frame", () => {
    const controller = startedController();
    feed(controller, [{ x: -0.6, y: 0, z: 0.2 }]);
    expect(controller.fuseBufferedInstant()).toBe(true);
    const retained = controller.latestFrameJson();
    const fusedTimestamp = controller.fusedTimestampUs();

    // No camera covers an instant far outside the buffered window.
    expect(controller.fuseAt(5_000_000)).toBe(false);
    expect(controller.errorCode()).toBe("insufficient-cameras");
    expect(controller.state()).toBe("buffering");
    expect(controller.latestFrameJson()).toBe(retained);
    expect(controller.fusedTimestampUs()).toBe(fusedTimestamp);
    expect(JSON.parse(controller.synchronizedSampleJson())).toMatchObject({
      timestampUs: 5_000_000,
      cameras: [],
    });
  });

  it("needs at least two calibrated cameras to fuse", () => {
    const controller = new PoseFusionController();
    controller.loadCalibration(JSON.stringify(calibrations[0]));
    controller.start({
      delayMilliseconds: 0,
      jitterMilliseconds: 80,
      minKeypointScore: 0.3,
    });
    expect(controller.ready()).toBe(false);
    controller.ingestFrame(
      JSON.stringify(
        poseFrame2D("camera-1", 1_000, [
          projectPerson(
            calibrations[0]!,
            "movenet-1",
            skeleton({ x: 0, y: 0, z: 0 }),
          ),
        ]),
      ),
    );
    expect(controller.fuseBufferedInstant()).toBe(false);
    expect(controller.errorCode()).toBe("insufficient-cameras");
    expect(controller.latestFrameJson()).toBe("");
  });

  it("drops frames whose profile does not describe them", () => {
    const controller = startedController();
    const half = (calibration: CameraCalibrationV1): string => {
      const frame = poseFrame2D("camera-1", 200_000, [
        projectPerson(calibration, "movenet-1", skeleton({ x: 0, y: 0, z: 0 })),
      ]);
      frame.frameWidth = 640;
      frame.frameHeight = 360;
      for (const person of frame.persons) {
        for (const keypoint of person.keypoints) {
          keypoint.x /= 2;
          keypoint.y /= 2;
        }
      }
      return JSON.stringify(frame);
    };
    controller.ingestFrame(half(calibrations[0]!));
    expect(controller.errorCode()).toBe("calibration-mismatch");
    expect(controller.errorMessage()).toMatch(/640x360/u);
    expect(controller.bufferedFrameCount()).toBe(0);
    expect(controller.droppedFrameCount()).toBe(1);

    const foreignProfile = poseFrame2D("camera-2", 200_000, []);
    foreignProfile.calibrationId = "camera-2-profile-v2";
    controller.ingestFrame(JSON.stringify(foreignProfile));
    expect(controller.errorCode()).toBe("calibration-mismatch");
    expect(controller.bufferedFrameCount()).toBe(0);

    // An uncalibrated camera never occupies a ring buffer.
    controller.ingestFrame(
      JSON.stringify(poseFrame2D("camera-9", 200_000, [])),
    );
    expect(controller.errorCode()).toBe("unknown-camera");
    expect(controller.bufferedFrameCount()).toBe(0);
    expect(controller.droppedFrameCount()).toBe(3);
  });

  it("fuses a keypoint from the largest consensus view set", () => {
    const controller = new PoseFusionController();
    const rig = [
      lookAtCalibration("camera-1", { x: 3.4, y: 1.7, z: 3.1 }),
      lookAtCalibration("camera-2", { x: -3.2, y: 1.8, z: 2.9 }),
      lookAtCalibration("camera-3", { x: 0.2, y: 2.6, z: -3.8 }),
      lookAtCalibration("camera-4", { x: -3.4, y: 1.6, z: -3.2 }),
      lookAtCalibration("camera-5", { x: 3.6, y: 2.2, z: -3.1 }),
    ];
    for (const calibration of rig) {
      controller.loadCalibration(JSON.stringify(calibration));
    }
    controller.start({
      delayMilliseconds: 0,
      jitterMilliseconds: 80,
      minKeypointScore: 0.3,
    });
    const points = skeleton({ x: 0.1, y: 0, z: 0.2 });
    for (const [index, calibration] of rig.entries()) {
      const person = projectPerson(calibration, "movenet-1", points);
      // Two of the five cameras report a confident but wrong nose, so the
      // fusion needs more than one refinement round to reach the clean views.
      if (index >= 3) {
        const nose = person.keypoints[0]!;
        nose.x += 55 + index * 30;
        nose.y -= 40 + index * 25;
      }
      controller.ingestFrame(
        JSON.stringify(poseFrame2D(calibration.cameraId, 100_000, [person])),
      );
    }
    expect(controller.fuseAt(100_000)).toBe(true);
    const nose = persons(controller)[0]?.keypoints[0];
    expect(nose?.score).toBeGreaterThan(0);
    expect(nose?.x).toBeCloseTo(points[0]!.x, 3);
    expect(nose?.y).toBeCloseTo(points[0]!.y, 3);
    expect(nose?.z).toBeCloseTo(points[0]!.z, 3);
  });

  it("counts dropped frames and rejects foreign or malformed payloads", () => {
    const controller = startedController();
    const frame = JSON.stringify(
      poseFrame2D("camera-1", 200_000, [
        projectPerson(
          calibrations[0]!,
          "movenet-1",
          skeleton({ x: 0, y: 0, z: 0 }),
        ),
      ]),
    );
    controller.ingestFrame(frame);
    controller.ingestFrame(frame);
    expect(controller.droppedFrameCount()).toBe(1);
    expect(controller.errorCode()).toBe("frame-dropped");
    expect(controller.bufferedFrameCount()).toBe(1);

    expect(() => controller.ingestFrame("{")).toThrow(/frame-invalid/u);
    expect(() =>
      controller.ingestFrame(JSON.stringify(calibrations[0])),
    ).toThrow(/twrmc\/camera-calibration/u);
    expect(() => controller.loadCalibration(frame)).toThrow(
      /calibration-invalid/u,
    );
  });

  it("validates start options and requires a started pipeline", () => {
    const controller = new PoseFusionController();
    expect(() => controller.fuseBufferedInstant()).toThrow(/not been started/u);
    expect(() =>
      controller.start({
        delayMilliseconds: -1,
        jitterMilliseconds: 80,
        minKeypointScore: 0.3,
      }),
    ).toThrow(/fusion delay/u);
    expect(() =>
      controller.start({
        delayMilliseconds: 100,
        jitterMilliseconds: 0,
        minKeypointScore: 0.3,
      }),
    ).toThrow(/jitter window/u);
    expect(() =>
      controller.start({
        delayMilliseconds: 100,
        jitterMilliseconds: 80,
        minKeypointScore: 2,
      }),
    ).toThrow(/minimum keypoint score/u);
  });

  it("clears buffers on stop and calibrations on cleanup", () => {
    const controller = startedController();
    feed(controller, [{ x: 0, y: 0, z: 0 }]);
    expect(controller.bufferedFrameCount()).toBeGreaterThan(0);
    controller.stop();
    expect(controller.bufferedFrameCount()).toBe(0);
    expect(controller.state()).toBe("idle");
    expect(controller.latestFrameJson()).toBe("");
    expect(controller.cameraCount()).toBe(3);
    controller.cleanup();
    expect(controller.cameraCount()).toBe(0);
  });
});
