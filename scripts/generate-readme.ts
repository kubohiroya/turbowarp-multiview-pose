import { readFile, writeFile } from "node:fs/promises";

interface BlockArgument {
  type: string;
  defaultValue?: boolean | number | string;
  menu?: string;
}

interface BlockDefinition {
  opcode: string;
  blockType: string;
  text: string;
  description: string;
  arguments: Record<string, BlockArgument>;
}

interface BlockDefinitions {
  extensionName: string;
  blocks: BlockDefinition[];
}

const START = "<!-- BEGIN GENERATED BLOCKS -->";
const END = "<!-- END GENERATED BLOCKS -->";

const definitions = JSON.parse(
  await readFile(
    new URL("../src/block-definitions.json", import.meta.url),
    "utf8",
  ),
) as BlockDefinitions;
const generated = definitions.blocks.map(renderBlock).join("\n\n");
const generatedDocuments = [
  {
    path: "../README.md",
    content: `${START}\n\nSee the [TurboWarp extension API](docs/turbowarp-extension-api.md) for every block.\n\n${END}`,
  },
  {
    path: "../docs/turbowarp-extension-api.md",
    content: `${START}\n\n${generated}\n\n${END}`,
  },
];

for (const document of generatedDocuments) {
  const documentUrl = new URL(document.path, import.meta.url);
  const source = await readFile(documentUrl, "utf8");
  if (!source.includes(START) || !source.includes(END)) {
    throw new Error(
      `${document.path} does not contain the generated block markers.`,
    );
  }
  const next = source.replace(
    new RegExp(`${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}`),
    document.content,
  );
  await writeFile(documentUrl, next);
}

function renderBlock(block: BlockDefinition): string {
  const rows = [
    ["Type", titleCase(block.blockType)],
    ["Opcode", `\`${block.opcode}\``],
  ];
  for (const [name, argument] of Object.entries(block.arguments ?? {})) {
    rows.push([
      `\`${name}\``,
      `${titleCase(argument.type)}, default: \`${formatDefault(argument.defaultValue)}\``,
    ]);
  }
  return [
    `### \`${block.text}\``,
    "",
    block.description,
    "",
    "| Property | Value |",
    "|---|---|",
    ...rows.map(([name, value]) => `| ${name} | ${value} |`),
  ].join("\n");
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatDefault(value: BlockArgument["defaultValue"]): string {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("`", "\\`");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
