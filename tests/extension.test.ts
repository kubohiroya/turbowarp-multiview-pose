import { afterEach, describe, expect, it, vi } from "vitest";
import { MultiviewPoseExtension } from "../src/extension.js";
import { WEBRTC_CAPABILITY_KEY } from "../src/webrtc-capability.js";
import { AFRAME_CAPABILITY_KEY } from "../src/avatar/aframe-port.js";
import { PATTERN_WRAP_US } from "../src/frame-sync/pattern.js";
import type { FrameSyncPatternController } from "../src/frame-sync/controller.js";
import type { FrameSyncObservation } from "../src/frame-sync/types.js";

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
  it("keeps all five feature flags independent", () => {
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

    const avatarOnly = new MultiviewPoseExtension({
      enabled: false,
      poseEnabled: false,
      protocolEnabled: false,
      calibrationEnabled: false,
      avatarEnabled: true,
    });
    const avatarOpcodes = (
      avatarOnly.getInfo().blocks as Array<{ opcode: string }>
    ).map(({ opcode }) => opcode);
    expect(avatarOpcodes).toContain("registerAvatarAsset");
    expect(avatarOpcodes).toContain("applyPoseFrame3DToAvatars");
    expect(avatarOpcodes).not.toContain("startCameraCalibration");
  });

  it("keeps frame sync pattern blocks behind their own startup flag", () => {
    setup();
    const frameSyncOnly = new MultiviewPoseExtension({
      enabled: false,
      poseEnabled: false,
      protocolEnabled: false,
      calibrationEnabled: false,
      frameSyncEnabled: true,
    });
    const opcodes = (
      frameSyncOnly.getInfo().blocks as Array<{ opcode: string }>
    ).map(({ opcode }) => opcode);
    expect(opcodes).toContain("showFrameSyncPattern");
    expect(opcodes).toContain("startFrameSyncDecoder");
    expect(opcodes).toContain("frameSyncPatternTimestampUs");
    expect(opcodes).not.toContain("prepareOfferQr");
    expect(opcodes).not.toContain("startCameraCalibration");
    expect(opcodes).not.toContain("registerAvatarAsset");

    const allOff = new MultiviewPoseExtension({});
    const offOpcodes = (
      allOff.getInfo().blocks as Array<{ opcode: string }>
    ).map(({ opcode }) => opcode);
    expect(offOpcodes).not.toContain("showFrameSyncPattern");
    expect(() => allOff.showFrameSyncPattern()).toThrow(
      "Frame sync pattern v1 is disabled",
    );
  });

  it("drives the frame sync decoder and reports the taken observation", async () => {
    const { runtime, listeners } = setup();
    const observation: FrameSyncObservation = {
      frameTimestampUs: 1_700_000_000_123_456,
      frameAgeUs: 21_000,
      patternTimestampUs: 2_024_000,
    };
    let taken: FrameSyncObservation | undefined;
    const controller = {
      start: vi.fn(async () => undefined),
      recalibrate: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      state: vi.fn(() => "ready" as const),
      errorCode: vi.fn(() => "" as const),
      decodeRate: vi.fn(() => 0.75),
      pendingObservations: vi.fn(() => (taken ? 0 : 1)),
      takeObservation: vi.fn(() => {
        taken = observation;
        return observation;
      }),
      currentObservation: vi.fn(() => taken),
    } as unknown as FrameSyncPatternController;
    const display = {
      show: vi.fn(),
      hide: vi.fn(),
      visible: vi.fn(() => true),
    };
    const extension = new MultiviewPoseExtension({
      runtime,
      frameSyncEnabled: true,
      frameSyncController: controller,
      frameSyncDisplay: display,
    });

    extension.showFrameSyncPattern();
    expect(display.show).toHaveBeenCalledOnce();
    expect(extension.frameSyncPatternShown()).toBe(true);
    expect(extension.frameSyncPatternWrapUs()).toBe(PATTERN_WRAP_US);

    await extension.startFrameSyncDecoder({
      CAMERA_ID: "camera-1",
      SECONDS: 6,
    });
    expect(controller.start).toHaveBeenCalledWith({
      cameraId: "camera-1",
      calibrationSeconds: 6,
    });
    await extension.calibrateFrameSyncDecoder({ SECONDS: 4 });
    expect(controller.recalibrate).toHaveBeenCalledWith(4);

    expect(extension.frameSyncDecoderState()).toBe("ready");
    expect(extension.frameSyncDecodeRate()).toBe(0.75);
    expect(extension.frameSyncObservationAvailable()).toBe(true);
    expect(extension.frameSyncFrameTimestampUs()).toBe(0);

    extension.takeFrameSyncObservation();
    expect(extension.frameSyncFrameTimestampUs()).toBe(
      observation.frameTimestampUs,
    );
    expect(extension.frameSyncFrameAgeUs()).toBe(observation.frameAgeUs);
    expect(extension.frameSyncPatternTimestampUs()).toBe(
      observation.patternTimestampUs,
    );
    expect(extension.frameSyncObservationAvailable()).toBe(false);

    listeners.get("PROJECT_STOP_ALL")?.();
    expect(controller.stop).toHaveBeenCalled();
    expect(display.hide).toHaveBeenCalled();
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

  it("cleans avatar instances through A-Frame capability v1 on disposal", () => {
    const { runtime, listeners } = setup();
    const nodes = new Set<string>();
    const deleteSelector = vi.fn((selector: string) =>
      nodes.delete(selector.replace(/^#/u, "")),
    );
    runtime[AFRAME_CAPABILITY_KEY] = {
      version: 1,
      requireVersion() {
        return this;
      },
      loadTemplate: vi.fn(),
      createFromTemplate: vi.fn(
        (_template: string, instance: string) => void nodes.add(instance),
      ),
      setPosition: vi.fn(),
      setRotation: vi.fn(),
      emitEvent: vi.fn(),
      deleteSelector,
      countSelector: vi.fn((selector: string) =>
        nodes.has(selector.replace(/^#/u, "")) ? 1 : 0,
      ),
    };
    const extension = new MultiviewPoseExtension({
      runtime,
      avatarEnabled: true,
    });
    extension.registerAvatarAsset({
      ASSET_ID: "actor",
      TEMPLATE_JSON: '{"type":"group"}',
      RIG_JSON: '{"bones":[{"selector":"#{avatar}-arm","rig":"LeftUpperArm"}]}',
    });
    extension.bindAvatarPerson({
      PERSON_ID: "performer-1",
      INSTANCE_ID: "avatar-1",
      ASSET_ID: "actor",
      PARENT: "#scene",
      CONFIDENCE: 0.3,
    });
    listeners.get("RUNTIME_DISPOSED")?.();
    expect(deleteSelector).toHaveBeenCalledWith("#avatar-1");
    expect(extension.avatarBindingCount()).toBe(0);
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
