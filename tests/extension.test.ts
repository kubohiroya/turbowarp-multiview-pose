import { afterEach, describe, expect, it, vi } from "vitest";
import { MultiviewPoseExtension } from "../src/extension.js";
import { WEBRTC_CAPABILITY_KEY } from "../src/webrtc-capability.js";
import {
  lookAtCalibration,
  performanceDsl,
  poseFrame2D,
  projectPerson,
  skeleton,
} from "./fusion-fixtures.js";

interface FakeRenderer extends TurboWarpRenderer {
  created: Map<number, string>;
  destroyed: number[];
  updates: Array<[number, number]>;
}

function setup(code = "offer-code") {
  let nextSkin = 100;
  const target: TurboWarpTarget = {
    drawableID: 7,
    isStage: false,
    isOriginal: true,
  };
  const renderer: FakeRenderer = {
    created: new Map(),
    destroyed: [],
    updates: [],
    _allDrawables: Array.from({ length: 8 }, (_, index) =>
      index === 7 ? { _skin: { _id: 42 } } : undefined,
    ),
    createSVGSkin(svg) {
      nextSkin += 1;
      this.created.set(nextSkin, svg);
      return nextSkin;
    },
    destroySkin(skinId) {
      this.destroyed.push(skinId);
      this.created.delete(skinId);
    },
    updateDrawableSkinId(drawableId, skinId) {
      this.updates.push([drawableId, skinId]);
    },
  };
  const capability = {
    version: 2,
    requireVersion: vi.fn(function (this: unknown, version: number) {
      if (version !== 2) throw new Error("unsupported");
      return this;
    }),
    createOffer: vi.fn(async () => undefined),
    getOffer: vi.fn(() => code),
  };
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const runtime: TurboWarpRuntime = {
    renderer,
    targets: [target],
    [WEBRTC_CAPABILITY_KEY]: capability,
    on: vi.fn((event, listener) => listeners.set(event, listener)),
    off: vi.fn((event) => listeners.delete(event)),
    requestRedraw: vi.fn(),
  };
  vi.stubGlobal("Scratch", {
    BlockType: {
      COMMAND: "command",
      REPORTER: "reporter",
      BOOLEAN: "boolean",
      HAT: "hat",
    },
    ArgumentType: { STRING: "string", NUMBER: "number", BOOLEAN: "boolean" },
    Cast: { toString: String, toNumber: Number, toBoolean: Boolean },
    translate: (value: string | { default: string }) =>
      typeof value === "string" ? value : value.default,
    vm: { runtime },
  });
  return { runtime, renderer, target, capability, listeners };
}

afterEach(() => vi.unstubAllGlobals());

describe("MultiviewPoseExtension offer QR blocks", () => {
  it("keeps the QR, pose, protocol, and calibration feature flags independent", () => {
    setup();
    const poseModel = {
      initializeWebGpu: vi.fn(async () => undefined),
      backend: vi.fn(() => "webgpu"),
      createMultiPoseDetector: vi.fn(async () => ({
        estimatePoses: vi.fn(async () => []),
        dispose: vi.fn(),
      })),
    };
    const qrOnly = new MultiviewPoseExtension({
      enabled: true,
      poseEnabled: false,
    });
    const qrOpcodes = (
      qrOnly.getInfo().blocks as Array<{ opcode: string }>
    ).map(({ opcode }) => opcode);
    expect(qrOpcodes).toContain("prepareOfferQr");
    expect(qrOpcodes).not.toContain("startWebGpuMoveNetMultiPose");
    expect(qrOpcodes).not.toContain("decodeProtocolJson");

    const poseOnly = new MultiviewPoseExtension({
      enabled: false,
      poseEnabled: true,
      poseModel,
    });
    const poseOpcodes = (
      poseOnly.getInfo().blocks as Array<{ opcode: string }>
    ).map(({ opcode }) => opcode);
    expect(poseOpcodes).not.toContain("prepareOfferQr");
    expect(poseOpcodes).toContain("startWebGpuMoveNetMultiPose");
    expect(poseOpcodes).toContain("latestPoseFrame2D");

    const protocolOnly = new MultiviewPoseExtension({
      enabled: false,
      poseEnabled: false,
      protocolEnabled: true,
    });
    const protocolOpcodes = (
      protocolOnly.getInfo().blocks as Array<{ opcode: string }>
    ).map(({ opcode }) => opcode);
    expect(protocolOpcodes).not.toContain("prepareOfferQr");
    expect(protocolOpcodes).not.toContain("startWebGpuMoveNetMultiPose");
    expect(protocolOpcodes).toContain("decodeProtocolJson");
    expect(protocolOpcodes).toContain("protocolErrorPath");

    const calibrationOnly = new MultiviewPoseExtension({
      enabled: false,
      poseEnabled: false,
      protocolEnabled: false,
      calibrationEnabled: true,
      calibrationBackend: {
        name: "mock-calibration-backend",
        captureSample: vi.fn(async () => undefined),
        solve: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    });
    const calibrationOpcodes = (
      calibrationOnly.getInfo().blocks as Array<{ opcode: string }>
    ).map(({ opcode }) => opcode);
    expect(calibrationOpcodes).toContain("startCameraCalibration");
    expect(calibrationOpcodes).toContain("cameraCalibrationJson");
    expect(calibrationOpcodes).not.toContain("decodeProtocolJson");
    expect(calibrationOpcodes).not.toContain("startPoseFusion");

    const fusionOnly = new MultiviewPoseExtension({
      enabled: false,
      poseEnabled: false,
      protocolEnabled: false,
      calibrationEnabled: false,
      fusionEnabled: true,
    });
    const fusionOpcodes = (
      fusionOnly.getInfo().blocks as Array<{ opcode: string }>
    ).map(({ opcode }) => opcode);
    expect(fusionOpcodes).toContain("startPoseFusion");
    expect(fusionOpcodes).toContain("latestPoseFrame3D");
    expect(fusionOpcodes).not.toContain("startCameraCalibration");
  });

  it("gates glow stick blocks on their own startup flag", () => {
    setup();
    const disabled = new MultiviewPoseExtension({ markersEnabled: false });
    const hidden = (disabled.getInfo().blocks as Array<{ opcode: string }>).map(
      ({ opcode }) => opcode,
    );
    expect(hidden).not.toContain("enableGlowStickMarkers");
    expect(disabled.glowStickMarkerCount()).toBe(0);
    expect(disabled.glowStickPaletteSize()).toBe(0);
    expect(() =>
      disabled.enableGlowStickMarkers({ KEYPOINTS: "right_wrist" }),
    ).toThrow(/disabled/u);

    const enabled = new MultiviewPoseExtension({
      markersEnabled: true,
      poseEnabled: true,
      fusionEnabled: true,
      poseModel: {
        initializeWebGpu: vi.fn(async () => undefined),
        backend: vi.fn(() => "webgpu"),
        createMultiPoseDetector: vi.fn(async () => ({
          estimatePoses: vi.fn(async () => []),
          dispose: vi.fn(),
        })),
      },
    });
    const opcodes = (enabled.getInfo().blocks as Array<{ opcode: string }>).map(
      ({ opcode }) => opcode,
    );
    expect(opcodes).toContain("enableGlowStickMarkers");
    expect(opcodes).toContain("setPerformerGlowStick");
    enabled.loadGlowStickPalette({
      JSON: performanceDsl([
        { performerId: "actor-1", glowStickColor: "#00FFAA" },
      ]),
    });
    expect(enabled.glowStickPaletteSize()).toBe(1);
    enabled.setPerformerGlowStick({
      PERFORMER_ID: "actor-1",
      KEYPOINT: "left_wrist",
    });
    expect(() =>
      enabled.setPerformerGlowStick({
        PERFORMER_ID: "actor-1",
        KEYPOINT: "right_hand",
      }),
    ).toThrow(/Unknown COCO-17/u);
    expect(enabled.identifiedPerformerCount()).toBe(0);
    expect(enabled.mirrorCorrectedViewCount()).toBe(0);
  });

  it("keeps pose fusion blocks hidden while the startup flag is off", () => {
    setup();
    const extension = new MultiviewPoseExtension({ fusionEnabled: false });
    const opcodes = (
      extension.getInfo().blocks as Array<{ opcode: string }>
    ).map(({ opcode }) => opcode);
    expect(opcodes).not.toContain("startPoseFusion");
    expect(extension.poseFusionState()).toBe("disabled");
    expect(extension.poseFusionReady()).toBe(false);
    expect(() =>
      extension.startPoseFusion({
        DELAY_MS: 100,
        JITTER_MS: 80,
        MIN_SCORE: 0.3,
      }),
    ).toThrow(/disabled/u);
  });

  it("fuses buffered 2D frames into PoseFrame3D and stops with the project", () => {
    const { listeners } = setup();
    const extension = new MultiviewPoseExtension({ fusionEnabled: true });
    const calibrations = [
      lookAtCalibration("camera-1", { x: 3.4, y: 1.7, z: 3.1 }),
      lookAtCalibration("camera-2", { x: -3.2, y: 1.8, z: 2.9 }),
    ];
    for (const calibration of calibrations) {
      extension.loadFusionCameraCalibration({
        JSON: JSON.stringify(calibration),
      });
    }
    extension.startPoseFusion({
      DELAY_MS: 50,
      JITTER_MS: 80,
      MIN_SCORE: 0.3,
    });
    const points = skeleton({ x: 0.2, y: 0, z: -0.1 });
    for (const [index, calibration] of calibrations.entries()) {
      for (const timestampUs of [100_000, 133_000, 166_000]) {
        extension.bufferPoseFrame2D({
          JSON: JSON.stringify(
            poseFrame2D(calibration.cameraId, timestampUs + index * 5_000, [
              projectPerson(calibration, "movenet-1", points),
            ]),
          ),
        });
      }
    }
    expect(extension.poseFusionReady()).toBe(true);
    expect(extension.poseFusionCameraCount()).toBe(2);
    expect(extension.poseFusionBufferedFrameCount()).toBe(6);
    extension.fuseBufferedPoseFrame3D();
    expect(extension.poseFusionState()).toBe("ready");
    expect(extension.poseFusionPersonCount()).toBe(1);
    expect(extension.poseFusionTimestampUs()).toBe(121_000);
    expect(extension.poseFusionReprojectionErrorPx()).toBeLessThan(1);
    expect(extension.poseFusionErrorCode()).toBe("");
    expect(extension.poseFusionError()).toBe("");
    expect(JSON.parse(extension.latestPoseFrame3D())).toMatchObject({
      schema: "twmp/pose-frame-3d",
      version: 1,
    });
    expect(JSON.parse(extension.synchronizedPoseSet2D())).toMatchObject({
      timestampUs: 121_000,
    });

    // Hat-driven projects idle between messages; PROJECT_RUN_STOP must not
    // discard what the jitter buffer has accumulated.
    listeners.get("PROJECT_RUN_STOP")?.();
    expect(extension.poseFusionState()).toBe("ready");
    expect(extension.poseFusionBufferedFrameCount()).toBe(6);
    expect(extension.latestPoseFrame3D()).not.toBe("");

    listeners.get("PROJECT_STOP_ALL")?.();
    expect(extension.poseFusionState()).toBe("idle");
    expect(extension.poseFusionBufferedFrameCount()).toBe(0);
    expect(extension.latestPoseFrame3D()).toBe("");
    expect(extension.poseFusionCameraCount()).toBe(2);
    extension.cleanupPoseFusion();
    expect(extension.poseFusionCameraCount()).toBe(0);
  });

  it("exposes protocol round-trip and diagnostic reporters", () => {
    setup();
    const extension = new MultiviewPoseExtension({ protocolEnabled: true });
    const dsl = JSON.stringify({
      schema: "twmp/performance-dsl",
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
    });
    expect(extension.protocolJsonValid({ JSON: dsl })).toBe(true);
    extension.decodeProtocolJson({ JSON: dsl });
    expect(extension.encodeProtocolJson({ JSON: dsl })).toBe(dsl);
    expect(extension.decodedProtocolJson()).toBe(dsl);
    expect(extension.protocolSchema()).toBe("twmp/performance-dsl");
    expect(extension.protocolVersion()).toBe(1);
    expect(extension.protocolJsonValid({ JSON: "{" })).toBe(false);
    expect(extension.protocolErrorPath()).toBe("/");
    expect(extension.protocolErrorMessage()).toMatch(/Invalid JSON/u);
  });

  it("keeps QR courier blocks hidden while the startup flag is off", async () => {
    setup();
    const extension = new MultiviewPoseExtension({ enabled: false });
    expect((extension.getInfo().blocks as unknown[]).length).toBe(0);
    expect(extension.offerQrState()).toBe("disabled");
    await expect(
      extension.prepareOfferQr({ PEER: "camera-1" }),
    ).rejects.toThrow(/disabled/u);
  });

  it("creates an offer through capability v2 and reports prepared parts", async () => {
    const { capability } = setup();
    const extension = new MultiviewPoseExtension({ enabled: true });
    await extension.prepareOfferQr({ PEER: " camera-1 " });
    expect(capability.requireVersion).toHaveBeenCalledWith(2);
    expect(capability.createOffer).toHaveBeenCalledWith("camera-1");
    expect(capability.getOffer).toHaveBeenCalledWith("camera-1");
    expect(extension.offerQrPartCount()).toBe(1);
    expect(extension.offerQrCurrentPart()).toBe(1);
    expect(extension.offerQrState()).toBe("displayed");
  });

  it("waits for ICE-complete offer generation before reading the pairing code", async () => {
    const { capability } = setup();
    let finishOffer: (() => void) | undefined;
    capability.createOffer.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finishOffer = () => resolve(undefined);
        }),
    );
    const extension = new MultiviewPoseExtension({ enabled: true });
    const preparing = extension.prepareOfferQr({ PEER: "camera-1" });
    await Promise.resolve();
    expect(capability.getOffer).not.toHaveBeenCalled();
    finishOffer?.();
    await preparing;
    expect(capability.getOffer).toHaveBeenCalledOnce();
  });

  it("displays temporary SVG skins, cycles parts, and restores the original skin", async () => {
    const { renderer, target } = setup("A".repeat(6000));
    const extension = new MultiviewPoseExtension({ enabled: true });
    await extension.prepareOfferQr({ PEER: "camera-1" });
    expect(extension.offerQrPartCount()).toBeGreaterThan(1);
    extension.showOfferQrPart({ INDEX: 1 }, { target });
    const firstSkin = renderer.updates.at(-1)?.[1];
    expect(renderer.created.get(firstSkin ?? -1)).toContain(
      'shape-rendering="crispEdges"',
    );
    extension.showNextOfferQrPart({}, { target });
    expect(extension.offerQrCurrentPart()).toBe(2);
    expect(renderer.destroyed).toContain(firstSkin);
    extension.endOfferQrDisplay();
    expect(renderer.updates.at(-1)).toEqual([7, 42]);
    expect(renderer.created.size).toBe(0);
    expect(extension.offerQrPartCount()).toBe(0);
  });

  it("rejects stage targets, invalid indices, and missing WebRTC capabilities", async () => {
    setup();
    const extension = new MultiviewPoseExtension({ enabled: true });
    await extension.prepareOfferQr({ PEER: "camera-1" });
    expect(() =>
      extension.showOfferQrPart({ INDEX: 0 }, { target: { drawableID: 1 } }),
    ).toThrow(/between/u);
    expect(() =>
      extension.showOfferQrPart(
        { INDEX: 1 },
        { target: { drawableID: 0, isStage: true } },
      ),
    ).toThrow(/sprite target/u);
    const { runtime } = setup();
    delete runtime[WEBRTC_CAPABILITY_KEY];
    const missing = new MultiviewPoseExtension({ enabled: true, runtime });
    await expect(missing.prepareOfferQr({ PEER: "camera-1" })).rejects.toThrow(
      /not loaded/u,
    );
    expect(missing.offerQrState()).toBe("error");
  });

  it("cleans temporary data when the project stops", async () => {
    const { target, renderer, listeners } = setup();
    const extension = new MultiviewPoseExtension({ enabled: true });
    await extension.createAndShowOfferQr({ PEER: "camera-1" }, { target });
    listeners.get("PROJECT_STOP_ALL")?.();
    expect(renderer.updates.at(-1)).toEqual([7, 42]);
    expect(extension.offerQrPartCount()).toBe(0);
    expect(extension.offerQrState()).toBe("idle");
  });

  it("releases pose resources when the project reloads and the extension is disposed", async () => {
    const { runtime, listeners } = setup();
    const release = vi.fn(async () => undefined);
    const dispose = vi.fn();
    runtime.ext_kubohiroyacamerasource = {
      acquireCamera: vi.fn(async () => ({
        getFrameSource: vi.fn(() => ({
          kind: "video" as const,
          element: {} as HTMLVideoElement,
          width: 640,
          height: 480,
          mirrored: false,
          deviceId: "device-1",
        })),
        release,
      })),
    };
    const poseModel = {
      initializeWebGpu: vi.fn(async () => undefined),
      backend: vi.fn(() => "webgpu"),
      createMultiPoseDetector: vi.fn(async () => ({
        estimatePoses: vi.fn(async () => []),
        dispose,
      })),
    };
    const extension = new MultiviewPoseExtension({
      runtime,
      poseEnabled: true,
      poseModel,
    });
    await extension.startWebGpuMoveNetMultiPose({
      CAMERA_ID: "pose",
      PEER_ID: "source-1",
      CALIBRATION_ID: "calibration-1",
    });
    listeners.get("PROJECT_LOADED")?.();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(dispose).toHaveBeenCalledOnce();

    await extension.startWebGpuMoveNetMultiPose({
      CAMERA_ID: "pose",
      PEER_ID: "source-1",
      CALIBRATION_ID: "calibration-1",
    });
    listeners.get("RUNTIME_DISPOSED")?.();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("releases calibration camera leases on project reload and disposal", async () => {
    const { runtime, listeners } = setup();
    const release = vi.fn(async () => undefined);
    runtime.ext_kubohiroyacamerasource = {
      acquireCamera: vi.fn(async () => ({
        getFrameSource: vi.fn(() => ({
          kind: "video" as const,
          element: {} as HTMLVideoElement,
          width: 800,
          height: 600,
          mirrored: false,
          deviceId: "device-1",
        })),
        release,
      })),
    };
    const extension = new MultiviewPoseExtension({
      runtime,
      calibrationEnabled: true,
      calibrationBackend: {
        name: "mock-calibration-backend",
        captureSample: vi.fn(async () => undefined),
        solve: vi.fn(async () => {
          throw new Error("not used");
        }),
      },
    });
    const start = () =>
      extension.startCameraCalibration({
        CAMERA_ID: "camera-1",
        CALIBRATION_ID: "calibration-1",
        COLUMNS: 9,
        ROWS: 6,
        SQUARE_METERS: 0.025,
        MAX_ERROR_PX: 1.5,
      });
    await start();
    listeners.get("PROJECT_LOADED")?.();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(extension.cameraCalibrationState()).toBe("idle");
    await start();
    listeners.get("RUNTIME_DISPOSED")?.();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2));
  });

  it("cleans the old skin on re-prepare and when the displayed target is removed", async () => {
    const { target, renderer, listeners } = setup();
    const extension = new MultiviewPoseExtension({ enabled: true });
    await extension.createAndShowOfferQr({ PEER: "camera-1" }, { target });
    const firstSkin = renderer.updates.at(-1)?.[1];
    await extension.prepareOfferQr({ PEER: "camera-1" });
    expect(renderer.destroyed).toContain(firstSkin);
    extension.showOfferQrPart({ INDEX: 1 }, { target });
    listeners.get("targetWasRemoved")?.(target);
    expect(renderer.created.size).toBe(0);
    expect(extension.offerQrPartCount()).toBe(0);
  });

  it("reports offer capacity errors without retaining a session", async () => {
    setup("A".repeat(128 * 1024 + 1));
    const extension = new MultiviewPoseExtension({ enabled: true });
    await expect(
      extension.prepareOfferQr({ PEER: "camera-1" }),
    ).rejects.toThrow(/too large/u);
    expect(extension.offerQrState()).toBe("error");
    expect(extension.offerQrPartCount()).toBe(0);
  });
});
