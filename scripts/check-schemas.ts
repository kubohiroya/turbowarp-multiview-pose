import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const [{ stdout: modified }, { stdout: untracked }] = await Promise.all([
  execFileAsync("git", ["diff", "--name-only", "--", "schemas"], {
    cwd: repositoryRoot,
  }),
  execFileAsync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", "schemas"],
    { cwd: repositoryRoot },
  ),
]);

const staleFiles = `${modified}${untracked}`;
if (staleFiles.length > 0) {
  process.stderr.write("Generated protocol JSON Schemas are not up to date:\n");
  process.stderr.write(staleFiles);
  process.exitCode = 1;
}
