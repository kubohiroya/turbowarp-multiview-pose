/**
 * The frame sync pattern is a 4x4 grid of light and dark cells that encodes the
 * moment it was shown. Twelve data cells carry a millisecond counter and four
 * check cells reject a reading that mixed two displayed frames, which happens
 * whenever a camera exposure straddles a display refresh.
 *
 * The counter wraps every 4096 milliseconds. A reading is therefore only a time
 * within the current wrap window; the consumer resolves the wrap by comparing it
 * against its own synchronized clock, which is correct as long as the measured
 * latency stays below the wrap period.
 */

export const PATTERN_COLUMNS = 4;
export const PATTERN_ROWS = 4;
export const PATTERN_CELL_COUNT = PATTERN_COLUMNS * PATTERN_ROWS;
export const PATTERN_DATA_BITS = 12;
export const PATTERN_CHECK_BITS = 4;
export const PATTERN_STEP_US = 1000;
export const PATTERN_CODE_COUNT = 2 ** PATTERN_DATA_BITS;
export const PATTERN_WRAP_US = PATTERN_CODE_COUNT * PATTERN_STEP_US;

const CHECK_MASK = 2 ** PATTERN_CHECK_BITS - 1;
const CHECK_SEED = 0b1010;

/** The code a display shows for a timestamp, in the display computer's clock. */
export function patternCodeForTimestamp(timestampUs: number): number {
  const steps = Math.floor(timestampUs / PATTERN_STEP_US);
  return (
    ((steps % PATTERN_CODE_COUNT) + PATTERN_CODE_COUNT) % PATTERN_CODE_COUNT
  );
}

/** The display time a decoded code stands for, within the current wrap window. */
export function patternTimestampUs(code: number): number {
  return code * PATTERN_STEP_US;
}

export function patternCheckBits(code: number): number {
  return ((code ^ (code >> 4) ^ (code >> 8)) & CHECK_MASK) ^ CHECK_SEED;
}

/** Cell states in row-major order. `true` is a light cell. */
export function encodePatternCells(code: number): boolean[] {
  const normalized = normalizeCode(code);
  const check = patternCheckBits(normalized);
  const cells: boolean[] = [];
  for (let index = 0; index < PATTERN_DATA_BITS; index += 1) {
    cells.push(bitAt(normalized, PATTERN_DATA_BITS - 1 - index));
  }
  for (let index = 0; index < PATTERN_CHECK_BITS; index += 1) {
    cells.push(bitAt(check, PATTERN_CHECK_BITS - 1 - index));
  }
  return cells;
}

/**
 * Rebuilds the code from cell states. An undefined cell is one the decoder could
 * not tell apart from its opposite, and any such cell rejects the whole reading.
 */
export function decodePatternCells(
  cells: readonly (boolean | undefined)[],
): number | undefined {
  if (cells.length !== PATTERN_CELL_COUNT) return undefined;
  let code = 0;
  for (let index = 0; index < PATTERN_DATA_BITS; index += 1) {
    const cell = cells[index];
    if (cell === undefined) return undefined;
    code = (code << 1) | (cell ? 1 : 0);
  }
  let check = 0;
  for (let index = 0; index < PATTERN_CHECK_BITS; index += 1) {
    const cell = cells[PATTERN_DATA_BITS + index];
    if (cell === undefined) return undefined;
    check = (check << 1) | (cell ? 1 : 0);
  }
  return check === patternCheckBits(code) ? code : undefined;
}

function normalizeCode(code: number): number {
  const rounded = Math.trunc(code);
  return (
    ((rounded % PATTERN_CODE_COUNT) + PATTERN_CODE_COUNT) % PATTERN_CODE_COUNT
  );
}

function bitAt(value: number, bit: number): boolean {
  return ((value >> bit) & 1) === 1;
}
