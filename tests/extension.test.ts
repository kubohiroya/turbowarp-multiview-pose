import { afterEach, describe, expect, it, vi } from "vitest";
import { MultiviewPoseExtension } from "../src/extension.js";
import { WEBRTC_CAPABILITY_KEY } from "../src/webrtc-capability.js";

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
  it("keeps the QR and pose feature flags independent", () => {
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

    const poseOnly = new MultiviewPoseExtension({
      enabled: false,
      poseEnabled: true,
      poseModel,
      clockId: "clock-1",
    });
    const poseOpcodes = (
      poseOnly.getInfo().blocks as Array<{ opcode: string }>
    ).map(({ opcode }) => opcode);
    expect(poseOpcodes).not.toContain("prepareOfferQr");
    expect(poseOpcodes).toContain("startWebGpuMoveNetMultiPose");
    expect(poseOpcodes).toContain("latestPoseFrame2D");
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
      clockId: "clock-1",
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
