import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { protocolSchemas } from "../src/protocol/schemas.ts";

interface PackageMetadata {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  homepage?: string;
  packageManager?: string;
  engines?: { node?: string };
  repository?: { url?: string };
  bugs?: { url?: string };
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface RepoPolicy {
  schemaVersion: number;
  productName: string;
  packageType: string;
  licensePolicy: string;
  readmeLanguages: string[];
  canonicalReadme: string;
  localizedReadmes: {
    ja: string;
  };
  node: {
    minimum: string;
  };
  packageManager: string;
  requiredFiles: string[];
  exceptions: {
    upstreamFork: boolean;
    mixedContentLicenses: boolean;
    legacyPackageName: boolean;
    thirdPartyBundle: boolean;
  };
  migrationChecklist: string[];
}

interface PackResult {
  version: string;
  files: { path: string }[];
}

interface ProtocolIntegrityManifest {
  formatVersion: number;
  sourceRepository: string;
  sourceCommit: string;
  sourcePackage: string;
  canonicalization: string;
  digest: string;
  schemas: Record<string, string>;
}

const execFileAsync = promisify(execFile);
const errors: string[] = [];

const packageMetadata = JSON.parse(
  await readFile("package.json", "utf8"),
) as PackageMetadata;
const policy = JSON.parse(
  await readFile("repo-policy.json", "utf8"),
) as RepoPolicy;
const readme = await readFile(policy.canonicalReadme, "utf8");
const readmeJa = await readFile(policy.localizedReadmes.ja, "utf8");
const license = await readFile("LICENSE", "utf8");
const config = await readFile("src/config.ts", "utf8");
const poseAdapter = await readFile("src/pose/tfjs-movenet.ts", "utf8");
const poseController = await readFile("src/pose/controller.ts", "utf8");
const calibrationBackend = await readFile(
  "src/calibration/opencv-backend.ts",
  "utf8",
);
const calibrationController = await readFile(
  "src/calibration/controller.ts",
  "utf8",
);
const fusionController = await readFile("src/fusion/controller.ts", "utf8");
const fusionBuffer = await readFile("src/fusion/jitter-buffer.ts", "utf8");
const featureFlagSource = await readFile("config/feature-flags.ts", "utf8");
const protocolIntegrity = JSON.parse(
  await readFile("schemas/protocol-v1-integrity.json", "utf8"),
) as ProtocolIntegrityManifest;

checkPolicy();
checkPackageMetadata();
checkReadmes();
checkLicense();
checkGeneratedArtifacts();
checkPosePolicy();
checkCalibrationPolicy();
checkFusionPolicy();
await checkProtocolSchemaIntegrity();
await checkPackContents();

if (errors.length > 0) {
  throw new Error(`Repository policy check failed:\n- ${errors.join("\n- ")}`);
}

process.stdout.write("Repository policy is aligned.\n");

function checkPolicy() {
  if (policy.schemaVersion !== 1)
    errors.push("repo-policy.json schemaVersion must be 1");
  if (policy.productName !== "TurboWarp-Multiview-Pose") {
    errors.push("repo-policy.json productName must match README.md H1");
  }
  if (policy.licensePolicy !== "mpl-2.0") {
    errors.push("repo-policy.json licensePolicy must be mpl-2.0");
  }
  if (policy.packageManager !== "pnpm") {
    errors.push("repo-policy.json packageManager must be pnpm");
  }
  if (
    !Array.isArray(policy.migrationChecklist) ||
    policy.migrationChecklist.length === 0
  ) {
    errors.push("repo-policy.json must include a migration checklist");
  }
}

function checkPackageMetadata() {
  const requiredStrings = [
    "description",
    "author",
    "license",
    "homepage",
    "packageManager",
  ] as const;
  for (const key of requiredStrings) {
    const value = packageMetadata[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(`package.json ${key} must be a non-empty string`);
    }
  }
  if (packageMetadata.license !== "MPL-2.0")
    errors.push("package.json license must be MPL-2.0");
  if (!packageMetadata.packageManager?.startsWith("pnpm@")) {
    errors.push("package.json packageManager must pin pnpm exactly");
  }
  if (packageMetadata.engines?.node !== ">=22.18.0") {
    errors.push("package.json engines.node must be >=22.18.0");
  }
  if (
    packageMetadata.repository?.url !==
    "git+https://github.com/kubohiroya/turbowarp-multiview-pose.git"
  ) {
    errors.push(
      "package.json repository.url must point to the current repository",
    );
  }
  if (
    packageMetadata.bugs?.url !==
    "https://github.com/kubohiroya/turbowarp-multiview-pose/issues"
  ) {
    errors.push(
      "package.json bugs.url must point to the current issue tracker",
    );
  }
  for (const file of policy.requiredFiles) {
    if (!packageMetadata.files?.includes(file)) {
      errors.push(`package.json files must include ${file}`);
    }
  }
  for (const command of ["docs:check", "check", "check:dist"]) {
    if (/\bnpm run\b/u.test(packageMetadata.scripts?.[command] ?? "")) {
      errors.push(`package.json ${command} must use pnpm run`);
    }
  }
}

function checkReadmes() {
  if (!readme.startsWith(`# ${policy.productName}\n`)) {
    errors.push("README.md H1 must match repo-policy.json productName");
  }
  if (!readme.includes("[日本語](README.ja.md)")) {
    errors.push("README.md must link to README.ja.md");
  }
  if (!readme.includes("## What it does"))
    errors.push("README.md must include What it does");
  if (!readme.includes("## Requirements and safety")) {
    errors.push("README.md must include Requirements and safety");
  }
  if (!readme.includes("## Block reference")) {
    errors.push(
      "README.md generated block section heading must be Block reference",
    );
  }
  if ((readme.match(/<!-- BEGIN GENERATED BLOCKS -->/g) ?? []).length !== 1) {
    errors.push(
      "README.md must contain exactly one generated block start marker",
    );
  }
  if ((readme.match(/<!-- END GENERATED BLOCKS -->/g) ?? []).length !== 1) {
    errors.push(
      "README.md must contain exactly one generated block end marker",
    );
  }
  if (!readme.includes(`${packageMetadata.name}@${packageMetadata.version}`)) {
    errors.push("README.md must include a version-pinned package example");
  }
  if (!readme.includes("MPL-2.0"))
    errors.push("README.md License section must include MPL-2.0");
  if (!readmeJa.startsWith(`# ${policy.productName}\n`)) {
    errors.push("README.ja.md must mirror the product H1");
  }
}

function checkLicense() {
  if (
    !license.startsWith(
      "Mozilla Public License Version 2.0\n==================================",
    )
  ) {
    errors.push(
      "LICENSE must contain the Mozilla Public License Version 2.0 full text",
    );
  }
  if (!license.includes("Exhibit A - Source Code Form License Notice")) {
    errors.push("LICENSE must include the MPL-2.0 Exhibit A text");
  }
  if (!/license:\s*["']MPL-2\.0["']/u.test(config)) {
    errors.push("src/config.ts must expose MPL-2.0 bundle metadata");
  }
}

function checkGeneratedArtifacts() {
  const expectedBundle = `dist/${extractConfigValue("slug")}.js`;
  if (!packageMetadata.files?.includes("dist/"))
    errors.push("package.json files must include dist/");
  if (!readme.includes(expectedBundle))
    errors.push(`README.md must document ${expectedBundle}`);
}

function checkPosePolicy() {
  const exactDependencies = {
    "@tensorflow-models/pose-detection": "2.1.3",
    "@tensorflow/tfjs-backend-webgpu": "4.22.0",
    "@tensorflow/tfjs-converter": "4.22.0",
    "@tensorflow/tfjs-core": "4.22.0",
  };
  for (const [name, version] of Object.entries(exactDependencies)) {
    if (packageMetadata.dependencies?.[name] !== version) {
      errors.push(`package.json must pin ${name} exactly to ${version}`);
    }
  }
  if (!poseAdapter.includes('setBackend("webgpu")')) {
    errors.push("MoveNet adapter must explicitly select the webgpu backend");
  }
  for (const required of [
    "MULTIPOSE_LIGHTNING",
    "enableTracking: true",
    "TrackerType.BoundingBox",
  ]) {
    if (!poseAdapter.includes(required)) {
      errors.push(`MoveNet adapter must configure ${required}`);
    }
  }
  if (/tfjs-backend-(?:cpu|wasm|webgl)/u.test(poseAdapter)) {
    errors.push(
      "MoveNet adapter must not import CPU, WASM, or WebGL fallback backends",
    );
  }
  if (
    poseAdapter.includes("getUserMedia(") ||
    poseController.includes("getUserMedia(")
  ) {
    errors.push(
      "MoveNet pipeline must acquire frames only through Camera Source",
    );
  }
}

function checkCalibrationPolicy() {
  if (
    packageMetadata.dependencies?.["@techstark/opencv-js"] !==
    "4.12.0-release.1"
  ) {
    errors.push(
      "package.json must pin @techstark/opencv-js exactly to 4.12.0-release.1",
    );
  }
  for (const required of [
    "findChessboardCorners",
    "cornerSubPix",
    "calibrateCamera",
    "Rodrigues",
  ]) {
    if (!calibrationBackend.includes(required)) {
      errors.push(`OpenCV calibration backend must call ${required}`);
    }
  }
  if (
    calibrationBackend.includes("getUserMedia(") ||
    calibrationController.includes("getUserMedia(")
  ) {
    errors.push("Calibration must acquire frames only through Camera Source");
  }
  if (!featureFlagSource.includes("cameraCalibrationV1")) {
    errors.push("Camera calibration must have a startup-fixed feature flag");
  }
}

function checkFusionPolicy() {
  if (!featureFlagSource.includes("poseFusion3D")) {
    errors.push("Pose fusion must have a startup-fixed feature flag");
  }
  if (!fusionController.includes("PoseFrame3DSchema")) {
    errors.push(
      "Fusion must validate every fused frame against the pinned PoseFrame3D v1 schema",
    );
  }
  for (const [name, source] of [
    ["src/fusion/controller.ts", fusionController],
    ["src/fusion/jitter-buffer.ts", fusionBuffer],
  ] as const) {
    if (/performance\.(?:timeOrigin|now)|clockId|clock-probe/u.test(source)) {
      errors.push(
        `${name} must carry external timestamps without implementing a clock`,
      );
    }
    if (source.includes("getUserMedia(")) {
      errors.push(`${name} must not capture media directly`);
    }
  }
}

async function checkProtocolSchemaIntegrity() {
  if (packageMetadata.dependencies?.["@sinclair/typebox"] !== "0.34.52") {
    errors.push("package.json must pin @sinclair/typebox exactly to 0.34.52");
  }
  if (Reflect.has(protocolSchemas, "twmp/clock-probe")) {
    errors.push("ClockProbe belongs to the external synchronized time service");
  }
  if (
    JSON.stringify(protocolSchemas["twmp/pose-frame-2d"]).includes("clockId")
  ) {
    errors.push("PoseFrame2D must not contain clockId");
  }
  if (
    /performance\.(?:timeOrigin|now)|clockId|clock-probe/u.test(poseController)
  ) {
    errors.push(
      "Pose inference must carry external timestamps without implementing a clock",
    );
  }
  if (
    protocolIntegrity.formatVersion !== 1 ||
    protocolIntegrity.sourceRepository !==
      "https://github.com/kubohiroya/multiview-pose.git" ||
    protocolIntegrity.sourcePackage !== "packages/protocol" ||
    !/^[0-9a-f]{40}$/u.test(protocolIntegrity.sourceCommit) ||
    protocolIntegrity.digest !== "sha256" ||
    protocolIntegrity.canonicalization !== "JSON.stringify(JSON.parse(source))"
  ) {
    errors.push("protocol-v1-integrity.json metadata is invalid");
  }

  const schemaIdsByFile = {
    "camera-calibration-v1.json": "twmp/camera-calibration",
    "performance-dsl-v1.json": "twmp/performance-dsl",
    "pose-frame-2d-v1.json": "twmp/pose-frame-2d",
    "pose-frame-3d-v1.json": "twmp/pose-frame-3d",
    "session-policy-v1.json": "twmp/session-policy",
  } as const;
  if (
    Object.keys(protocolIntegrity.schemas).sort().join("\n") !==
    Object.keys(schemaIdsByFile).sort().join("\n")
  ) {
    errors.push(
      "protocol integrity manifest must list exactly five v1 schemas",
    );
    return;
  }
  for (const [filename, schemaId] of Object.entries(schemaIdsByFile)) {
    const expected = protocolIntegrity.schemas[filename];
    const actual = canonicalJsonHash(protocolSchemas[schemaId]);
    if (actual !== expected) {
      errors.push(
        `runtime schema ${filename} hash ${actual} does not match pinned ${expected}`,
      );
    }
  }

  const sourceDirectory =
    process.env.MULTIVIEW_POSE_PROTOCOL_SCHEMA_DIR ??
    resolve(process.cwd(), "../multiview-pose/packages/protocol/schemas");
  try {
    await access(sourceDirectory);
  } catch {
    return;
  }
  for (const [filename, expected] of Object.entries(
    protocolIntegrity.schemas,
  )) {
    const source = JSON.parse(
      await readFile(resolve(sourceDirectory, filename), "utf8"),
    ) as unknown;
    const actual = canonicalJsonHash(source);
    if (actual !== expected) {
      errors.push(
        `upstream protocol schema drift for ${filename}: ${actual} != ${expected}`,
      );
    }
  }
}

function canonicalJsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function checkPackContents() {
  const { stdout } = await execFileAsync("npm", [
    "pack",
    "--dry-run",
    "--ignore-scripts",
    "--json",
  ]);
  const [pack] = JSON.parse(stdout) as PackResult[];
  if (!pack) {
    errors.push("npm pack must report a package");
    return;
  }
  const files = new Set(pack.files.map((file) => file.path));
  for (const file of policy.requiredFiles) {
    if (!files.has(file)) errors.push(`npm pack must include ${file}`);
  }
  if (!files.has(`dist/${extractConfigValue("slug")}.js`)) {
    errors.push("npm pack must include the generated extension bundle");
  }
  await access("pnpm-lock.yaml");
}

function extractConfigValue(key: string): string {
  const match = config.match(new RegExp(`${key}:\\s*["']([^"']+)["']`));
  if (!match?.[1]) throw new Error(`src/config.ts must define ${key}`);
  return match[1];
}
