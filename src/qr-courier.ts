import QRCode from "qrcode";

export const QR_COURIER_PROTOCOL = "twmp-qr/1" as const;
export const MAX_MESSAGE_LENGTH = 128 * 1024;
export const MAX_PART_COUNT = 64;
export const MAX_CHUNK_LENGTH = 4096;

export type QrCourierKind = "offer" | "answer";
export type QrErrorCorrectionLevel = "L" | "M" | "Q" | "H";

export interface QrCourierPartV1 {
  protocol: typeof QR_COURIER_PROTOCOL;
  sessionId: string;
  peerId: string;
  kind: QrCourierKind;
  messageId: string;
  createdAt: number;
  partIndex: number;
  partCount: number;
  messageLength: number;
  messageHash: string;
  payload: string;
}

export interface CreateQrCourierPartsOptions {
  peerId: string;
  kind: QrCourierKind;
  errorCorrectionLevel?: QrErrorCorrectionLevel;
  sessionId?: string;
  createdAt?: number;
}

export interface QrCourierParts {
  parts: QrCourierPartV1[];
  texts: string[];
}

export async function createQrCourierParts(
  message: string,
  options: CreateQrCourierPartsOptions,
): Promise<QrCourierParts> {
  requirePairingCode(message);
  const peerId = requireIdentifier(options.peerId, "peer ID");
  const sessionId = requireIdentifier(
    options.sessionId ?? crypto.randomUUID(),
    "session ID",
  );
  const createdAt = requireTimestamp(options.createdAt ?? Date.now());
  const errorCorrectionLevel = options.errorCorrectionLevel ?? "M";
  const messageHash = await sha256Base64Url(message);
  const messageId = `${sessionId}.${messageHash.slice(0, 12)}`;

  let partCount = 1;
  let chunkLength = 0;
  for (;;) {
    chunkLength = maximumPayloadLength(
      {
        protocol: QR_COURIER_PROTOCOL,
        sessionId,
        peerId,
        kind: options.kind,
        messageId,
        createdAt,
        partIndex: partCount - 1,
        partCount,
        messageLength: message.length,
        messageHash,
        payload: "",
      },
      errorCorrectionLevel,
    );
    if (chunkLength < 1)
      throw new Error(
        "QR encoder capacity is too small for the part envelope.",
      );
    const required = Math.ceil(message.length / chunkLength);
    if (required > MAX_PART_COUNT) {
      throw new Error(
        `QR encoder capacity exceeded: ${required} parts exceeds ${MAX_PART_COUNT}.`,
      );
    }
    if (required === partCount) break;
    partCount = required;
  }

  const parts = Array.from(
    { length: partCount },
    (_, partIndex): QrCourierPartV1 => ({
      protocol: QR_COURIER_PROTOCOL,
      sessionId,
      peerId,
      kind: options.kind,
      messageId,
      createdAt,
      partIndex,
      partCount,
      messageLength: message.length,
      messageHash,
      payload: message.slice(
        partIndex * chunkLength,
        (partIndex + 1) * chunkLength,
      ),
    }),
  );
  const texts = parts.map(serializeQrCourierPart);
  for (const text of texts) QRCode.create(text, { errorCorrectionLevel });
  return { parts, texts };
}

export function serializeQrCourierPart(part: QrCourierPartV1): string {
  validatePart(part);
  return JSON.stringify(part);
}

export function parseQrCourierPart(text: string): QrCourierPartV1 {
  if (text.length > MAX_CHUNK_LENGTH * 2)
    throw new Error("QR part text is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("QR part is not valid JSON.");
  }
  if (!isRecord(parsed)) throw new Error("QR part must be an object.");
  const part = parsed as unknown as QrCourierPartV1;
  validatePart(part);
  return part;
}

export class QrCourierAssembler {
  private readonly parts = new Map<number, QrCourierPartV1>();
  private identity: string | undefined;

  public add(text: string): {
    received: number;
    total: number;
    duplicate: boolean;
  } {
    const part = parseQrCourierPart(text);
    const identity = partIdentity(part);
    if (this.identity !== undefined && this.identity !== identity) {
      throw new Error("QR part does not belong to the current message.");
    }
    this.identity = identity;
    const existing = this.parts.get(part.partIndex);
    if (existing && existing.payload !== part.payload) {
      throw new Error(`Conflicting QR part at index ${part.partIndex}.`);
    }
    this.parts.set(part.partIndex, part);
    return {
      received: this.parts.size,
      total: part.partCount,
      duplicate: existing !== undefined,
    };
  }

  public async assemble(): Promise<string> {
    const first = this.parts.values().next().value as
      QrCourierPartV1 | undefined;
    if (!first) throw new Error("No QR parts have been received.");
    if (this.parts.size !== first.partCount)
      throw new Error("QR message has missing parts.");
    const message = Array.from({ length: first.partCount }, (_, index) => {
      const part = this.parts.get(index);
      if (!part) throw new Error(`QR message is missing part ${index}.`);
      return part.payload;
    }).join("");
    if (message.length !== first.messageLength)
      throw new Error("QR message length mismatch.");
    if ((await sha256Base64Url(message)) !== first.messageHash) {
      throw new Error("QR message hash mismatch.");
    }
    return message;
  }
}

function maximumPayloadLength(
  base: Omit<QrCourierPartV1, "payload"> & { payload: string },
  errorCorrectionLevel: QrErrorCorrectionLevel,
): number {
  let low = 0;
  let high = MAX_CHUNK_LENGTH;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const text = JSON.stringify({ ...base, payload: "A".repeat(middle) });
    try {
      QRCode.create([{ data: new TextEncoder().encode(text), mode: "byte" }], {
        version: 40,
        errorCorrectionLevel,
      });
      low = middle;
    } catch {
      high = middle - 1;
    }
  }
  return low;
}

function validatePart(part: QrCourierPartV1): void {
  if (part.protocol !== QR_COURIER_PROTOCOL)
    throw new Error("Unsupported QR part protocol.");
  requireIdentifier(part.sessionId, "session ID");
  requireIdentifier(part.peerId, "peer ID");
  requireIdentifier(part.messageId, "message ID");
  if (part.kind !== "offer" && part.kind !== "answer")
    throw new Error("Invalid QR message kind.");
  requireTimestamp(part.createdAt);
  if (
    !Number.isInteger(part.partCount) ||
    part.partCount < 1 ||
    part.partCount > MAX_PART_COUNT
  ) {
    throw new Error("Invalid QR part count.");
  }
  if (
    !Number.isInteger(part.partIndex) ||
    part.partIndex < 0 ||
    part.partIndex >= part.partCount
  ) {
    throw new Error("Invalid QR part index.");
  }
  if (
    !Number.isInteger(part.messageLength) ||
    part.messageLength < 1 ||
    part.messageLength > MAX_MESSAGE_LENGTH
  ) {
    throw new Error("Invalid QR message length.");
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(part.messageHash))
    throw new Error("Invalid QR message hash.");
  if (
    typeof part.payload !== "string" ||
    part.payload.length > MAX_CHUNK_LENGTH
  ) {
    throw new Error("Invalid QR part payload.");
  }
}

function requirePairingCode(value: string): void {
  if (typeof value !== "string" || value.length < 1)
    throw new Error("Offer pairing code is empty.");
  if (value.length > MAX_MESSAGE_LENGTH)
    throw new Error("Offer pairing code is too large.");
  if (!/^[\x20-\x7E]+$/u.test(value)) {
    throw new Error("Offer pairing code must be printable ASCII.");
  }
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function requireTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid QR creation timestamp.");
  return value;
}

function partIdentity(part: QrCourierPartV1): string {
  return [
    part.protocol,
    part.sessionId,
    part.peerId,
    part.kind,
    part.messageId,
    part.createdAt,
    part.partCount,
    part.messageLength,
    part.messageHash,
  ].join("\u0000");
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
