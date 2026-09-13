import jsQR from "jsqr";
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import {
  createQrCourierParts,
  MAX_PART_COUNT,
  parseQrCourierPart,
  QrCourierAssembler,
} from "../src/qr-courier.js";
import { createQrSvg, qrVersion } from "../src/qr-svg.js";

describe("QR courier part codec", () => {
  it("round-trips a single part without changing the pairing code", async () => {
    const message = "eyJ0eXBlIjoib2ZmZXIifQ";
    const result = await createQrCourierParts(message, {
      peerId: "camera-1",
      kind: "offer",
      sessionId: "session-1",
      createdAt: 123,
    });
    expect(result.parts).toHaveLength(1);
    expect(parseQrCourierPart(result.texts[0] ?? "").partIndex).toBe(0);
    const assembler = new QrCourierAssembler();
    assembler.add(result.texts[0] ?? "");
    await expect(assembler.assemble()).resolves.toBe(message);
  });

  it("decodes generated QR images with jsQR and reassembles shuffled duplicate parts", async () => {
    const message = "A".repeat(6000);
    const result = await createQrCourierParts(message, {
      peerId: "camera-1",
      kind: "offer",
      sessionId: "session-2",
      createdAt: 456,
    });
    expect(result.parts.length).toBeGreaterThan(1);
    expect(result.parts.length).toBeLessThanOrEqual(MAX_PART_COUNT);
    const decoded = result.texts.map(decodeWithJsQr);
    expect(decoded).toEqual(result.texts);
    const assembler = new QrCourierAssembler();
    for (const text of [...decoded].reverse()) assembler.add(text);
    expect(assembler.add(decoded[0] ?? "").duplicate).toBe(true);
    await expect(assembler.assemble()).resolves.toBe(message);
  }, 20_000);

  it("uses QR Version 40 when a part reaches maximum M-level capacity", async () => {
    const result = await createQrCourierParts("B".repeat(6000), {
      peerId: "camera-1",
      kind: "offer",
      sessionId: "session-3",
      createdAt: 789,
    });
    expect(result.texts.some((text) => qrVersion(text, "M") === 40)).toBe(true);
    expect(createQrSvg(result.texts[0] ?? "")).toContain("<svg");
  });

  it("rejects mixed identities, missing parts, invalid indices, and oversized input", async () => {
    const first = await createQrCourierParts("A".repeat(6000), {
      peerId: "camera-1",
      kind: "offer",
      sessionId: "one",
      createdAt: 1,
    });
    const second = await createQrCourierParts("B", {
      peerId: "camera-2",
      kind: "offer",
      sessionId: "two",
      createdAt: 2,
    });
    const assembler = new QrCourierAssembler();
    assembler.add(first.texts[0] ?? "");
    expect(() => assembler.add(second.texts[0] ?? "")).toThrow(
      /current message/u,
    );
    await expect(assembler.assemble()).rejects.toThrow(/missing/u);
    const invalid = { ...first.parts[0], partIndex: first.parts[0]?.partCount };
    expect(() => parseQrCourierPart(JSON.stringify(invalid))).toThrow(
      /part index/u,
    );
    await expect(
      createQrCourierParts("A".repeat(128 * 1024 + 1), {
        peerId: "camera-1",
        kind: "offer",
      }),
    ).rejects.toThrow(/too large/u);
  });
});

function decodeWithJsQr(text: string): string {
  const qr = QRCode.create(
    [{ data: new TextEncoder().encode(text), mode: "byte" }],
    { errorCorrectionLevel: "M" },
  );
  const quiet = 4;
  const scale = 4;
  const width = (qr.modules.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  data.fill(255);
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0; column < qr.modules.size; column += 1) {
      if (!qr.modules.get(row, column)) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const pixel =
            ((row + quiet) * scale + y) * width + (column + quiet) * scale + x;
          data[pixel * 4] = 0;
          data[pixel * 4 + 1] = 0;
          data[pixel * 4 + 2] = 0;
        }
      }
    }
  }
  const decoded = jsQR(data, width, width, { inversionAttempts: "dontInvert" });
  if (!decoded) throw new Error("jsQR could not decode generated QR.");
  return decoded.data;
}
