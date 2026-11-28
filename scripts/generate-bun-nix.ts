// This generator runs before dependency installation.

import { isLockObject, isLockString } from "./bun-lock-boundary";

// Build the fetchBunDeps expression from a Bun v2 lockfile. Bun installs the
// workspace links from source, so only external packages belong in the cache.
const lock = Bun.JSONC.parse(await Bun.file("bun.lock").text());
if (!isLockObject(lock)) {
  throw new Error("Expected an object in bun.lock.");
}
if (lock["lockfileVersion"] !== 2) {
  throw new Error(`Unsupported Bun lockfile version: ${String(lock["lockfileVersion"])}`);
}
if (!isLockObject(lock["packages"])) {
  throw new Error("Expected a packages object in bun.lock.");
}

const nixString = (value: string) => JSON.stringify(value).replaceAll("${", "\\${");
const entries = new Map<string, string>();
for (const [name, entry] of Object.entries(lock["packages"])) {
  if (!Array.isArray(entry)) {
    throw new Error(`Expected a lockfile entry array for ${name}`);
  }
  const parts: readonly unknown[] = entry;
  const [specifier, second, third] = parts;
  if (!isLockString(specifier)) throw new Error(`Missing specifier for ${name}`);

  const separator = specifier.indexOf("@", 1);
  const packageName = specifier.slice(0, separator);
  const source = specifier.slice(separator + 1);
  if (entry.length === 1 && source.startsWith("workspace:")) continue;

  const hash = parts.at(-1);
  if (separator < 1 || !isLockString(hash) || !hash.startsWith("sha512-")) {
    throw new Error(`Unsupported lockfile entry for ${name}: ${specifier}`);
  }

  const basename = packageName.slice(packageName.lastIndexOf("/") + 1);
  const tarball = /^https?:\/\//u.test(source);
  const githubMatch = /^github:([^/#]+)\/([^/#]+)#([^/#]+)$/u.exec(source);
  const hasRegistryUrl =
    !tarball && githubMatch === null && isLockString(second) && second.length > 0;
  let key: string;
  let url: string;
  if (tarball) {
    if (entry.length !== 3) {
      throw new Error(`Unsupported lockfile entry for ${name}: ${specifier}`);
    }
    key = `tarball:${source}`;
    url = source;
  } else if (githubMatch !== null) {
    if (entry.length !== 4 || !isLockString(third) || third.length === 0) {
      throw new Error(`Unsupported lockfile entry for ${name}: ${specifier}`);
    }
    const [, owner, repo, rev] = githubMatch;
    key = `github:${third}`;
    url = `https://github.com/${owner}/${repo}/tarball/${rev}`;
  } else {
    if (entry.length !== 4) {
      throw new Error(`Unsupported lockfile entry for ${name}: ${specifier}`);
    }
    key = specifier;
    url = hasRegistryUrl
      ? second
      : `https://registry.npmjs.org/${packageName}/-/${basename}-${source}.tgz`;
  }

  // A URL without a .tgz suffix still needs that extension for bun2nix extraction.
  const expression = [
    `  ${nixString(key)} = fetchurl {`,
    ...(tarball || githubMatch !== null || hasRegistryUrl
      ? [`    name = ${nixString(`${basename}.tgz`)};`]
      : []),
    `    url = ${nixString(url)};`,
    `    hash = ${nixString(hash)};`,
    "  };",
  ].join("\n");
  const previous = entries.get(key);
  if (previous !== undefined && previous !== expression) {
    throw new Error(`Conflicting tarballs in bun.lock for ${key}`);
  }
  entries.set(key, expression);
}

const generated = [
  "# Generated from bun.lock by bun run generate:bun-nix",
  "{ fetchurl }:",
  "",
  "{",
  ...[...entries.values()].sort((left, right) => {
    if (left < right) return -1;
    return left > right ? 1 : 0;
  }),
  "}",
  "",
].join("\n");

if (Bun.argv.includes("--check")) {
  if ((await Bun.file("bun.nix").text()) !== generated) {
    throw new Error("bun.nix is stale. Run bun run generate:bun-nix.");
  }
} else {
  await Bun.write("bun.nix", generated);
}
