import { describe, expect, it } from "vitest";
import {
  PATTERN_CELL_COUNT,
  PATTERN_CODE_COUNT,
  PATTERN_STEP_US,
  PATTERN_WRAP_US,
  decodePatternCells,
  encodePatternCells,
  patternCheckBits,
  patternCodeForTimestamp,
  patternTimestampUs,
} from "../src/frame-sync/pattern.js";

describe("frame sync pattern", () => {
  it("round trips every code the display can show", () => {
    for (let code = 0; code < PATTERN_CODE_COUNT; code += 1) {
      const cells = encodePatternCells(code);
      expect(cells).toHaveLength(PATTERN_CELL_COUNT);
      expect(decodePatternCells(cells)).toBe(code);
    }
  });

  it("encodes the millisecond part of a display timestamp", () => {
    expect(patternCodeForTimestamp(0)).toBe(0);
    expect(patternCodeForTimestamp(1_500)).toBe(1);
    expect(patternCodeForTimestamp(PATTERN_WRAP_US + 7_000)).toBe(7);
    expect(patternTimestampUs(7)).toBe(7 * PATTERN_STEP_US);
  });

  it("rejects a cell the decoder could not read", () => {
    const cells: (boolean | undefined)[] = encodePatternCells(1234);
    cells[5] = undefined;
    expect(decodePatternCells(cells)).toBeUndefined();
  });

  it("rejects a reading that mixed two displayed frames", () => {
    // A camera exposure spanning a refresh produces data cells from one code
    // and check cells from another.
    const mixed = [
      ...encodePatternCells(1234).slice(0, 12),
      ...encodePatternCells(2345).slice(12),
    ];
    expect(patternCheckBits(1234)).not.toBe(patternCheckBits(2345));
    expect(decodePatternCells(mixed)).toBeUndefined();
  });

  it("rejects a reading with the wrong cell count", () => {
    expect(
      decodePatternCells(encodePatternCells(1).slice(0, 15)),
    ).toBeUndefined();
  });
});
