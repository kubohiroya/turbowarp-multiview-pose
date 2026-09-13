import { mkdir, writeFile } from "node:fs/promises";
import { protocolSchemaFiles } from "../src/protocol/schemas.ts";

const outputDirectory = new URL("../schemas/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
for (const [filename, schema] of Object.entries(protocolSchemaFiles)) {
  await writeFile(
    new URL(filename, outputDirectory),
    `${JSON.stringify(schema, null, 2)}\n`,
  );
}
process.stdout.write(
  `Generated ${Object.keys(protocolSchemaFiles).length} protocol JSON Schemas.\n`,
);
