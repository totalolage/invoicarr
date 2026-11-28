import { describe, expect, test } from "bun:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Arr from "effect/Array";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { parseDeployWorkflow } from "./deploy-workflow";
import { runCommand, runSerial, systemPath } from "./process-fixture";

const encodeJsonValue = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Fn.flow(encodeJsonValue, Result.getOrThrow);

const environmentLibMkoptionPattern = /environment\s*=\s*lib\.mkOption\s*\{[\s\S]*?\n\s*\};/;
const blobdriverLibMkoptionPattern = /blobDriver\s*=\s*lib\.mkOption\s*\{[\s\S]*?\n\s*\};/;
const botprotectionmodeLibMkoptionPattern =
  /botProtectionMode\s*=\s*lib\.mkOption\s*\{[\s\S]*?\n\s*\};/;
const systemdServicesKvitbitPattern =
  /systemd\.services\.kvitbit\s*=\s*\{[\s\S]*?serviceConfig\s*=/;
const environmentPattern = /environment\s*=\s*\{([\s\S]*?)\}/;
const defaultPattern = /default\s*=\s*([^;]+);/;
const matchPattern = /^sha256:[a-f0-9]{64}$/;

const fs = await FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer), Effect.runPromise);
const { join, resolve } = Path.Path.pipe(Effect.provide(Path.layer), Effect.runSync);
const repoRoot = resolve(import.meta.dir, "../../..");
const entrypointPath = join(repoRoot, "docker/entrypoint.sh");
const syntheticPassword = "synthetic";
const postgresDsn = (user: string) => (target: string) =>
  `postgres://${user}:${syntheticPassword}@${target}`;
const appDsn = postgresDsn("app");
const ownerDsn = postgresDsn("owner");
const onBundledDatabase = (query: string) => appDsn(`postgres:5432/kvitbit?${query}`);
const cliValueFormat = (field: string) => `--format='value(${field})'`;
const postgres17Version = /^17[0-9]{4}$/;
const ownershipDenied = /must be owner|permission denied/;
const sha256Digest = /^sha256:[a-f0-9]{64}$/;
const shellReference = (text: string) => `\${${text}}`;

const runEntrypoint = (args: ReadonlyArray<string>, env: Record<string, string>) =>
  runCommand({ command: ["sh", entrypointPath, ...args], env: { PATH: systemPath, ...env } });

const environment = Schema.Record(Schema.String, Schema.String);
const dependsOn = Schema.Record(Schema.String, Schema.Struct({ condition: Schema.String }));
const Compose = Schema.Struct({
  services: Schema.Struct({
    postgres: Schema.Struct({ volumes: Schema.Array(Schema.String), environment }),
    migrate: Schema.Struct({ environment }),
    "reconcile-roles": Schema.Struct({
      depends_on: dependsOn,
      volumes: Schema.Array(Schema.String),
      environment,
    }),
    kvitbit: Schema.Struct({ depends_on: dependsOn, environment }),
  }),
});
const decodeCompose = Schema.decodeUnknownEffect(Compose);

const literalInterpolation = (expression: string): string => `\${${expression}}`;

describe("docker/entrypoint.sh dispatch contract (#878, #908, #913)", () => {
  test("exits 69 with clear stderr message when apps/server is absent", async () => {
    const sandbox = await Effect.runPromise(
      fs.makeTempDirectory({ prefix: "kvitbit-ep-missing-" }),
    );
    try {
      const serverRes = await runEntrypoint(["server"], { KVITBIT_APP_ROOT: sandbox });
      expect(serverRes.exitCode).toBe(69);
      expect(serverRes.stderr).toContain("apps/server/src/main.ts");

      const workerRes = await runEntrypoint(["worker"], { KVITBIT_APP_ROOT: sandbox });
      expect(workerRes.exitCode).toBe(69);
      expect(workerRes.stderr).toContain("apps/server/src/worker.ts");
    } finally {
      await Effect.runPromise(fs.remove(sandbox, { recursive: true, force: true }));
    }
  });

  test("dispatches server, worker, and migrate to bun with expected entrypoints", async () => {
    const sandbox = await Effect.runPromise(fs.makeTempDirectory({ prefix: "kvitbit-ep-ok-" }));
    try {
      const serverDir = join(sandbox, "apps/server/src");
      await Effect.runPromise(fs.makeDirectory(serverDir, { recursive: true }));
      await Effect.runPromise(fs.writeFileString(join(serverDir, "main.ts"), "// main\n"));
      await Effect.runPromise(fs.writeFileString(join(serverDir, "worker.ts"), "// worker\n"));
      await Effect.runPromise(fs.writeFileString(join(serverDir, "migrate.ts"), "// migrate\n"));

      const fakeBun = join(sandbox, "fake-bun.sh");
      await Effect.runPromise(fs.writeFileString(fakeBun, '#!/bin/sh\necho "FAKE_BUN:$*"\n'));
      await Effect.runPromise(fs.chmod(fakeBun, 0o755));

      const serverRes = await runEntrypoint(["server"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
      });
      expect(serverRes.exitCode).toBe(0);
      expect(Str.trim(serverRes.stdout)).toBe(`FAKE_BUN:${join(serverDir, "main.ts")}`);

      const workerRes = await runEntrypoint(["worker"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
      });
      expect(workerRes.exitCode).toBe(0);
      expect(Str.trim(workerRes.stdout)).toBe(`FAKE_BUN:${join(serverDir, "worker.ts")}`);

      const migrateNoDb = await runEntrypoint(["migrate"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
      });
      expect(migrateNoDb.exitCode).toBe(64);

      const migrateRuntimeOnly = await runEntrypoint(["migrate"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
        DATABASE_URL: "postgres://app:pw@external.invalid:5432/kvitbit",
      });
      expect(migrateRuntimeOnly.exitCode).toBe(64);
      expect(migrateRuntimeOnly.stderr).toContain("direct owner connection");

      const migrateOk = await runEntrypoint(["migrate"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
        DATABASE_URL_UNPOOLED: `postgres://user:${syntheticPassword}@localhost:5432/kvitbit`,
      });
      expect(migrateOk.exitCode).toBe(0);
      expect(Str.trim(migrateOk.stdout)).toBe(`FAKE_BUN:${join(serverDir, "migrate.ts")}`);

      // External DATABASE_URL with missing DATABASE_URL_UNPOOLED must fail fast instead of
      // silently falling back to bundled postgres.
      const migrateExternalMissingUnpooled = await runEntrypoint(["migrate"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
        KVITBIT_RUNTIME_DATABASE_URL: "postgres://app:pw@external.invalid:5432/kvitbit",
        KVITBIT_BUNDLED_MIGRATION_URL: `postgres://kvitbit:${syntheticPassword}@postgres:5432/kvitbit`,
      });
      expect(migrateExternalMissingUnpooled.exitCode).toBe(64);
      expect(migrateExternalMissingUnpooled.stderr).toContain("external database");

      // Bundled postgres fallback succeeds when runtime URL is unset
      const migrateBundled = await runEntrypoint(["migrate"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
        KVITBIT_BUNDLED_MIGRATION_URL: `postgres://kvitbit:${syntheticPassword}@postgres:5432/kvitbit`,
      });
      expect(migrateBundled.exitCode).toBe(0);
      expect(Str.trim(migrateBundled.stdout)).toBe(`FAKE_BUN:${join(serverDir, "migrate.ts")}`);
    } finally {
      await Effect.runPromise(fs.remove(sandbox, { recursive: true, force: true }));
    }
  });

  test("healthcheck verifies GET 127.0.0.1:$PORT/healthz and exec fallback runs arbitrary commands", async () => {
    let status = 200;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") {
          return new Response(status === 200 ? "ok" : "unhealthy", { status });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const ok = await runEntrypoint(["healthcheck"], {
        PORT: String(server.port),
        KVITBIT_BUN_BIN: process.execPath,
      });
      expect(ok.exitCode).toBe(0);

      status = 503;
      const fail = await runEntrypoint(["healthcheck"], {
        PORT: String(server.port),
        KVITBIT_BUN_BIN: process.execPath,
      });
      expect(fail.exitCode).not.toBe(0);
    } finally {
      server.stop(true);
    }

    const arbitrary = await runEntrypoint(["echo", "kvitbit-ok"], {});
    expect(arbitrary.exitCode).toBe(0);
    expect(Str.trim(arbitrary.stdout)).toBe("kvitbit-ok");
  });

  test("migrate and reconcile require the bundled host, port, and database before using owner credentials", async () => {
    const sandbox = await Effect.runPromise(
      fs.makeTempDirectory({ prefix: "kvitbit-ep-migrate-" }),
    );
    try {
      const serverDir = join(sandbox, "apps/server/src");
      await Effect.runPromise(fs.makeDirectory(serverDir, { recursive: true }));
      await Effect.runPromise(fs.writeFileString(join(serverDir, "migrate.ts"), "// migrate\n"));
      const fakeBun = join(sandbox, "fake-bun.sh");
      await Effect.runPromise(
        fs.writeFileString(fakeBun, '#!/bin/sh\nprintf "%s\\n" "$DATABASE_URL_UNPOOLED"\n'),
      );
      await Effect.runPromise(fs.chmod(fakeBun, 0o755));

      const bundledUrl = ownerDsn("postgres:5432/kvitbit");
      const ownerUrl = ownerDsn("postgres:5432/other");
      const migrate = (url: string, owner?: string) => {
        const env = {
          KVITBIT_APP_ROOT: sandbox,
          KVITBIT_BUN_BIN: fakeBun,
          KVITBIT_RUNTIME_DATABASE_URL: url,
          KVITBIT_BUNDLED_DATABASE_NAME: "kvitbit",
          KVITBIT_BUNDLED_MIGRATION_URL: bundledUrl,
        };
        return runEntrypoint(
          ["migrate"],
          owner === undefined ? env : { ...env, DATABASE_MIGRATION_URL: owner },
        );
      };

      const escapedCredentials = "app:p%40ss";
      const escapedDatabase = "kvit%62it";
      const unescapedTarget = "postgres:5432";
      const otherHost = "away.invalid";
      const same = await migrate(
        `postgresql://${escapedCredentials}@Postgres/${escapedDatabase}?sslmode=disable`,
      );
      expect(same.exitCode).toBe(0);
      expect(Str.trim(same.stdout)).toBe(bundledUrl);

      await runSerial([
        appDsn("postgres:5432/other"),
        appDsn("postgres:5433/kvitbit"),
        appDsn(`away.invalid:5432/kvitbit?application_name=@${unescapedTarget}`),
        onBundledDatabase("%68ost=away.invalid"),
        onBundledDatabase("port=5433"),
        onBundledDatabase(`host=${otherHost}&host=postgres`),
        onBundledDatabase("dbname=other"),
      ])(async (url) => {
        const rejected = await migrate(url);
        expect(rejected.exitCode).toBe(64);
        expect(rejected.stdout).toBe("");
        expect(rejected.stderr).not.toContain("synthetic");
      });

      const explicit = await migrate(appDsn("postgres:5432/other"), ownerUrl);
      expect(explicit.exitCode).toBe(0);
      expect(Str.trim(explicit.stdout)).toBe(ownerUrl);

      const invalidFallback = await runEntrypoint(["migrate"], {
        KVITBIT_APP_ROOT: sandbox,
        KVITBIT_BUN_BIN: fakeBun,
        KVITBIT_BUNDLED_DATABASE_NAME: "kvitbit",
        KVITBIT_BUNDLED_MIGRATION_URL: ownerUrl,
      });
      expect(invalidFallback.exitCode).toBe(64);
      expect(invalidFallback.stdout).toBe("");

      const runtimeUrl = appDsn("postgres:5432/second_db");
      const fakePsql = join(sandbox, "psql");
      await Effect.runPromise(
        fs.writeFileString(fakePsql, '#!/bin/sh\nprintf "%s\\n" "unexpected owner access"\n'),
      );
      await Effect.runPromise(fs.chmod(fakePsql, 0o755));
      await runSerial([{ DATABASE_URL: runtimeUrl }, { KVITBIT_RUNTIME_DATABASE_URL: runtimeUrl }])(
        async (runtime) => {
          const wrongDatabase = await runEntrypoint(["migrate"], {
            KVITBIT_APP_ROOT: sandbox,
            KVITBIT_BUN_BIN: fakeBun,
            KVITBIT_BUNDLED_DATABASE_NAME: "first_db",
            KVITBIT_BUNDLED_MIGRATION_URL: ownerDsn("postgres:5432/first_db"),
            ...runtime,
          });
          expect(wrongDatabase.exitCode).toBe(64);
          expect(wrongDatabase.stdout).toBe("");

          const roleResult = await runCommand({
            command: ["sh", join(repoRoot, "docker/reconcile-app-role.sh")],
            env: {
              PATH: `${sandbox}:${systemPath}`,
              PGHOST: "postgres",
              PGPORT: "5432",
              POSTGRES_DB: "first_db",
              ...runtime,
            },
          });
          expect(roleResult.exitCode).toBe(64);
          expect(roleResult.stdout).toBe("");
          expect(roleResult.stderr).toContain("different database");
        },
      );
    } finally {
      await Effect.runPromise(fs.remove(sandbox, { recursive: true, force: true }));
    }
  });
});

describe("Self-hosting and CI deploy artifacts", () => {
  test("Dockerfile includes static assets, Bun 1.4.2 multi-stage build, Chromium, non-root uid 10001, and tini entrypoint", async () => {
    const dockerfile = await Effect.runPromise(fs.readFileString(join(repoRoot, "Dockerfile")));
    const dockerignore = await Effect.runPromise(
      fs.readFileString(join(repoRoot, ".dockerignore")),
    );

    // Static assets (assets/brand) must be in Docker build context and copied before web/mobile builds
    const ignoredLines = Arr.filter(
      Arr.map(Str.split("\n")(dockerignore), (line) => Str.trim(line)),
      (line) => line.length > 0 && !Str.startsWith("#")(line),
    );
    expect(ignoredLines).not.toContain("assets");
    expect(ignoredLines).not.toContain("assets/brand");
    expect(dockerfile).toContain("COPY assets ./assets");
    expect(
      Option.getOrElse(Str.indexOf("COPY assets ./assets")(dockerfile), () => -1),
    ).toBeLessThan(
      Option.getOrElse(Str.indexOf("bun run --filter @kvitbit/web build")(dockerfile), () => -1),
    );

    expect(dockerfile).toContain("ARG BUN_VERSION=1.4.2");
    expect(dockerfile).toContain("AS builder");
    expect(dockerfile).toContain("AS prod-deps");
    expect(dockerfile).toContain("AS runtime");
    expect(dockerfile).toContain("bun install --frozen-lockfile --production");
    expect(dockerfile).toContain("chromium");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kvitbit"]');
    expect(dockerfile).toContain("KVITBIT_CHROMIUM_PATH=/usr/bin/chromium");
    expect(dockerfile).toContain("KVITBIT_WEB_DIR=/app/public/web");
    expect(dockerfile).toContain("KVITBIT_PWA_DIR=/app/public/app");
    expect(dockerfile).toContain("KVITBIT_RUNNER_MODE=single");
  });

  test("docker-compose.yml separates migration owner credentials from DML-only app role, reconciles roles post-migration, and preserves DATABASE_URL_UNPOOLED (S5)", async () => {
    const compose = await Effect.runPromise(
      fs.readFileString(join(repoRoot, "docker-compose.yml")),
    );
    const initScriptPath = join(repoRoot, "docker/postgres-init/01-create-app-role.sh");
    const reconcileScriptPath = join(repoRoot, "docker/reconcile-app-role.sh");
    const targetScriptPath = join(repoRoot, "docker/database-target.sh");
    expect(await Effect.runPromise(fs.exists(initScriptPath))).toBe(true);
    expect(await Effect.runPromise(fs.exists(reconcileScriptPath))).toBe(true);

    await runSerial([initScriptPath, reconcileScriptPath, targetScriptPath])(async (scriptPath) => {
      const syntax = await runCommand({ command: ["sh", "-n", scriptPath] });
      expect(syntax.exitCode).toBe(0);
    });

    const parsed = decodeCompose(Bun.YAML.parse(compose)).pipe(Effect.runSync);
    expect(parsed.services.postgres.volumes).toContain(
      "./docker/postgres-init:/docker-entrypoint-initdb.d:ro",
    );
    expect(parsed.services.postgres.volumes).toContain(
      "./docker/reconcile-app-role.sh:/usr/local/bin/reconcile-app-role.sh:ro",
    );
    expect(parsed.services.migrate.environment["DATABASE_URL_UNPOOLED"]).toContain(
      "DATABASE_URL_UNPOOLED",
    );
    expect(parsed.services.migrate.environment["KVITBIT_BUNDLED_MIGRATION_URL"]).toContain(
      "POSTGRES_USER",
    );
    expect(parsed.services["reconcile-roles"].depends_on["migrate"]?.condition).toBe(
      "service_completed_successfully",
    );
    expect(parsed.services["reconcile-roles"].volumes).toContain(
      "./docker/reconcile-app-role.sh:/usr/local/bin/reconcile-app-role.sh:ro",
    );
    expect(parsed.services["reconcile-roles"].volumes).toContain(
      "./docker/database-target.sh:/usr/local/bin/database-target.sh:ro",
    );
    expect(parsed.services.kvitbit.depends_on["reconcile-roles"]?.condition).toBe(
      "service_completed_successfully",
    );
    expect(parsed.services.kvitbit.environment["DATABASE_URL"]).toContain("POSTGRES_APP_USER");
    expect(parsed.services.kvitbit.environment["DATABASE_URL_UNPOOLED"]).toBeUndefined();
    // Preserve production fail-fast behavior on upgrade (never silently downgrade to development/capture).
    expect(parsed.services.kvitbit.environment["NODE_ENV"]).toBe("production");
    expect(parsed.services.kvitbit.environment["KVITBIT_ENV"]).toBe(
      literalInterpolation("KVITBIT_ENV:-"),
    );
    expect(parsed.services.kvitbit.environment["KVITBIT_ENV"]).not.toContain("development");
    expect(parsed.services.kvitbit.environment["KVITBIT_BOT_PROTECTION_MODE"]).toBe(
      literalInterpolation("KVITBIT_BOT_PROTECTION_MODE:-"),
    );
    expect(parsed.services.kvitbit.environment["ALTCHA_HMAC_KEY"]).toBe(
      literalInterpolation("ALTCHA_HMAC_KEY:-"),
    );
    expect(compose).toContain("postgres:17-alpine");
    expect(compose).toContain('command: ["migrate"]');
    expect(compose).toContain("condition: service_completed_successfully");
    expect(compose).toContain("KVITBIT_RUNNER_MODE: single");
  });

  const makePostgresRoleSandbox = (container: string) => {
    const owner = "kvitbit";
    const ownerPassword = "synthetic-pg-owner";
    const passwordMarker = "synthetic-runtime-password-sentinel";
    const password = `${passwordMarker}-'quoted`;
    const fresh = "kvitbit_fresh";
    const existing = "kvitbit_existing";
    const migration = join(repoRoot, "packages/db/drizzle/20261123175822_init/migration.sql");
    const runDocker = (args: ReadonlyArray<string>) => runCommand({ command: ["docker", ...args] });
    const exec = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
      runDocker([
        "exec",
        ...Arr.flatMap(Record.toEntries(env), ([key, value]) => ["--env", `${key}=${value}`]),
        container,
        ...args,
      ]);
    const psql = (db: string, args: ReadonlyArray<string>, user = owner) =>
      exec(
        [
          "psql",
          "-XqAt",
          "-v",
          "ON_ERROR_STOP=1",
          "-h",
          "127.0.0.1",
          "-U",
          user,
          "-d",
          db,
          ...args,
        ],
        { PGPASSWORD: user === owner ? ownerPassword : password },
      );
    const sql = (db: string, statement: string, user?: string) => psql(db, ["-c", statement], user);
    const assertOk = (result: Awaited<ReturnType<typeof runDocker>>) => {
      if (result.exitCode !== 0)
        throw new Error(Str.replaceAll(password, "[redacted]")(result.stderr));
      return Str.trim(result.stdout);
    };
    const redactedOutput = (result: Awaited<ReturnType<typeof runDocker>>) =>
      !(Str.includes(passwordMarker)(result.stdout) || Str.includes(passwordMarker)(result.stderr));

    const start = async () => {
      assertOk(
        await runDocker([
          "run",
          "--detach",
          "--rm",
          "--name",
          container,
          "--env",
          `POSTGRES_USER=${owner}`,
          "--env",
          `POSTGRES_PASSWORD=${ownerPassword}`,
          "--env",
          `POSTGRES_DB=${fresh}`,
          "--env",
          `POSTGRES_APP_PASSWORD=${password}`,
          "--mount",
          `type=bind,src=${join(repoRoot, "docker/postgres-init")},dst=/docker-entrypoint-initdb.d,readonly`,
          "--mount",
          `type=bind,src=${join(repoRoot, "docker/reconcile-app-role.sh")},dst=/usr/local/bin/reconcile-app-role.sh,readonly`,
          "--mount",
          `type=bind,src=${join(repoRoot, "docker/database-target.sh")},dst=/usr/local/bin/database-target.sh,readonly`,
          "--mount",
          `type=bind,src=${migration},dst=/migration.sql,readonly`,
          "postgres:17-alpine",
        ]),
      );

      const probeVersion = async (attempts: number): Promise<string> => {
        const probe = await sql(fresh, "SHOW server_version_num");
        if (probe.exitCode === 0) return Str.trim(probe.stdout);
        if (attempts === 1) return "";
        await Bun.sleep(100);
        return probeVersion(attempts - 1);
      };
      const version = await probeVersion(50);
      if (version === "")
        throw new Error(
          Str.replaceAll(password, "[redacted]")((await runDocker(["logs", container])).stderr),
        );
      if (!postgres17Version.test(version))
        throw new Error(`Expected PostgreSQL 17, got ${version}`);
      const runtime = assertOk(await sql(fresh, "SELECT current_user", "kvitbit_app"));
      if (runtime !== "kvitbit_app") throw new Error(`Expected the runtime role, got ${runtime}`);
    };
    const init = "/docker-entrypoint-initdb.d/01-create-app-role.sh";
    const reconcile = "/usr/local/bin/reconcile-app-role.sh";
    const roleScript = (
      script: string,
      db: string,
      role: string,
      env: Record<string, string> = {},
    ) =>
      exec(["sh", script], {
        PGHOST: "127.0.0.1",
        PGPORT: "5432",
        PGPASSWORD: ownerPassword,
        POSTGRES_DB: db,
        POSTGRES_APP_USER: role,
        POSTGRES_APP_PASSWORD: password,
        ...env,
      });
    return {
      start,
      stop: () => runDocker(["rm", "--force", "--volumes", container]),
      logs: () => runDocker(["logs", container]),
      init,
      reconcile,
      roleScript,
      fresh,
      existing,
      owner,
      psql,
      sql,
      assertOk,
      redactedOutput,
    };
  };

  const withPostgresRoleSandbox = async (
    run: (fixture: ReturnType<typeof makePostgresRoleSandbox>) => Promise<void>,
  ) => {
    const fixture = makePostgresRoleSandbox(`kvitbit-pg-roles-${SecureRandom.uuidV4Unsafe()}`);
    try {
      await fixture.start();
      await run(fixture);
    } finally {
      await fixture.stop();
    }
  };

  test("PostgreSQL 17 init and reconcile keep runtime passwords out of stdout and stderr", async () => {
    await withPostgresRoleSandbox(
      async ({ init, reconcile, fresh, roleScript, logs, sql, assertOk, redactedOutput }) => {
        expect(redactedOutput(await logs())).toBe(true);
        assertOk(await sql(fresh, "CREATE ROLE elevated_privacy SUPERUSER"));
        await runSerial([init, reconcile])(async (script) => {
          const ok = await roleScript(script, fresh, "kvitbit_app");
          expect(redactedOutput(ok)).toBe(true);
          assertOk(ok);

          const rejected = await roleScript(script, fresh, "elevated_privacy");
          expect(redactedOutput(rejected)).toBe(true);
          expect(rejected.exitCode).not.toBe(0);
          expect(rejected.stderr).toContain("Refusing elevated runtime role");
        });
      },
    );
  }, 45_000);

  test("PostgreSQL 17 rejects runtime ownership of existing application tables", async () => {
    await withPostgresRoleSandbox(async ({ init, reconcile, fresh, roleScript, sql, assertOk }) => {
      assertOk(
        await sql(
          fresh,
          `
          CREATE ROLE legacy_app;
          CREATE ROLE legacy_member;
          CREATE ROLE legacy_inherit_member;
          CREATE ROLE legacy_set_inherit_bridge;
          CREATE ROLE legacy_set_inherit_member;
          CREATE ROLE legacy_admin_member;
          CREATE ROLE legacy_inherit_admin_bridge;
          CREATE ROLE legacy_inherit_admin_member;
          CREATE ROLE legacy_table_owner;
          CREATE TABLE public.legacy_table (id integer);
          ALTER TABLE public.legacy_table OWNER TO legacy_app;
          CREATE SCHEMA auth;
          CREATE TABLE auth.legacy_table (id integer);
          ALTER TABLE auth.legacy_table OWNER TO legacy_table_owner;
          GRANT legacy_table_owner TO legacy_member WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
          GRANT legacy_table_owner TO legacy_inherit_member WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
          GRANT legacy_table_owner TO legacy_set_inherit_bridge WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
          GRANT legacy_set_inherit_bridge TO legacy_set_inherit_member WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
          GRANT legacy_table_owner TO legacy_admin_member WITH INHERIT FALSE, SET FALSE, ADMIN TRUE;
          GRANT legacy_table_owner TO legacy_inherit_admin_bridge WITH INHERIT FALSE, SET FALSE, ADMIN TRUE;
          GRANT legacy_inherit_admin_bridge TO legacy_inherit_admin_member WITH INHERIT TRUE, SET FALSE, ADMIN FALSE;
        `,
        ),
      );

      await runSerial([
        "legacy_app",
        "legacy_member",
        "legacy_inherit_member",
        "legacy_set_inherit_member",
        "legacy_admin_member",
        "legacy_inherit_admin_member",
      ])(async (role) => {
        expect(
          assertOk(
            await sql(
              fresh,
              `
              SELECT has_database_privilege('${role}', current_database(), 'CREATE'),
                     has_schema_privilege('${role}', 'public', 'CREATE'),
                     has_schema_privilege('${role}', 'auth', 'CREATE')
            `,
            ),
          ),
        ).toBe("f|f|f");
        await runSerial([init, reconcile])(async (script) => {
          const result = await roleScript(script, fresh, role);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("owns database object");
        });
        expect(
          assertOk(await sql(fresh, `SELECT rolcanlogin FROM pg_roles WHERE rolname = '${role}'`)),
        ).toBe("f");
      });
    });
  }, 45_000);

  test("PostgreSQL 17 allows inactive table-owner membership while keeping runtime DDL blocked", async () => {
    await withPostgresRoleSandbox(async ({ init, reconcile, fresh, roleScript, sql, assertOk }) => {
      assertOk(
        await sql(
          fresh,
          `
          CREATE ROLE relation_owner;
          CREATE ROLE report_reader;
          CREATE TABLE public.owned_records (id integer);
          ALTER TABLE public.owned_records OWNER TO relation_owner;
          GRANT relation_owner TO report_reader WITH INHERIT FALSE, SET FALSE, ADMIN FALSE;
        `,
        ),
      );

      expect(
        assertOk(
          await sql(
            fresh,
            `
            SELECT pg_has_role('report_reader', 'relation_owner', 'MEMBER'),
                   pg_has_role('report_reader', 'relation_owner', 'USAGE'),
                   pg_has_role('report_reader', 'relation_owner', 'SET')
          `,
          ),
        ),
      ).toBe("t|f|f");

      await runSerial([init, reconcile])(async (script) => {
        assertOk(await roleScript(script, fresh, "report_reader"));
      });

      expect(
        assertOk(
          await sql(
            fresh,
            "INSERT INTO public.owned_records (id) VALUES (1); SELECT count(*) FROM public.owned_records;",
            "report_reader",
          ),
        ),
      ).toBe("1");

      await runSerial([
        "ALTER TABLE public.owned_records ADD COLUMN extra integer",
        "DROP TABLE public.owned_records",
        "SET ROLE relation_owner",
        "GRANT relation_owner TO report_reader WITH SET TRUE",
      ])(async (ddl) => {
        const denied = await sql(fresh, ddl, "report_reader");
        expect(denied.exitCode).not.toBe(0);
        expect(denied.stderr).toMatch(ownershipDenied);
      });
    });
  }, 45_000);

  test("PostgreSQL 17 revokes database CREATE and enforces DML-only runtime roles", async () => {
    await withPostgresRoleSandbox(
      async ({ init, reconcile, fresh, existing, owner, roleScript, psql, sql, assertOk }) => {
        const runtimeUrl = `postgres://kvitbit_app:synthetic@127.0.0.1/${fresh}`;
        assertOk(await psql(fresh, ["-f", "/migration.sql"]));
        assertOk(
          await roleScript(reconcile, fresh, "kvitbit_app", {
            KVITBIT_RUNTIME_DATABASE_URL: runtimeUrl,
          }),
        );
        expect(
          assertOk(
            await sql(
              fresh,
              `
        INSERT INTO auth."user" (id, name, email, email_verified, created_at, updated_at)
        VALUES ('u1', 'Ada', 'ada@example.com', true, now(), now());
        INSERT INTO auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
        VALUES ('a1', 'acc1', 'credential', 'u1', now(), now());
        SELECT count(*) FROM auth.account;
        SELECT count(*) FROM public.workspaces;
      `,
              "kvitbit_app",
            ),
          ),
        ).toBe("1\n0");
        await runSerial([
          "CREATE SCHEMA should_fail",
          "CREATE TABLE public.should_fail (id int)",
          "CREATE TABLE auth.should_fail (id int)",
          "DROP TABLE auth.account",
        ])(async (ddl) => {
          expect((await sql(fresh, ddl, "kvitbit_app")).stderr).toMatch(ownershipDenied);
        });

        assertOk(await sql(fresh, `CREATE DATABASE ${existing}`));
        assertOk(await psql(existing, ["-f", "/migration.sql"]));
        assertOk(await roleScript(reconcile, existing, "new_app"));
        expect(assertOk(await sql(existing, "SELECT count(*) FROM auth.account", "new_app"))).toBe(
          "0",
        );

        const wrongDbUrl = { KVITBIT_RUNTIME_DATABASE_URL: `${runtimeUrl}_other` };
        const wrongDb = await roleScript(reconcile, fresh, "unselected_app", wrongDbUrl);
        expect(wrongDb.exitCode).toBe(64);
        expect(wrongDb.stderr).toContain("different database");
        assertOk(
          await roleScript(reconcile, fresh, "unselected_app", {
            ...wrongDbUrl,
            DATABASE_URL_UNPOOLED: ownerDsn("127.0.0.1/kvitbit_fresh_other"),
          }),
        );
        assertOk(
          await roleScript(reconcile, fresh, "unselected_app", {
            KVITBIT_RUNTIME_DATABASE_URL: `${runtimeUrl}?port=5433`,
          }),
        );
        expect(assertOk(await sql(fresh, "SELECT to_regrole('unselected_app') IS NULL"))).toBe("t");

        assertOk(
          await sql(
            existing,
            `
        CREATE ROLE actual_db_owner;
        ALTER DATABASE ${existing} OWNER TO actual_db_owner;
        CREATE ROLE owner_member;
        GRANT actual_db_owner TO owner_member WITH INHERIT FALSE, SET TRUE;
        CREATE ROLE configured_owner_member;
        GRANT ${owner} TO configured_owner_member WITH INHERIT FALSE, SET TRUE;
        CREATE ROLE superuser_member;
        CREATE ROLE member_bridge;
        CREATE ROLE elevated_superuser SUPERUSER;
        GRANT elevated_superuser TO member_bridge WITH INHERIT FALSE, SET TRUE;
        GRANT member_bridge TO superuser_member WITH INHERIT FALSE, SET TRUE;
        CREATE ROLE set_role_app;
        CREATE ROLE inherit_role_app;
        CREATE ROLE schema_creator;
        GRANT CREATE ON SCHEMA auth TO schema_creator;
        GRANT schema_creator TO set_role_app WITH INHERIT FALSE, SET TRUE;
        GRANT schema_creator TO inherit_role_app WITH INHERIT TRUE, SET FALSE;
        CREATE ROLE elevated_createdb CREATEDB;
        CREATE ROLE elevated_createrole CREATEROLE;
        CREATE ROLE elevated_bypassrls BYPASSRLS;
        CREATE ROLE elevated_replication REPLICATION;
      `,
          ),
        );

        await runSerial([
          [init, "init_app"],
          [reconcile, "reconcile_app"],
        ] as const)(async ([script, role]) => {
          assertOk(
            await sql(
              existing,
              `
          CREATE ROLE ${role};
          GRANT CREATE ON DATABASE ${existing} TO ${role};
          GRANT CREATE ON SCHEMA public, auth TO ${role};
        `,
            ),
          );
          assertOk(await roleScript(script, existing, role));
          expect(
            assertOk(
              await sql(
                existing,
                `
          SELECT has_database_privilege(current_user, current_database(), 'CREATE'),
                 has_schema_privilege(current_user, 'public', 'CREATE'),
                 has_schema_privilege(current_user, 'auth', 'CREATE')
        `,
                role,
              ),
            ),
          ).toBe("f|f|f");
          expect(
            assertOk(await sql(existing, "SELECT count(*) FROM public.workspaces", role)),
          ).toBe("0");

          await runSerial([
            [owner, "must name different roles"],
            ["actual_db_owner", "owns the database or belongs"],
            ["owner_member", "owns the database or belongs"],
            ["configured_owner_member", "owns the database or belongs"],
            ["superuser_member", "owns the database or belongs"],
            ["set_role_app", "effective CREATE privileges"],
            ["inherit_role_app", "effective CREATE privileges"],
            ...Arr.map(
              ["superuser", "createdb", "createrole", "bypassrls", "replication"],
              (flag) => [`elevated_${flag}`, "Refusing elevated runtime role"] as const,
            ),
          ] as const)(async ([invalidRole, diagnostic]) => {
            const result = await roleScript(script, existing, invalidRole);
            expect(result.stderr).toContain(diagnostic);
            expect(result.exitCode).not.toBe(0);
          });

          await runSerial([`DATABASE ${existing}`, "SCHEMA public"])(async (target) => {
            assertOk(
              await sql(
                existing,
                `
            GRANT CREATE ON DATABASE ${existing} TO ${role};
            GRANT CREATE ON ${target} TO PUBLIC;
          `,
              ),
            );
            const result = await roleScript(script, existing, role);
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("effective CREATE privileges");
            assertOk(await sql(existing, `REVOKE CREATE ON ${target} FROM PUBLIC`));
            // A failed check rolls back the role script's direct grant changes.
            expect(
              assertOk(
                await sql(
                  existing,
                  `
            SELECT has_database_privilege('${role}', current_database(), 'CREATE')
          `,
                ),
              ),
            ).toBe("t");
            assertOk(await roleScript(script, existing, role));
          });
        });
      },
    );
  }, 45_000);

  test("flake.nix has valid bun.nix, writable OCI storage dirs for uid 10001, and separate NixOS migration credentials", async () => {
    const flake = await Effect.runPromise(fs.readFileString(join(repoRoot, "flake.nix")));
    const bunNixPath = join(repoRoot, "bun.nix");
    expect(await Effect.runPromise(fs.exists(bunNixPath))).toBe(true);
    const bunNix = await Effect.runPromise(fs.readFileString(bunNixPath));
    expect(bunNix).toContain("{ fetchurl }:");
    expect(bunNix).toContain("sha512-");

    expect(flake).toContain("bun2nix");
    expect(flake).toContain("nix2container");
    expect(flake).toContain("ociWritableDirs");
    expect(flake).toContain("/var/lib/kvitbit/blobs");
    expect(flake).toContain("/var/lib/kvitbit/mobile");
    expect(flake).toContain("uid = 10001;");
    expect(flake).toContain("gid = 10001;");
    expect(flake).toContain("migrationEnvironmentFile = lib.mkOption");
    expect(flake).toContain("cfg.migrationEnvironmentFile");
    expect(flake).toContain('KVITBIT_RUNNER_MODE = "single"');

    // Parse the exact option blocks so restoring `environment` or `blobDriver` defaults fails.
    const environmentOption = Option.getOrNull(Str.match(environmentLibMkoptionPattern)(flake));
    expect(environmentOption?.[0]).toBeDefined();
    expect(environmentOption?.[0]).toContain('default = "production";');

    const blobDriverOption = Option.getOrNull(Str.match(blobdriverLibMkoptionPattern)(flake));
    expect(blobDriverOption?.[0]).toBeDefined();
    expect(blobDriverOption?.[0]).toContain("lib.types.nullOr");
    expect(blobDriverOption?.[0]).toContain("default = null;");
    expect(blobDriverOption?.[0]).not.toContain('default = "local"');

    const botProtectionOption = Option.getOrNull(
      Str.match(botprotectionmodeLibMkoptionPattern)(flake),
    );
    expect(botProtectionOption?.[0]).toBeDefined();
    expect(botProtectionOption?.[0]).toContain("lib.types.nullOr");
    expect(botProtectionOption?.[0]).toContain("default = null;");
    expect(botProtectionOption?.[0]).not.toContain('default = "none"');

    // Verify the evaluated staging systemd service environment omits KVITBIT_BLOB_DRIVER when blobDriver is omitted.
    const kvitbitServiceBlock = Option.getOrNull(Str.match(systemdServicesKvitbitPattern)(flake));
    expect(kvitbitServiceBlock?.[0]).toBeDefined();
    const serviceText = kvitbitServiceBlock?.[0] ?? "";
    const unconditionalEnvMatch = Option.getOrNull(Str.match(environmentPattern)(serviceText));
    expect(unconditionalEnvMatch?.[1]).toBeDefined();
    expect(unconditionalEnvMatch?.[1]).not.toContain("KVITBIT_BLOB_DRIVER");
    expect(serviceText).toContain(
      "lib.optionalAttrs (cfg.blobDriver != null) { KVITBIT_BLOB_DRIVER = cfg.blobDriver; }",
    );
    const defaultBlobDriverMatch = defaultPattern.exec(blobDriverOption?.[0] ?? "");
    const stagingBlobDriverDefault = Str.trim(defaultBlobDriverMatch?.[1] ?? "");
    expect(stagingBlobDriverDefault).toBe("null");
    const KVITBITBLOBDRIVERFields =
      stagingBlobDriverDefault !== "null"
        ? { KVITBIT_BLOB_DRIVER: stagingBlobDriverDefault ?? "" }
        : {};
    const evaluatedStagingEnv = {
      NODE_ENV: "production",
      KVITBIT_ENV: "staging",
      ...KVITBITBLOBDRIVERFields,
    } satisfies Record<string, string>;
    expect(evaluatedStagingEnv["KVITBIT_BLOB_DRIVER"]).toBeUndefined();

    expect(flake).not.toContain('KVITBIT_BLOB_DRIVER = "local"');
    expect(flake).toContain("systemd.services.kvitbit-migrate");
    expect(flake).toContain("services.nginx = lib.mkIf cfg.nginx.enable");
  });

  test("deploy.yml validates GCP deployment variables after installing dependencies and before authenticating", async () => {
    const workflow = await Effect.runPromise(
      fs.readFileString(join(repoRoot, ".github/workflows/deploy.yml")),
    );
    const { steps } = parseDeployWorkflow(workflow).jobs.deploy;
    const stepIndex = (name: string) =>
      Option.getOrElse(
        Arr.findFirstIndex(steps, (step) => step.name === name),
        () => -1,
      );

    const install = stepIndex("Install dependencies");
    const preflight = stepIndex("Validate GCP deployment variables");
    const authenticate = stepIndex("Authenticate to Google Cloud (OIDC)");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeGreaterThan(install);
    expect(authenticate).toBeGreaterThan(preflight);
  });

  test(".github/workflows/deploy.yml enforces prod-only stage, bootstrap preflight, --yes deploy, optional secret flags, immutable attempt tags, runner digest check, and edge probing", async () => {
    const workflow = await Effect.runPromise(
      fs.readFileString(join(repoRoot, ".github/workflows/deploy.yml")),
    );
    const parsed = parseDeployWorkflow(workflow);
    expect(parsed).toBeDefined();

    // Production-only: no staging option pointing at prod secrets
    expect(parsed.on.workflow_dispatch.inputs["stage"]).toBeUndefined();
    expect(parsed.on.workflow_dispatch.inputs["bootstrap_foundation"]).toBeDefined();
    expect(workflow).toContain("KVITBIT_STAGE: prod");
    expect(workflow).not.toContain("- staging");

    for (const varName of [
      "GCP_PROJECT_ID",
      "GCP_PROJECT_NUMBER",
      "GCP_REGION",
      "GCP_ZONE",
      "GCP_WORKLOAD_IDENTITY_PROVIDER",
      "GCP_DEPLOYER_SERVICE_ACCOUNT",
      "ALCHEMY_STATE_BUCKET",
      "KVITBIT_ENABLE_RESEND_SECRET",
      "KVITBIT_ENABLE_SMTP_SECRET",
      "KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET",
      "KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET",
      "KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET",
      "KVITBIT_ENABLE_TURBO_CACHE",
      "KVITBIT_BOT_PROTECTION_MODE",
    ]) {
      expect(workflow).toContain(`vars.${varName}`);
    }

    expect(workflow).toContain("secrets.DATABASE_URL");
    expect(workflow).toContain("secrets.DATABASE_DIRECT_URL");
    expect(workflow).toContain("GOOGLE_ACCESS_TOKEN");
    expect(workflow).toContain("GOOGLE_PROJECT_ID");
    expect(workflow).toContain("gcloud artifacts repositories describe kvitbit");
    expect(workflow).toContain(
      `kvitbit-${shellReference("KVITBIT_STAGE")}-runner-database-url-unpooled`,
    );
    expect(workflow).toContain(
      `sha-${shellReference("GITHUB_SHA")}-run-${shellReference("GITHUB_RUN_ID")}-${shellReference("GITHUB_RUN_ATTEMPT")}`,
    );
    expect(workflow).toContain("bun apps/server/src/migrate.ts");
    expect(workflow).toContain("bunx alchemy deploy --yes");
    const alchemyStep = Option.getOrUndefined(
      Arr.findFirst(parsed.jobs.deploy.steps, (step) =>
        Str.includes("bunx alchemy deploy --yes")(step.run ?? ""),
      ),
    );
    expect(alchemyStep?.name).toStartWith("Run pure-Alchemy GCP stack");
    expect(alchemyStep?.env).toMatchObject({
      KVITBIT_DNS_ZONES: `${shellReference("{ vars.KVITBIT_DNS_ZONES ")}}`,
      KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: `${shellReference("{ env.KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET ")}}`,
      KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: literalInterpolation(
        "{ env.KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET }",
      ),
      KVITBIT_BOT_PROTECTION_MODE: literalInterpolation("{ env.KVITBIT_BOT_PROTECTION_MODE }"),
      KVITBIT_BOOTSTRAP_ALTCHA_SECRET: literalInterpolation("{ env.BOOTSTRAP_ALTCHA_SECRET }"),
      KVITBIT_FEEDBACK_GITHUB_REPO: `${shellReference("{ vars.KVITBIT_FEEDBACK_GITHUB_REPO ")}}`,
      KVITBIT_FEEDBACK_OWNER_EMAILS: `${shellReference("{ vars.KVITBIT_FEEDBACK_OWNER_EMAILS ")}}`,
    });
    expect(workflow).toContain("kvitbit/active-target");
    expect(workflow).toContain(cliValueFormat("value"));
    expect(workflow).not.toContain(cliValueFormat("queryValue"));
    expect(workflow).toContain(
      `KVITBIT_ENABLE_RESEND_SECRET: ${shellReference("{ env.KVITBIT_ENABLE_RESEND_SECRET ")}}`,
    );
    expect(workflow).toContain(
      `KVITBIT_ENABLE_SMTP_SECRET: ${shellReference("{ env.KVITBIT_ENABLE_SMTP_SECRET ")}}`,
    );
    expect(workflow).toContain(
      `KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: ${shellReference("{ env.KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET ")}}`,
    );
    expect(workflow).toContain(`kvitbit-${shellReference("KVITBIT_STAGE")}-feedback-github-token`);
    expect(workflow).toContain(`kvitbit-${literalInterpolation("KVITBIT_STAGE")}-altcha-hmac-key`);
    expect(workflow).toContain(`if [ -n "${shellReference("KVITBIT_EDGE_DOMAINS:-")}" ]; then`);

    const preflightPos = Option.getOrElse(
      Str.indexOf("gcloud artifacts repositories describe kvitbit")(workflow),
      () => -1,
    );
    const pushPos = Option.getOrElse(Str.indexOf("docker push")(workflow), () => -1);
    const migratePos = Option.getOrElse(
      Str.indexOf("bun apps/server/src/migrate.ts")(workflow),
      () => -1,
    );
    const deployPos = Option.getOrElse(
      Str.indexOf("bunx alchemy deploy --yes")(workflow),
      () => -1,
    );
    expect(preflightPos).toBeGreaterThan(-1);
    expect(pushPos).toBeGreaterThan(preflightPos);
    expect(migratePos).toBeGreaterThan(pushPos);
    expect(deployPos).toBeGreaterThan(migratePos);
  });

  test("feedback secret bootstrap can precede the first enabled token version", async () => {
    const workflow = parseDeployWorkflow(
      await Effect.runPromise(fs.readFileString(join(repoRoot, ".github/workflows/deploy.yml"))),
    );
    const steps = workflow.jobs.deploy.steps;
    const getStep = (name: string) =>
      Option.getOrUndefined(Arr.findFirst(steps, (step) => Str.startsWith(name)(step.name ?? "")));
    expect(workflow.on.workflow_dispatch.inputs["bootstrap_feedback_secret"]).toEqual({
      description: expect.any(String),
      type: "boolean",
      default: false,
    });
    expect(workflow.on.workflow_dispatch.inputs["bootstrap_altcha_secret"]).toEqual({
      description: expect.any(String),
      type: "boolean",
      default: false,
    });
    expect(workflow.on.workflow_dispatch.inputs["bootstrap_resend_secret"]).toEqual({
      description: expect.any(String),
      type: "boolean",
      default: false,
    });
    expect(workflow.on.workflow_dispatch.inputs["bootstrap_turbo_cache_secret"]).toEqual({
      description: expect.any(String),
      type: "boolean",
      default: false,
    });
    expect(getStep("Guard bootstrap against populated production workloads")?.if).toBe(
      "env.BOOTSTRAP_FOUNDATION == 'true'",
    );
    for (const name of [
      "Authenticate to Google Cloud",
      "Set up gcloud",
      "Preflight Artifact Registry and Secret Manager versions",
      "Configure Docker for Artifact Registry",
      "Build and push Kvitbit OCI image",
      "Run database and cluster schema migrations",
      "Verify runner pool reconciled target digest and config",
      "Verify database readiness and static mounts",
    ]) {
      expect(getStep(name)?.if).toContain("env.BOOTSTRAP_FEEDBACK_SECRET != 'true'");
      expect(getStep(name)?.if).toContain("env.BOOTSTRAP_ALTCHA_SECRET != 'true'");
      expect(getStep(name)?.if).toContain("env.BOOTSTRAP_RESEND_SECRET != 'true'");
      expect(getStep(name)?.if).toContain("env.BOOTSTRAP_TURBO_CACHE_SECRET != 'true'");
    }

    const sandbox = await Effect.runPromise(
      fs.makeTempDirectory({ prefix: "kvitbit-feedback-bootstrap-" }),
    );
    try {
      await Effect.runPromise(
        fs.writeFileString(
          join(sandbox, "gcloud"),
          `#!/bin/sh
set -eu
case "$1 $2 $3" in
  'artifacts repositories describe') exit 0 ;;
  'secrets versions describe')
    if [ "$8" = 'kvitbit-prod-feedback-github-token' ]; then
      [ -n "$FEEDBACK_VERSION_STATE" ] || exit 1
      printf '%s\\n' "$FEEDBACK_VERSION_STATE"
    elif [ "$8" = 'kvitbit-prod-altcha-hmac-key' ]; then
      [ -n "$ALTCHA_VERSION_STATE" ] || exit 1
      printf '%s\\n' "$ALTCHA_VERSION_STATE"
    else
      printf 'ENABLED\\n'
    fi ;;
  *) exit 1 ;;
esac
`,
          { mode: 0o755 },
        ),
      );
      await Effect.runPromise(
        fs.writeFileString(
          join(sandbox, "bunx"),
          `#!/bin/sh
set -eu
printf '%s\\n' "$KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET" "$KVITBIT_IMAGE_DIGEST" "$*"
`,
          { mode: 0o755 },
        ),
      );
      const run = (step: string, env: Record<string, string> = {}) => {
        const script = getStep(step)?.run;
        expect(script).toBeDefined();
        return runCommand({
          command: ["bash", "-c", script ?? ""],
          cwd: repoRoot,
          env: {
            PATH: `${sandbox}:${systemPath}`,
            GITHUB_SHA: "test-revision",
            GCP_PROJECT_ID: "kvitbit-prod",
            GCP_REGION: "europe-west3",
            KVITBIT_STAGE: "prod",
            KVITBIT_IMAGE_DIGEST: `sha256:${Str.repeat(64)("b")}`,
            KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: "false",
            KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: "false",
            BOOTSTRAP_FOUNDATION: "false",
            BOOTSTRAP_FEEDBACK_SECRET: "false",
            BOOTSTRAP_ALTCHA_SECRET: "false",
            DRY_RUN: "false",
            FEEDBACK_VERSION_STATE: "",
            ALTCHA_VERSION_STATE: "",
            ...env,
          },
        });
      };
      const deploy = "Run pure-Alchemy GCP stack";
      const preflight = "Preflight Artifact Registry and Secret Manager versions";
      const enabled = { KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: "true" };
      expect((await run(preflight)).exitCode).toBe(0);
      expect(Str.split("\n")(Str.trim((await run(deploy)).stdout.toString()))).toEqual([
        "false",
        `sha256:${Str.repeat(64)("b")}`,
        "alchemy deploy --yes --stage prod",
      ]);
      await runSerial(["", "DISABLED", "DESTROYED"])(async (state) => {
        const failed = await run(preflight, { ...enabled, FEEDBACK_VERSION_STATE: state });
        expect(failed.exitCode).toBe(1);
        expect(failed.stdout).toContain("bootstrap_feedback_secret=true");
      });

      const bootstrap = { BOOTSTRAP_FEEDBACK_SECRET: "true", KVITBIT_IMAGE_DIGEST: "" };
      const disabledBootstrap = await run(deploy, bootstrap);
      expect(disabledBootstrap.exitCode).toBe(1);
      expect(disabledBootstrap.stdout).toContain(
        "Set the KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET repository variable to true",
      );
      await runSerial([
        ["false", "deploy --yes"],
        ["true", "plan"],
      ] as const)(async ([dryRun, command]) => {
        const result = await run(deploy, { ...bootstrap, ...enabled, DRY_RUN: dryRun });
        expect(result.exitCode).toBe(0);
        const [flag, digest, args] = Str.split("\n")(Str.trim(result.stdout));
        expect(flag).toBe("true");
        expect(digest).toMatch(sha256Digest);
        expect(args).toBe(
          `alchemy ${command} --stage prod --include Secret-kvitbit-prod-feedback-github-token`,
        );
      });

      expect(
        (await run(preflight, { ...enabled, FEEDBACK_VERSION_STATE: "ENABLED" })).exitCode,
      ).toBe(0);

      // ALTCHA HMAC key secret bootstrap follows the same targeted single-secret path.
      const altchaEnabled = { KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: "true" };
      for (const state of ["", "DISABLED", "DESTROYED"]) {
        const failed = await run(preflight, { ...altchaEnabled, ALTCHA_VERSION_STATE: state });
        expect(failed.exitCode).toBe(1);
        expect(failed.stdout.toString()).toContain("bootstrap_altcha_secret=true");
      }
      const altchaBootstrap = { BOOTSTRAP_ALTCHA_SECRET: "true", KVITBIT_IMAGE_DIGEST: "" };
      const disabledAltchaBootstrap = await run(deploy, altchaBootstrap);
      expect(disabledAltchaBootstrap.exitCode).toBe(1);
      expect(disabledAltchaBootstrap.stdout.toString()).toContain(
        "Set the KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET repository variable to true",
      );
      for (const [dryRun, command] of [
        ["false", "deploy --yes"],
        ["true", "plan"],
      ] as const) {
        const result = await run(deploy, { ...altchaBootstrap, ...altchaEnabled, DRY_RUN: dryRun });
        expect(result.exitCode).toBe(0);
        const [, digest, args] = Str.split(Str.trim(result.stdout.toString()), "\n");
        expect(digest).toMatch(matchPattern);
        expect(args).toBe(
          `alchemy ${command} --stage prod --include Secret-kvitbit-prod-altcha-hmac-key`,
        );
      }
      expect(
        (await run(preflight, { ...altchaEnabled, ALTCHA_VERSION_STATE: "ENABLED" })).exitCode,
      ).toBe(0);

      const conflicting = await run("Validate GCP deployment variables", {
        ...bootstrap,
        BOOTSTRAP_FOUNDATION: "true",
      });
      expect(conflicting.exitCode).toBe(1);
      expect(conflicting.stdout).toContain("Select only one");

      const conflictingAltcha = await run("Validate GCP deployment variables", {
        ...altchaBootstrap,
        BOOTSTRAP_FEEDBACK_SECRET: "true",
      });
      expect(conflictingAltcha.exitCode).toBe(1);
      expect(conflictingAltcha.stdout.toString()).toContain("Select only one");
    } finally {
      await Effect.runPromise(fs.remove(sandbox, { recursive: true, force: true }));
    }
  });

  test("deploy.yml verifies readiness and both static mounts through the public Cloud Run URL", async () => {
    const workflow = await Effect.runPromise(
      fs.readFileString(join(repoRoot, ".github/workflows/deploy.yml")),
    );
    const parsed = parseDeployWorkflow(workflow);
    const script = Option.getOrUndefined(
      Arr.findFirst(
        parsed.jobs.deploy.steps,
        (step) => step.name === "Verify database readiness and static mounts",
      ),
    )?.run;
    if (script === undefined) throw new Error("Missing external deploy verification step");

    const paths: string[] = [];
    const webPage = () =>
      new Response("<html>Web app</html>", { headers: { "Content-Type": "text/html" } });
    const routes = new Map([
      ["/readyz", () => Response.json({ status: "ok" })],
      ["/", webPage],
      [
        "/app/manifest.webmanifest",
        () =>
          new Response('{"name":"Kvitbit"}', {
            headers: { "Content-Type": "application/manifest+json; charset=utf-8" },
          }),
      ],
    ]);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);
        // Cloud Run's frontend returns 404 for /healthz.
        return routes.get(path)?.() ?? new Response("Not found", { status: 404 });
      },
    });
    const runProbe = async () => {
      paths.length = 0;
      const child = Bun.spawn(
        ["bash", "-c", `gcloud() { printf '%s\\n' "$TEST_ORIGIN"; }\n${script}`],
        {
          env: {
            PATH: systemPath,
            TEST_ORIGIN: server.url.origin,
            KVITBIT_STAGE: "prod",
            GCP_PROJECT_ID: "test",
            GCP_REGION: "europe-west3",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, output: stdout + stderr };
    };
    try {
      expect((await runProbe()).exitCode).toBe(0);
      expect(paths).toEqual(["/readyz", "/", "/app/manifest.webmanifest"]);

      routes.set("/readyz", () => Response.json({ status: "down" }));
      const notReady = await runProbe();
      expect(notReady.exitCode).toBe(1);
      expect(notReady.output).toContain("/readyz did not report status ok");
      expect(paths).toEqual(["/readyz"]);

      routes.set("/readyz", () => Response.json({ status: "ok" }));
      routes.set(
        "/",
        () =>
          new Response(null, {
            status: 302,
            headers: { "Content-Type": "text/html", Location: "/login" },
          }),
      );
      const webRedirect = await runProbe();
      expect(webRedirect.exitCode).toBe(1);
      expect(webRedirect.output).toContain("/ returned '302 text/html'");
      expect(paths).toEqual(["/readyz", "/"]);

      routes.set("/", webPage);
      routes.set("/app/manifest.webmanifest", webPage);
      const manifestFallback = await runProbe();
      expect(manifestFallback.exitCode).toBe(1);
      expect(manifestFallback.output).toContain("expected HTTP 200 with application/manifest+json");
    } finally {
      server.stop();
    }
  });

  test("deploy.yml normalizes secret flags and resets legacy runners that cannot confirm a verified target", async () => {
    const workflow = await Effect.runPromise(
      fs.readFileString(join(repoRoot, ".github/workflows/deploy.yml")),
    );
    const parsed = parseDeployWorkflow(workflow);

    const validateStep = Option.getOrUndefined(
      Arr.findFirst(
        parsed.jobs.deploy.steps,
        (s) => s.name === "Validate GCP deployment variables",
      ),
    );
    const verifyStep = Option.getOrUndefined(
      Arr.findFirst(
        parsed.jobs.deploy.steps,
        (s) => s.name === "Verify runner pool reconciled target digest and config",
      ),
    );
    expect(validateStep?.run).toBeDefined();
    expect(validateStep?.env?.["KVITBIT_REPO_VARS_JSON"]).toBe(
      literalInterpolation("{ toJSON(vars) }"),
    );
    expect(verifyStep?.run).toBeDefined();

    const sandbox = await Effect.runPromise(
      fs.makeTempDirectory({ prefix: "kvitbit-deploy-yml-" }),
    );
    try {
      // 1. Test boolean normalization step with YES / 1 / OFF and invalid value
      const ghEnv = join(sandbox, "github_env");
      await Effect.runPromise(fs.writeFileString(ghEnv, ""));
      const baseVars = {
        KVITBIT_STAGE: "prod",
        BOOTSTRAP_FOUNDATION: "false",
        BOOTSTRAP_FEEDBACK_SECRET: "false",
        BOOTSTRAP_ALTCHA_SECRET: "false",
        GCP_PROJECT_ID: "kvitbit-prod",
        GCP_PROJECT_NUMBER: String(449_188_423_567),
        GCP_REGION: "europe-west3",
        GCP_ZONE: "europe-west3-a",
        GCP_WORKLOAD_IDENTITY_PROVIDER:
          "projects/1/locations/global/workloadIdentityPools/gh/providers/gh",
        GCP_DEPLOYER_SERVICE_ACCOUNT: "deployer@kvitbit-prod.iam.gserviceaccount.com",
        ALCHEMY_STATE_BUCKET: "alchemy-state-kvitbit-prod",
        APP_ORIGIN: "https://kvitbit.cz",
        EMAIL_FROM: "Kvitbit <no-reply@kvitbit.cz>",
        KVITBIT_EDGE_DOMAINS: "kvitbit.cz,kvitbit.app",
        KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: "true",
        GITHUB_ENV: ghEnv,
      };
      const normOk = await runCommand({
        command: ["bash", "-c", validateStep?.run ?? ""],
        cwd: repoRoot,
        env: {
          PATH: systemPath,
          ...baseVars,
          KVITBIT_ENABLE_RESEND_SECRET: "YES",
          KVITBIT_ENABLE_SMTP_SECRET: "1",
          KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET: "OFF",
          KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET: " On ",
          KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: "Yes",
        },
      });
      expect(normOk.exitCode).toBe(0);
      const exported = await Effect.runPromise(fs.readFileString(ghEnv));
      expect(exported).toContain("KVITBIT_ENABLE_RESEND_SECRET=true");
      expect(exported).toContain("KVITBIT_ENABLE_SMTP_SECRET=true");
      expect(exported).toContain("KVITBIT_ENABLE_MOBILE_SIGNING_KEY_SECRET=false");
      expect(exported).toContain("KVITBIT_ENABLE_FEEDBACK_GITHUB_TOKEN_SECRET=true");
      expect(exported).toContain("KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET=true");

      const normBad = await runCommand({
        command: ["bash", "-c", validateStep?.run ?? ""],
        cwd: repoRoot,
        env: {
          PATH: systemPath,
          ...baseVars,
          KVITBIT_ENABLE_RESEND_SECRET: "maybe",
        },
      });
      expect(normBad.exitCode).not.toBe(0);

      // Prod preflight fails fast when email secrets, APP_ORIGIN, EMAIL_FROM, or edge domains are missing or non-prod modes/opt-outs are set.
      for (const badOverride of [
        { KVITBIT_ENABLE_RESEND_SECRET: "false", KVITBIT_ENABLE_SMTP_SECRET: "false" },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", APP_ORIGIN: "http://localhost:8080" },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", APP_ORIGIN: "https://localhost." },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", APP_ORIGIN: "https://[::ffff:127.0.0.1]" },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", EMAIL_FROM: "" },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", EMAIL_FROM: "a..b@example.org" },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", EMAIL_FROM: `a@${Str.repeat(64)("b")}.org` },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", EMAIL_FROM: `a@example.${Str.repeat(64)("c")}` },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", KVITBIT_EDGE_DOMAINS: "" },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", KVITBIT_EMAIL_MODE: "capture" },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", KVITBIT_BLOB_DRIVER: "local" },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", KVITBIT_ENABLE_ALTCHA_HMAC_KEY_SECRET: "false" },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", KVITBIT_BOT_PROTECTION_MODE: "none" },
        { KVITBIT_ENABLE_RESEND_SECRET: "true", KVITBIT_BOT_PROTECTION_MODE: "disabled" },
        {
          KVITBIT_ENABLE_RESEND_SECRET: "true",
          KVITBIT_REPO_VARS_JSON: encodeJson({ KVITBIT_DISABLE_BOT_PROTECTION: "true" }),
        },
        {
          KVITBIT_ENABLE_RESEND_SECRET: "true",
          KVITBIT_REPO_VARS_JSON: encodeJson({ KVITBIT_PREVIEW_DISABLE_EMAIL: "true" }),
        },
        {
          KVITBIT_ENABLE_RESEND_SECRET: "true",
          KVITBIT_REPO_VARS_JSON: encodeJson({ KVITBIT_DISABLE_BLOB: "true" }),
        },
        {
          KVITBIT_ENABLE_RESEND_SECRET: "true",
          KVITBIT_REPO_VARS_JSON: encodeJson({ KVITBIT_DISABLE_HTTP_2: "true" }),
        },
      ]) {
        const rejected = await runCommand({
          command: ["bash", "-c", validateStep?.run ?? ""],
          cwd: repoRoot,
          env: {
            PATH: systemPath,
            ...baseVars,
            ...badOverride,
          },
        });
        expect(rejected.exitCode).not.toBe(0);
      }

      // 2. Verify the rollout step requires the combined acknowledgement from the current script.
      const binDir = join(sandbox, "bin");
      const stateDir = join(sandbox, "state");
      await Effect.runPromise(fs.makeDirectory(binDir, { recursive: true }));
      await Effect.runPromise(fs.makeDirectory(stateDir, { recursive: true }));

      const targetDigest = `sha256:${Str.repeat(64)("a")}`;
      const targetConfigSha = `sha256:${Str.repeat(64)("c")}`;

      await Effect.runPromise(fs.writeFileString(join(binDir, "sleep"), "#!/bin/sh\nexit 0\n"));
      await Effect.runPromise(fs.chmod(join(binDir, "sleep"), 0o755));

      await Effect.runPromise(
        fs.writeFileString(
          join(binDir, "gcloud"),
          `#!/bin/sh
set -eu
if [ "$1" = "compute" ] && [ "$2" = "instances" ] && [ "$3" = "list" ]; then
  printf 'kvitbit-prod-runner-0\\nkvitbit-prod-runner-1\\n'
  exit 0
fi
if [ "$1" = "compute" ] && [ "$2" = "instances" ] && [ "$3" = "describe" ]; then
  printf '{"metadata":{"items":[{"key":"kvitbit-worker-config-sha","value":"${targetConfigSha}"}]}}'
  exit 0
fi
if [ "$1" = "compute" ] && [ "$2" = "instances" ] && [ "$3" = "reset" ]; then
  echo "reset:$4" >> "${stateDir}/resets"
  touch "${stateDir}/reset-$4"
  exit 0
fi
if [ "$1" = "compute" ] && [ "$2" = "instances" ] && [ "$3" = "get-guest-attributes" ]; then
  RUNNER="$4"
  QUERY_PATH=""
  FORMAT=""
  for arg in "$@"; do
    case "$arg" in
      --query-path=*) QUERY_PATH="\${arg#--query-path=}" ;;
      --format=*) FORMAT="\${arg#--format=}" ;;
    esac
  done
  # Enforce exact gcloud value(value) projection
  if [ "$FORMAT" != "value(value)" ]; then
    exit 0
  fi
  case "$QUERY_PATH" in
    "kvitbit/active-digest") printf '%s\\n' "${targetDigest}" ;;
    "kvitbit/active-config-sha") printf '%s\\n' "${targetConfigSha}" ;;
    "kvitbit/active-target")
      # Legacy runner-1 advertises matching individual attributes. Only the updated script,
      # installed on reset, can attest to the combined target.
      if [ "$RUNNER" = "kvitbit-prod-runner-0" ] || [ -f "${stateDir}/reset-kvitbit-prod-runner-1" ]; then
        printf '%s\\n' "${targetDigest}|${targetConfigSha}"
      fi
      ;;
  esac
  exit 0
fi
exit 1
`,
        ),
      );
      await Effect.runPromise(fs.chmod(join(binDir, "gcloud"), 0o755));

      const verifyRes = await runCommand({
        command: ["bash", "-c", verifyStep?.run ?? ""],
        env: {
          PATH: `${binDir}:${systemPath}`,
          GCP_PROJECT_ID: "kvitbit-prod",
          GCP_ZONE: "europe-west3-a",
          KVITBIT_STAGE: "prod",
          TARGET_DIGEST: targetDigest,
        },
      });
      expect(verifyRes.exitCode).toBe(0);
      expect(verifyRes.stdout).toContain(
        `Verified runner kvitbit-prod-runner-0 is running digest=${targetDigest} config=${targetConfigSha}`,
      );
      expect(verifyRes.stdout).toContain(
        `Verified runner kvitbit-prod-runner-1 is running digest=${targetDigest} config=${targetConfigSha}`,
      );
      expect(Str.trim(await Effect.runPromise(fs.readFileString(join(stateDir, "resets"))))).toBe(
        "reset:kvitbit-prod-runner-1",
      );
    } finally {
      await Effect.runPromise(fs.remove(sandbox, { recursive: true, force: true }));
    }
  });
});
