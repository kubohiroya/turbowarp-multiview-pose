import definitions from "./block-definitions.json";
import { extensionConfig } from "./config.js";
import { featureFlags } from "../config/feature-flags.js";
import { qrConfig } from "../config/qr-config.js";
import {
  createQrCourierParts,
  type QrErrorCorrectionLevel,
} from "./qr-courier.js";
import { createQrSvg } from "./qr-svg.js";
import { TemporarySpriteSkinManager } from "./sprite-skin.js";
import { requireWebRtcOfferCapability } from "./webrtc-capability.js";
import { PosePipelineController } from "./pose/controller.js";
import { TfjsWebGpuMoveNet } from "./pose/tfjs-movenet.js";
import type { PoseModelPort } from "./pose/types.js";
import { ProtocolV1Codec } from "./protocol/codec.js";
import { CameraCalibrationController } from "./calibration/controller.js";
import { OpenCvChessboardCalibrationBackend } from "./calibration/opencv-backend.js";
import type { CalibrationBackendPort } from "./calibration/types.js";
import { PoseFusionController } from "./fusion/controller.js";

type BlockTypeName = "COMMAND" | "REPORTER" | "BOOLEAN" | "HAT";
type ArgumentTypeName = "STRING" | "NUMBER" | "BOOLEAN";
type OfferQrState =
  "idle" | "generating-offer" | "rendering" | "displayed" | "error";

interface DefinitionArgument {
  type: ArgumentTypeName;
  defaultValue: string | number | boolean;
}

interface BlockDefinition {
  opcode: string;
  feature:
    | "qrCourierPairing"
    | "webgpuMoveNetMultiPose"
    | "protocolV1Codec"
    | "cameraCalibrationV1"
    | "poseFusion3D";
  blockType: BlockTypeName;
  text: string;
  description: string;
  arguments: Record<string, DefinitionArgument>;
}

interface OfferQrSession {
  peer: string;
  texts: string[];
  svgs: string[];
  currentIndex: number;
}

export interface MultiviewPoseExtensionOptions {
  enabled?: boolean;
  poseEnabled?: boolean;
  protocolEnabled?: boolean;
  calibrationEnabled?: boolean;
  fusionEnabled?: boolean;
  errorCorrectionLevel?: QrErrorCorrectionLevel;
  runtime?: TurboWarpRuntime;
  poseModel?: PoseModelPort;
  calibrationBackend?: CalibrationBackendPort;
  nowMilliseconds?: () => number;
}

const blockDefinitions = definitions.blocks as readonly BlockDefinition[];

export class MultiviewPoseExtension implements TurboWarpExtension {
  private readonly enabled: boolean;
  private readonly poseEnabled: boolean;
  private readonly protocolEnabled: boolean;
  private readonly calibrationEnabled: boolean;
  private readonly fusionEnabled: boolean;
  private readonly errorCorrectionLevel: QrErrorCorrectionLevel;
  private readonly runtime: TurboWarpRuntime;
  private readonly skins: TemporarySpriteSkinManager;
  private readonly pose: PosePipelineController;
  private readonly protocol: ProtocolV1Codec;
  private readonly calibration: CameraCalibrationController;
  private readonly fusion: PoseFusionController;
  private session: OfferQrSession | undefined;
  private state: OfferQrState = "idle";
  private lastError = "";
  private operation = 0;
  private readonly stopListener = () => {
    this.endOfferQrDisplay();
    void this.pose.stop();
    void this.calibration.cancel();
    this.fusion.stop();
  };
  private readonly disposeListener = () => this.dispose();
  private readonly targetRemovedListener = (target: unknown) => {
    if (isTarget(target) && this.skins.isDisplaying(target))
      this.endOfferQrDisplay();
  };

  public constructor(options: MultiviewPoseExtensionOptions = {}) {
    this.enabled = options.enabled ?? featureFlags.qrCourierPairing;
    this.poseEnabled =
      options.poseEnabled ?? featureFlags.webgpuMoveNetMultiPose;
    this.protocolEnabled =
      options.protocolEnabled ?? featureFlags.protocolV1Codec;
    this.calibrationEnabled =
      options.calibrationEnabled ?? featureFlags.cameraCalibrationV1;
    this.fusionEnabled = options.fusionEnabled ?? featureFlags.poseFusion3D;
    this.errorCorrectionLevel =
      options.errorCorrectionLevel ?? qrConfig.errorCorrectionLevel;
    this.runtime = options.runtime ?? Scratch.vm?.runtime ?? {};
    this.skins = new TemporarySpriteSkinManager(this.runtime);
    this.pose = new PosePipelineController({
      runtime: this.runtime,
      model: options.poseModel ?? new TfjsWebGpuMoveNet(),
    });
    this.protocol = new ProtocolV1Codec(options.nowMilliseconds);
    this.calibration = new CameraCalibrationController({
      runtime: this.runtime,
      backend:
        options.calibrationBackend ?? new OpenCvChessboardCalibrationBackend(),
      ...(options.nowMilliseconds
        ? { nowMilliseconds: options.nowMilliseconds }
        : {}),
    });
    this.fusion = new PoseFusionController();
    this.runtime.on?.("PROJECT_STOP_ALL", this.stopListener);
    this.runtime.on?.("PROJECT_RUN_STOP", this.stopListener);
    this.runtime.on?.("PROJECT_LOADED", this.stopListener);
    this.runtime.on?.("RUNTIME_DISPOSED", this.disposeListener);
    this.runtime.on?.("targetWasRemoved", this.targetRemovedListener);
  }

  public getInfo(): Record<string, unknown> {
    return {
      id: extensionConfig.id,
      name: Scratch.translate(definitions.extensionName),
      docsURI: extensionConfig.docsURI,
      blockIconURI: extensionConfig.blockIconURI,
      blocks: blockDefinitions
        .filter((block) => this.blockEnabled(block.feature))
        .map((block) => this.toScratchBlock(block)),
    };
  }

  public async prepareOfferQr(args: { PEER: unknown }): Promise<void> {
    this.requireEnabled();
    if (this.state === "generating-offer" || this.state === "rendering") {
      throw new Error("An offer QR operation is already running.");
    }
    const peer = Scratch.Cast.toString(args.PEER).trim();
    if (!peer) throw new Error("Peer name must not be empty.");
    this.clearPreparedSession();
    const operation = ++this.operation;
    this.state = "generating-offer";
    this.lastError = "";
    try {
      const capability = requireWebRtcOfferCapability(this.runtime);
      await capability.createOffer(peer);
      if (operation !== this.operation) return;
      const code = capability.getOffer(peer);
      if (!code)
        throw new Error(
          "TurboWarp WebRTC did not return an offer pairing code.",
        );
      this.state = "rendering";
      const courier = await createQrCourierParts(code, {
        peerId: peer,
        kind: "offer",
        errorCorrectionLevel: this.errorCorrectionLevel,
      });
      if (operation !== this.operation) return;
      this.session = {
        peer,
        texts: courier.texts,
        svgs: courier.texts.map((text) =>
          createQrSvg(text, this.errorCorrectionLevel),
        ),
        currentIndex: 0,
      };
      this.state = "displayed";
    } catch (error) {
      if (operation === this.operation) {
        this.state = "error";
        this.lastError = errorMessage(error);
      }
      throw error;
    }
  }

  public showOfferQrPart(
    args: { INDEX: unknown },
    util?: TurboWarpBlockUtility,
  ): void {
    this.requireEnabled();
    const session = this.requireSession();
    const index = Scratch.Cast.toNumber(args.INDEX);
    if (!Number.isInteger(index) || index < 1 || index > session.svgs.length) {
      throw new Error(
        `Offer QR part index must be between 1 and ${session.svgs.length}.`,
      );
    }
    this.skins.show(util?.target, session.svgs[index - 1] ?? "");
    session.currentIndex = index - 1;
  }

  public offerQrPartCount(): number {
    return this.session?.texts.length ?? 0;
  }

  public offerQrCurrentPart(): number {
    return this.session ? this.session.currentIndex + 1 : 0;
  }

  public showNextOfferQrPart(
    _args?: Record<string, never>,
    util?: TurboWarpBlockUtility,
  ): void {
    this.requireEnabled();
    const session = this.requireSession();
    const next = (session.currentIndex + 1) % session.svgs.length;
    this.skins.show(util?.target, session.svgs[next] ?? "");
    session.currentIndex = next;
  }

  public async createAndShowOfferQr(
    args: { PEER: unknown },
    util?: TurboWarpBlockUtility,
  ): Promise<void> {
    const target = this.skins.validateTarget(util?.target);
    await this.prepareOfferQr(args);
    if (this.runtime.targets && !this.runtime.targets.includes(target)) {
      this.endOfferQrDisplay();
      throw new Error(
        "Offer QR sprite target was removed while the offer was being created.",
      );
    }
    this.showOfferQrPart({ INDEX: 1 }, { target });
  }

  public endOfferQrDisplay(): void {
    this.operation += 1;
    this.skins.releaseAll();
    this.clearPreparedSession();
    this.state = "idle";
    this.lastError = "";
  }

  public offerQrState(): string {
    return this.enabled ? this.state : "disabled";
  }

  public offerQrError(): string {
    return this.lastError;
  }

  public async startWebGpuMoveNetMultiPose(args: {
    CAMERA_ID: unknown;
    PEER_ID: unknown;
    CALIBRATION_ID: unknown;
  }): Promise<void> {
    this.requirePoseEnabled();
    await this.pose.start({
      cameraId: Scratch.Cast.toString(args.CAMERA_ID).trim(),
      peerId: Scratch.Cast.toString(args.PEER_ID).trim(),
      calibrationId: Scratch.Cast.toString(args.CALIBRATION_ID).trim(),
    });
  }

  public async stopWebGpuMoveNetMultiPose(): Promise<void> {
    await this.pose.stop();
  }

  public async inferNextPoseFrame(args: {
    CAPTURE_TIMESTAMP_US: unknown;
  }): Promise<void> {
    this.requirePoseEnabled();
    await this.pose.inferLatestFrame(
      Scratch.Cast.toNumber(args.CAPTURE_TIMESTAMP_US),
    );
  }

  public webGpuMoveNetReady(): boolean {
    return this.poseEnabled && this.pose.ready();
  }

  public poseBackend(): string {
    return this.poseEnabled ? this.pose.backend() : "disabled";
  }

  public posePipelineState(): string {
    return this.poseEnabled ? this.pose.state() : "disabled";
  }

  public poseErrorCode(): string {
    return this.pose.errorCode();
  }

  public poseError(): string {
    return this.pose.errorMessage();
  }

  public latestPoseFrame2D(): string {
    return this.pose.latestFrameJson();
  }

  public protocolJsonValid(args: { JSON: unknown }): boolean {
    this.requireProtocolEnabled();
    return this.protocol.validate(Scratch.Cast.toString(args.JSON));
  }

  public decodeProtocolJson(args: { JSON: unknown }): void {
    this.requireProtocolEnabled();
    this.protocol.decode(Scratch.Cast.toString(args.JSON));
  }

  public encodeProtocolJson(args: { JSON: unknown }): string {
    this.requireProtocolEnabled();
    return this.protocol.encode(Scratch.Cast.toString(args.JSON));
  }

  public decodedProtocolJson(): string {
    return this.protocolEnabled ? this.protocol.decodedJson() : "";
  }

  public protocolSchema(): string {
    return this.protocolEnabled ? this.protocol.schema() : "disabled";
  }

  public protocolVersion(): number {
    return this.protocolEnabled ? this.protocol.version() : 0;
  }

  public protocolErrorPath(): string {
    return this.protocol.errorPath();
  }

  public protocolErrorMessage(): string {
    return this.protocol.errorMessage();
  }

  public async startCameraCalibration(args: {
    CAMERA_ID: unknown;
    CALIBRATION_ID: unknown;
    COLUMNS: unknown;
    ROWS: unknown;
    SQUARE_METERS: unknown;
    MAX_ERROR_PX: unknown;
  }): Promise<void> {
    this.requireCalibrationEnabled();
    await this.calibration.start({
      cameraId: Scratch.Cast.toString(args.CAMERA_ID),
      calibrationId: Scratch.Cast.toString(args.CALIBRATION_ID),
      board: {
        columns: Scratch.Cast.toNumber(args.COLUMNS),
        rows: Scratch.Cast.toNumber(args.ROWS),
        squareSizeMeters: Scratch.Cast.toNumber(args.SQUARE_METERS),
      },
      maximumReprojectionErrorPx: Scratch.Cast.toNumber(args.MAX_ERROR_PX),
    });
  }

  public async addCameraCalibrationSample(): Promise<void> {
    this.requireCalibrationEnabled();
    await this.calibration.addSample();
  }

  public async solveCameraCalibration(): Promise<void> {
    this.requireCalibrationEnabled();
    await this.calibration.solve();
  }

  public async cancelCameraCalibration(): Promise<void> {
    await this.calibration.cancel();
  }

  public async cleanupCameraCalibration(): Promise<void> {
    await this.calibration.cleanup();
  }

  public async importCameraCalibration(args: { JSON: unknown }): Promise<void> {
    this.requireCalibrationEnabled();
    await this.calibration.importProfile(Scratch.Cast.toString(args.JSON));
  }

  public cameraCalibrationJsonValid(args: { JSON: unknown }): boolean {
    this.requireCalibrationEnabled();
    return this.calibration.validateProfile(Scratch.Cast.toString(args.JSON));
  }

  public cameraCalibrationReady(): boolean {
    return this.calibrationEnabled && this.calibration.ready();
  }

  public cameraCalibrationState(): string {
    return this.calibrationEnabled ? this.calibration.state() : "disabled";
  }

  public cameraCalibrationBackend(): string {
    return this.calibrationEnabled ? this.calibration.backend() : "disabled";
  }

  public cameraCalibrationSampleCount(): number {
    return this.calibration.sampleCount();
  }

  public cameraCalibrationSampleQuality(): number {
    return this.calibration.latestSampleQuality();
  }

  public cameraCalibrationReprojectionError(): number {
    return this.calibration.latestReprojectionError();
  }

  public cameraCalibrationErrorCode(): string {
    return this.calibration.errorCode();
  }

  public cameraCalibrationError(): string {
    return this.calibration.errorMessage();
  }

  public cameraCalibrationJson(): string {
    return this.calibration.profileJson();
  }

  public startPoseFusion(args: {
    DELAY_MS: unknown;
    JITTER_MS: unknown;
    MIN_SCORE: unknown;
  }): void {
    this.requireFusionEnabled();
    this.fusion.start({
      delayMilliseconds: Scratch.Cast.toNumber(args.DELAY_MS),
      jitterMilliseconds: Scratch.Cast.toNumber(args.JITTER_MS),
      minKeypointScore: Scratch.Cast.toNumber(args.MIN_SCORE),
    });
  }

  public stopPoseFusion(): void {
    this.fusion.stop();
  }

  public cleanupPoseFusion(): void {
    this.fusion.cleanup();
  }

  public loadFusionCameraCalibration(args: { JSON: unknown }): void {
    this.requireFusionEnabled();
    this.fusion.loadCalibration(Scratch.Cast.toString(args.JSON));
  }

  public bufferPoseFrame2D(args: { JSON: unknown }): void {
    this.requireFusionEnabled();
    this.fusion.ingestFrame(Scratch.Cast.toString(args.JSON));
  }

  public fuseBufferedPoseFrame3D(): void {
    this.requireFusionEnabled();
    this.fusion.fuseBufferedInstant();
  }

  public fusePoseFrame3DAt(args: { TIMESTAMP_US: unknown }): void {
    this.requireFusionEnabled();
    this.fusion.fuseAt(Scratch.Cast.toNumber(args.TIMESTAMP_US));
  }

  public latestPoseFrame3D(): string {
    return this.fusionEnabled ? this.fusion.latestFrameJson() : "";
  }

  public synchronizedPoseSet2D(): string {
    return this.fusionEnabled ? this.fusion.synchronizedSampleJson() : "";
  }

  public poseFusionState(): string {
    return this.fusionEnabled ? this.fusion.state() : "disabled";
  }

  public poseFusionReady(): boolean {
    return this.fusionEnabled && this.fusion.ready();
  }

  public poseFusionCameraCount(): number {
    return this.fusion.cameraCount();
  }

  public poseFusionBufferedFrameCount(): number {
    return this.fusion.bufferedFrameCount();
  }

  public poseFusionDroppedFrameCount(): number {
    return this.fusion.droppedFrameCount();
  }

  public poseFusionPersonCount(): number {
    return this.fusion.personCount();
  }

  public poseFusionTimestampUs(): number {
    return this.fusion.fusedTimestampUs();
  }

  public poseFusionReprojectionErrorPx(): number {
    return this.fusion.meanReprojectionErrorPx();
  }

  public poseFusionErrorCode(): string {
    return this.fusion.errorCode();
  }

  public poseFusionError(): string {
    return this.fusion.errorMessage();
  }

  public dispose(): void {
    this.endOfferQrDisplay();
    void this.pose.stop();
    void this.calibration.cancel();
    this.fusion.stop();
    this.runtime.off?.("PROJECT_STOP_ALL", this.stopListener);
    this.runtime.off?.("PROJECT_RUN_STOP", this.stopListener);
    this.runtime.off?.("PROJECT_LOADED", this.stopListener);
    this.runtime.off?.("RUNTIME_DISPOSED", this.disposeListener);
    this.runtime.off?.("targetWasRemoved", this.targetRemovedListener);
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new Error(
        "QR courier pairing is disabled. Enable it before the project starts.",
      );
    }
  }

  private requirePoseEnabled(): void {
    if (!this.poseEnabled) {
      throw new Error(
        "WebGPU MoveNet MultiPose is disabled. Enable it before the project starts.",
      );
    }
  }

  private requireProtocolEnabled(): void {
    if (!this.protocolEnabled) {
      throw new Error(
        "Protocol v1 codec is disabled. Enable it before the project starts.",
      );
    }
  }

  private requireFusionEnabled(): void {
    if (!this.fusionEnabled) {
      throw new Error(
        "Pose fusion 3D is disabled. Enable it before the project starts.",
      );
    }
  }

  private requireCalibrationEnabled(): void {
    if (!this.calibrationEnabled) {
      throw new Error(
        "Camera calibration v1 is disabled. Enable it before the project starts.",
      );
    }
  }

  private blockEnabled(feature: BlockDefinition["feature"]): boolean {
    if (feature === "qrCourierPairing") return this.enabled;
    if (feature === "webgpuMoveNetMultiPose") return this.poseEnabled;
    if (feature === "protocolV1Codec") return this.protocolEnabled;
    if (feature === "cameraCalibrationV1") return this.calibrationEnabled;
    return this.fusionEnabled;
  }

  private requireSession(): OfferQrSession {
    if (!this.session)
      throw new Error("Prepare an offer QR before displaying a part.");
    return this.session;
  }

  private clearPreparedSession(): void {
    this.skins.releaseAll();
    if (this.session) {
      this.session.texts.fill("");
      this.session.svgs.fill("");
      this.session = undefined;
    }
  }

  private toScratchBlock(block: BlockDefinition): Record<string, unknown> {
    return {
      opcode: block.opcode,
      blockType: Scratch.BlockType[block.blockType],
      text: Scratch.translate(block.text),
      arguments: Object.fromEntries(
        Object.entries(block.arguments).map(([name, argument]) => [
          name,
          {
            type: Scratch.ArgumentType[argument.type],
            defaultValue: argument.defaultValue,
          },
        ]),
      ),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTarget(value: unknown): value is TurboWarpTarget {
  return typeof value === "object" && value !== null;
}
