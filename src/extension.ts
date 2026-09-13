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
  errorCorrectionLevel?: QrErrorCorrectionLevel;
  runtime?: TurboWarpRuntime;
}

const blockDefinitions = definitions.blocks as readonly BlockDefinition[];

export class MultiviewPoseExtension implements TurboWarpExtension {
  private readonly enabled: boolean;
  private readonly errorCorrectionLevel: QrErrorCorrectionLevel;
  private readonly runtime: TurboWarpRuntime;
  private readonly skins: TemporarySpriteSkinManager;
  private session: OfferQrSession | undefined;
  private state: OfferQrState = "idle";
  private lastError = "";
  private operation = 0;
  private readonly stopListener = () => this.endOfferQrDisplay();
  private readonly targetRemovedListener = (target: unknown) => {
    if (isTarget(target) && this.skins.isDisplaying(target))
      this.endOfferQrDisplay();
  };

  public constructor(options: MultiviewPoseExtensionOptions = {}) {
    this.enabled = options.enabled ?? featureFlags.qrCourierPairing;
    this.errorCorrectionLevel =
      options.errorCorrectionLevel ?? qrConfig.errorCorrectionLevel;
    this.runtime = options.runtime ?? Scratch.vm?.runtime ?? {};
    this.skins = new TemporarySpriteSkinManager(this.runtime);
    this.runtime.on?.("PROJECT_STOP_ALL", this.stopListener);
    this.runtime.on?.("PROJECT_RUN_STOP", this.stopListener);
    this.runtime.on?.("targetWasRemoved", this.targetRemovedListener);
  }

  public getInfo(): Record<string, unknown> {
    return {
      id: extensionConfig.id,
      name: Scratch.translate(definitions.extensionName),
      docsURI: extensionConfig.docsURI,
      blockIconURI: extensionConfig.blockIconURI,
      blocks: this.enabled
        ? blockDefinitions.map((block) => this.toScratchBlock(block))
        : [],
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

  public dispose(): void {
    this.endOfferQrDisplay();
    this.runtime.off?.("PROJECT_STOP_ALL", this.stopListener);
    this.runtime.off?.("PROJECT_RUN_STOP", this.stopListener);
    this.runtime.off?.("targetWasRemoved", this.targetRemovedListener);
  }

  private requireEnabled(): void {
    if (!this.enabled) {
      throw new Error(
        "QR courier pairing is disabled. Enable it before the project starts.",
      );
    }
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
