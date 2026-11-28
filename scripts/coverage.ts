import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

class CoverageError extends Schema.TaggedError<CoverageError, { readonly brand: unique symbol }>()(
  "CoverageError",
  {
    message: Schema.String,
  },
) {}

interface WorkspaceTarget {
  readonly path: string;
  readonly testArgs: readonly string[];
}

const WORKSPACES: readonly WorkspaceTarget[] = [
  { path: "packages/domain", testArgs: ["--pass-with-no-tests"] },
  { path: "packages/api-contract", testArgs: ["--pass-with-no-tests"] },
  { path: "packages/brand", testArgs: ["--pass-with-no-tests"] },
  { path: "packages/db", testArgs: ["--pass-with-no-tests"] },
  { path: "packages/ui-port", testArgs: ["--pass-with-no-tests"] },
  { path: "packages/adapters", testArgs: ["--pass-with-no-tests"] },
  { path: "packages/core", testArgs: ["--pass-with-no-tests"] },
  { path: "apps/server", testArgs: ["--pass-with-no-tests"] },
  { path: "apps/web", testArgs: ["test"] },
  { path: "apps/mobile", testArgs: [] },
  { path: "infra/alchemy", testArgs: ["--pass-with-no-tests"] },
];

const rewriteLcovPaths = (
  lcov: string,
  root: string,
  workspaceDir: string,
  pathApi: Path.Path,
): string => {
  const lines = Str.split("\n")(lcov);
  const rewritten = Arr.map(lines, (line) => {
    if (!Str.startsWith("SF:")(line)) return line;
    const raw = Str.slice(3)(line);
    if (Str.isEmpty(raw)) return line;
    const absolute = pathApi.isAbsolute(raw) ? raw : pathApi.resolve(workspaceDir, raw);
    const relative = Str.replaceAll("\\", "/")(pathApi.relative(root, absolute));
    return `SF:${relative}`;
  });
  return Arr.join(rewritten, "\n");
};

const collectWorkspaceCoverage = Effect.fn("Coverage.collectWorkspace")(function* (
  root: string,
  tempDir: string,
  target: WorkspaceTarget,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathApi = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const workspaceDir = pathApi.join(root, target.path);
  const outDir = pathApi.join(tempDir, Str.replaceAll("/", "-")(target.path));

  yield* Console.log(`> coverage: ${target.path}`);
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(
      "bun",
      [
        "test",
        ...target.testArgs,
        "--coverage",
        "--coverage-reporter=lcov",
        `--coverage-dir=${outDir}`,
      ],
      { cwd: workspaceDir, stdout: "inherit", stderr: "inherit" },
    ),
  );
  if (exitCode !== 0) {
    return yield* CoverageError.make({
      message: `Tests failed in ${target.path} (exit ${String(exitCode)})`,
    });
  }

  const lcovPath = pathApi.join(outDir, "lcov.info");
  if (!(yield* fs.exists(lcovPath))) return "";
  const raw = yield* fs.readFileString(lcovPath);
  return rewriteLcovPaths(raw, root, workspaceDir, pathApi);
});

const collectAllCoverage = Effect.fn("Coverage.run")(function* (filter: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const pathApi = yield* Path.Path;
  const root = yield* pathApi.fromFileUrl(new URL("..", import.meta.url));
  const selected =
    filter.length === 0
      ? WORKSPACES
      : Arr.filter(WORKSPACES, (ws) =>
          Arr.some(filter, (arg) => ws.path === arg || Str.startsWith(`${arg}/`)(ws.path)),
        );

  if (selected.length === 0) {
    return yield* CoverageError.make({
      message: `No workspaces matched filter: ${Arr.join(filter, ", ")}`,
    });
  }

  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "kvitbit-coverage-" });
  const chunks: Array<string> = [];
  for (const target of selected) {
    const chunk = yield* collectWorkspaceCoverage(root, tempDir, target);
    if (Str.isNonEmpty(Str.trim(chunk))) {
      chunks.push(Str.trimEnd(chunk));
    }
  }

  const coverageDir = pathApi.join(root, "coverage");
  yield* fs.makeDirectory(coverageDir, { recursive: true });
  const mergedPath = pathApi.join(coverageDir, "lcov.info");
  const content = chunks.length === 0 ? "" : `${Arr.join(chunks, "\n")}\n`;
  yield* fs.writeFileString(mergedPath, content);
  yield* Console.log(`Wrote merged LCOV coverage to ${mergedPath}`);
});

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const program =
    args.includes("--help") || args.includes("-h")
      ? Console.log("Usage: bun run coverage [workspace-path...]")
      : collectAllCoverage(args);
  BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(BunServices.layer)));
}
