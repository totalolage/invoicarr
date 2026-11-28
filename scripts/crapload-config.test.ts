import { expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const readReport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      results: Schema.Array(Schema.Struct({ path: Schema.String, name: Schema.String })),
    }),
  ),
);

test("Crapload scores production units and skips colocated test support", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = path.resolve(import.meta.dir, "..");
    const production = "apps/mobile/src/features/expenses/model.ts";
    const fixtures = [
      "apps/mobile/src/features/documents/test-ui-shim.tsx",
      "apps/mobile/src/features/expenses/capture-shell-fixture.tsx",
      "apps/mobile/src/features/expenses/expenses-probe.tsx",
      "apps/mobile/src/features/reports/test-probe.tsx",
      "apps/mobile/src/features/test-probes.tsx",
      "apps/mobile/src/platform/transfer/testing.ts",
      "apps/mobile/src/updates/expo-updates-stand-in.ts",
      "packages/core/src/modules/documents/fakes.ts",
    ];
    for (const fixture of fixtures) {
      const exists = yield* fs.exists(path.join(root, fixture));
      expect(exists, fixture).toBe(true);
    }

    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          "node_modules/crapload/src/cli.ts",
          "--config",
          "crapload.config.json",
          "--no-coverage",
          "--max-complexity",
          "1000",
          "--format",
          "json",
          production,
          ...fixtures,
        ],
        { cwd: root, stderr: "inherit" },
      ),
    );
    const { exitCode, stdout } = yield* Effect.all(
      { exitCode: child.exitCode, stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString) },
      { concurrency: "unbounded" },
    );
    expect(Number(exitCode)).toBe(0);
    const { results } = yield* readReport(stdout);
    expect(results).toContainEqual({ path: production, name: "filterExpenses" });
    expect(Arr.dedupe(Arr.map(results, (unit) => unit.path))).toEqual([production]);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise));
