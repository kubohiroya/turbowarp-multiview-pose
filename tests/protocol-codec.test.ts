import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ProtocolV1Codec } from "../src/protocol/codec.js";
import {
  coco17KeypointIds,
  protocolSchemaFiles,
  protocolSchemas,
} from "../src/protocol/schemas.js";

const keypoints2d = coco17KeypointIds.map((id, index) => ({
  id,
  x: index * 10,
  y: index * 5,
  score: 0.9,
}));
const keypoints3d = coco17KeypointIds.map((id, index) => ({
  id,
  x: index / 10,
  y: index / 20,
  z: index / 30,
  score: 0.8,
}));

const validValues = [
  {
    schema: "twrmc/session-policy",
    version: 1,
    sessionId: "show-2026",
    revision: 1,
    issuedAt: "2026-09-13T12:00:00Z",
    expiresAt: "2026-09-13T18:00:00Z",
    fusionPeerId: "fusion-1",
    cameraPeers: [
      {
        cameraId: "camera-1",
        peerId: "source-1",
        displayName: "Stage left",
        calibrationId: "calibration-1",
      },
    ],
    maximumPerformers: 6,
    poseModel: {
      model: "movenet-multipose-lightning",
      maxPoses: 6,
      minPoseScore: 0.2,
      minKeypointScore: 0.2,
    },
    qrCourierPairing: true,
    poseChannelHighWaterBytes: 262_144,
  },
  {
    schema: "twrmc/camera-calibration",
    version: 1,
    calibrationId: "calibration-1",
    cameraId: "camera-1",
    imageWidth: 1920,
    imageHeight: 1080,
    intrinsicMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    distortionCoefficients: [],
    worldFromCameraMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    worldUnit: "meter",
    calibratedAt: "2026-09-13T12:00:00Z",
  },
  {
    schema: "twrmc/pose-frame-2d",
    version: 1,
    cameraId: "camera-1",
    peerId: "source-1",
    sequence: 42,
    captureTimestampUs: 123_456_789,
    frameWidth: 1920,
    frameHeight: 1080,
    calibrationId: "calibration-1",
    persons: [{ trackingId: "person-1", score: 0.9, keypoints: keypoints2d }],
  },
  {
    schema: "twrmc/pose-frame-3d",
    version: 1,
    sequence: 42,
    timestampUs: 123_456_789,
    persons: [
      {
        personId: "performer-1",
        score: 0.8,
        cameraIds: ["camera-1", "camera-2"],
        meanReprojectionErrorPx: 1.25,
        keypoints: keypoints3d,
      },
    ],
  },
  {
    schema: "twrmc/performance-dsl",
    version: 1,
    performers: [
      {
        performerId: "actor-1",
        displayName: "Actor 1",
        glowStickColor: "#00FFAA",
        recognitionStartEffect: "fade-in",
        recognitionEndEffect: "fade-out",
        avatarAsset: "avatar-1",
      },
    ],
  },
] as const;

function codec(): ProtocolV1Codec {
  return new ProtocolV1Codec(() => Date.parse("2026-09-13T13:00:00Z"));
}

describe("ProtocolV1Codec", () => {
  it("dispatches and round-trips all five pinned v1 contracts", () => {
    for (const value of validValues) {
      const instance = codec();
      const source = JSON.stringify(value, null, 2);
      expect(instance.validate(source)).toBe(true);
      const encoded = instance.encode(source);
      expect(JSON.parse(encoded)).toEqual(value);
      expect(instance.schema()).toBe(value.schema);
      expect(instance.version()).toBe(1);
      instance.decode(encoded);
      expect(JSON.parse(instance.decodedJson())).toEqual(value);
      expect(instance.errorPath()).toBe("");
      expect(instance.errorMessage()).toBe("");
    }
  });

  it("accepts PoseFrame2D v2 while v1 keeps rejecting it", () => {
    const frameV2 = {
      schema: "twrmc/pose-frame-2d",
      version: 2,
      cameraId: "camera-1",
      peerId: "source-1",
      sequence: 42,
      captureTimestampUs: 123_456_789,
      frameWidth: 1920,
      frameHeight: 1080,
      calibrationId: "calibration-1",
      persons: [
        {
          trackingId: "person-1",
          score: 0.9,
          keypoints: keypoints2d,
          markers: [
            { keypointId: "right_wrist", colorHex: "#00FFAA", coverage: 0.42 },
          ],
        },
      ],
    };
    const instance = codec();
    expect(instance.validate(JSON.stringify(frameV2))).toBe(true);
    expect(instance.schema()).toBe("twrmc/pose-frame-2d");
    expect(instance.version()).toBe(2);
    expect(
      Value.Check(protocolSchemas["twrmc/pose-frame-2d"][1], frameV2),
    ).toBe(false);
    expect(
      Value.Check(protocolSchemas["twrmc/pose-frame-2d"][2], frameV2),
    ).toBe(true);

    // Markers stay bounded, colored, and anchored to a COCO-17 keypoint.
    const withMarkers = (markers: unknown) => ({
      ...frameV2,
      persons: [{ ...frameV2.persons[0], markers }],
    });
    expect(instance.validate(JSON.stringify(withMarkers([])))).toBe(true);
    expect(
      instance.validate(
        JSON.stringify(
          withMarkers([
            { keypointId: "right_hand", colorHex: "#00FFAA", coverage: 0.4 },
          ]),
        ),
      ),
    ).toBe(false);
    expect(
      instance.validate(
        JSON.stringify(
          withMarkers([
            { keypointId: "right_wrist", colorHex: "00FFAA", coverage: 0.4 },
          ]),
        ),
      ),
    ).toBe(false);
    expect(instance.validate(JSON.stringify({ ...frameV2, version: 3 }))).toBe(
      false,
    );
    expect(instance.errorPath()).toBe("/version");
    expect(instance.errorMessage()).toMatch(/Supported: 1, 2/u);
  });

  it("publishes one generated JSON Schema per dispatched contract version", async () => {
    const versions = Object.values(protocolSchemas).reduce(
      (total, byVersion) => total + Object.keys(byVersion).length,
      0,
    );
    expect(Object.keys(protocolSchemaFiles).length).toBe(versions);
    for (const [filename, schema] of Object.entries(protocolSchemaFiles)) {
      const published = await readFile(
        new URL(`../schemas/${filename}`, import.meta.url),
        "utf8",
      );
      expect(JSON.parse(published)).toEqual(JSON.parse(JSON.stringify(schema)));
    }
  });

  it("classifies the committed fixtures like the owned schemas", async () => {
    const valid = await fixture("valid/performance-dsl.json");
    const invalidVersion = await fixture("invalid/performance-dsl-v2.json");
    const credential = await fixture(
      "invalid/session-policy-with-credential.json",
    );
    expect(
      Value.Check(protocolSchemas["twrmc/performance-dsl"][1], valid),
    ).toBe(true);
    expect(codec().validate(JSON.stringify(valid))).toBe(true);
    expect(
      Value.Check(protocolSchemas["twrmc/performance-dsl"][1], invalidVersion),
    ).toBe(false);
    expect(codec().validate(JSON.stringify(invalidVersion))).toBe(false);
    expect(
      Value.Check(protocolSchemas["twrmc/session-policy"][1], credential),
    ).toBe(false);
    const credentialCodec = codec();
    expect(credentialCodec.validate(JSON.stringify(credential))).toBe(false);
    expect(credentialCodec.errorPath()).toBe("/offer");
    expect(credentialCodec.errorMessage()).toMatch(/credentials/u);
  });

  it("rejects unknown schemas, versions, fields, and malformed JSON with diagnostics", () => {
    const instance = codec();
    expect(instance.validate('{"schema":"twmp/not-real","version":1}')).toBe(
      false,
    );
    expect(instance.errorPath()).toBe("/schema");
    expect(instance.errorMessage()).toMatch(/Unsupported schema/u);

    expect(
      instance.validate(JSON.stringify({ ...validValues[4], version: 2 })),
    ).toBe(false);
    expect(instance.errorPath()).toBe("/version");

    expect(
      instance.validate(
        JSON.stringify({ ...validValues[4], unexpected: true }),
      ),
    ).toBe(false);
    expect(instance.errorPath()).toBe("/unexpected");

    const missingPerformers = {
      schema: validValues[4].schema,
      version: validValues[4].version,
    };
    expect(instance.validate(JSON.stringify(missingPerformers))).toBe(false);
    expect(instance.errorPath()).toBe("/performers");

    expect(instance.validate("{")).toBe(false);
    expect(instance.errorPath()).toBe("/");
    expect(instance.errorMessage()).toMatch(/Invalid JSON/u);
  });

  it("enforces six-person limits and exact COCO-17 order", () => {
    const pose = validValues[2];
    const person = pose.persons[0];
    const sevenPeople = {
      ...pose,
      persons: Array.from({ length: 7 }, (_, index) => ({
        ...person,
        trackingId: `person-${index}`,
      })),
    };
    const instance = codec();
    expect(instance.validate(JSON.stringify(sevenPeople))).toBe(false);
    expect(instance.errorPath()).toBe("/persons");

    const swapped = [...keypoints2d];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(
      instance.validate(
        JSON.stringify({
          ...pose,
          persons: [{ ...person, keypoints: swapped }],
        }),
      ),
    ).toBe(false);
    expect(instance.errorPath()).toMatch(/^\/persons\/0\/keypoints/u);
  });

  it("rejects expired policy windows and clears retained values after failed decoding", () => {
    const instance = codec();
    instance.decode(JSON.stringify(validValues[4]));
    expect(instance.decodedJson()).not.toBe("");
    expect(() =>
      instance.decode(
        JSON.stringify({
          ...validValues[0],
          expiresAt: "2026-09-13T11:00:00Z",
        }),
      ),
    ).toThrow(/expiresAt/u);
    expect(instance.errorPath()).toBe("/expiresAt");
    expect(instance.decodedJson()).toBe("");
  });
});

async function fixture(path: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL(`fixtures/protocol/${path}`, import.meta.url),
      "utf8",
    ),
  ) as unknown;
}
