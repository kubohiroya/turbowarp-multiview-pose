import { Value } from "@sinclair/typebox/value";
import {
  protocolSchemaFor,
  protocolSchemas,
  protocolVersionsFor,
  type ProtocolSchemaId,
} from "./schemas.js";

const MAX_JSON_BYTES = 1_048_576;
const FORBIDDEN_PAIRING_KEYS = new Set([
  "answer",
  "credential",
  "credentials",
  "dtlsfingerprint",
  "icecandidate",
  "icecandidates",
  "icepwd",
  "iceufrag",
  "offer",
  "sdp",
]);

export interface ProtocolDiagnostic {
  path: string;
  message: string;
}

export interface ProtocolCodecResult {
  ok: boolean;
  json: string;
  schema: string;
  version: number | undefined;
  diagnostic: ProtocolDiagnostic | undefined;
}

export interface ProtocolDecodeResult extends ProtocolCodecResult {
  value: Record<string, unknown> | undefined;
}

/**
 * Parses one pinned v1 contract without retaining state. The result carries the
 * schema and version recognized so far even when validation fails.
 */
export function decodeProtocolJson(
  json: string,
  nowMilliseconds: number,
): ProtocolDecodeResult {
  let schemaId = "";
  let schemaVersion: number | undefined;
  const failure = (path: string, message: string): ProtocolDecodeResult => ({
    ok: false,
    json: "",
    schema: schemaId,
    version: schemaVersion,
    diagnostic: { path, message },
    value: undefined,
  });

  if (new TextEncoder().encode(json).byteLength > MAX_JSON_BYTES) {
    return failure("/", `JSON exceeds ${MAX_JSON_BYTES} bytes.`);
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure("/", `Invalid JSON: ${message}`);
  }
  if (!isRecord(value)) {
    return failure("/", "Protocol value must be a JSON object.");
  }

  if (typeof value.schema !== "string") {
    return failure("/schema", "Schema identifier must be a string.");
  }
  schemaId = value.schema;
  if (!isProtocolSchemaId(value.schema)) {
    return failure("/schema", `Unsupported schema identifier: ${value.schema}`);
  }
  const schema = protocolSchemaFor(value.schema, value.version);
  if (!schema) {
    schemaVersion =
      typeof value.version === "number" ? value.version : undefined;
    return failure(
      "/version",
      `Unsupported ${value.schema} version: ${String(value.version)}. Supported: ${protocolVersionsFor(value.schema).join(", ")}.`,
    );
  }
  schemaVersion = value.version as number;

  const credential = findForbiddenPairingKey(value);
  if (credential) {
    return failure(
      credential,
      "WebRTC pairing credentials are forbidden in persistent protocol contracts.",
    );
  }

  if (!Value.Check(schema, value)) {
    const first = Value.Errors(schema, value).First();
    return failure(
      first?.path || "/",
      first?.message ?? "Protocol value does not match its v1 schema.",
    );
  }
  if (value.schema === "twrmc/session-policy") {
    const timeError = validateSessionPolicyWindow(value, nowMilliseconds);
    if (timeError) return failure(timeError.path, timeError.message);
  }

  return {
    ok: true,
    json: JSON.stringify(value),
    schema: schemaId,
    version: schemaVersion,
    diagnostic: undefined,
    value,
  };
}

export function formatProtocolDiagnostic(
  diagnostic: ProtocolDiagnostic | undefined,
): string {
  if (!diagnostic) return "Protocol validation failed.";
  return `${diagnostic.path || "/"}: ${diagnostic.message}`;
}

export class ProtocolV1Codec {
  private decoded: unknown;
  private encoded = "";
  private schemaId = "";
  private schemaVersion: number | undefined;
  private diagnostic: ProtocolDiagnostic | undefined;
  private readonly nowMilliseconds: () => number;

  public constructor(nowMilliseconds: () => number = Date.now) {
    this.nowMilliseconds = nowMilliseconds;
  }

  public validate(json: string): boolean {
    return this.process(json, false).ok;
  }

  public decode(json: string): void {
    const result = this.process(json, true);
    if (!result.ok)
      throw new Error(formatProtocolDiagnostic(result.diagnostic));
  }

  public encode(json: string): string {
    const result = this.process(json, true);
    if (!result.ok)
      throw new Error(formatProtocolDiagnostic(result.diagnostic));
    return result.json;
  }

  public decodedJson(): string {
    return this.decoded === undefined ? "" : this.encoded;
  }

  public schema(): string {
    return this.schemaId;
  }

  public version(): number {
    return this.schemaVersion ?? 0;
  }

  public errorPath(): string {
    return this.diagnostic?.path ?? "";
  }

  public errorMessage(): string {
    return this.diagnostic?.message ?? "";
  }

  private process(json: string, retain: boolean): ProtocolCodecResult {
    if (retain) {
      this.decoded = undefined;
      this.encoded = "";
    }
    const result = decodeProtocolJson(json, this.nowMilliseconds());
    this.schemaId = result.schema;
    this.schemaVersion = result.version;
    this.diagnostic = result.diagnostic;
    if (result.ok && retain) {
      this.decoded = result.value;
      this.encoded = result.json;
    }
    return {
      ok: result.ok,
      json: result.json,
      schema: result.schema,
      version: result.version,
      diagnostic: result.diagnostic,
    };
  }
}

function isProtocolSchemaId(value: string): value is ProtocolSchemaId {
  return Object.prototype.hasOwnProperty.call(protocolSchemas, value);
}

function findForbiddenPairingKey(
  value: unknown,
  path = "",
): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenPairingKey(item, `${path}/${index}`);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}/${escapeJsonPointer(key)}`;
    const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, "");
    if (FORBIDDEN_PAIRING_KEYS.has(normalized)) return itemPath;
    const found = findForbiddenPairingKey(item, itemPath);
    if (found) return found;
  }
  return undefined;
}

function validateSessionPolicyWindow(
  value: Record<string, unknown>,
  nowMilliseconds: number,
): ProtocolDiagnostic | undefined {
  const issuedAt = Date.parse(String(value.issuedAt));
  const expiresAt = Date.parse(String(value.expiresAt));
  if (expiresAt <= issuedAt) {
    return { path: "/expiresAt", message: "Must be later than issuedAt." };
  }
  if (expiresAt <= nowMilliseconds) {
    return { path: "/expiresAt", message: "Session policy has expired." };
  }
  return undefined;
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
