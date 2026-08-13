import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE_NAME = "@jack-in-the-box/babel-plugin-styled-components-css-namespace";
const GITLAB_NAME = "@xait-france/babel-plugin-styled-components-css-namespace";
const GITHUB_REGISTRY = "https://npm.pkg.github.com/";
const GITLAB_REGISTRY =
  "https://gitlab.xait.no/api/v4/projects/xait-france%2Fbabel-plugin-styled-components-css-namespace/packages/npm/";

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
  return value;
};

const assertRepository = () => {
  const local = JSON.parse(readFileSync("package.json", "utf8")).name;
  if (local !== SOURCE_NAME) {
    throw new Error(
      `Ce script cible ${SOURCE_NAME} mais le depot courant est ${local} : les constantes n'ont pas ete adaptees.`,
    );
  }
};

const npmrcContents = () =>
  [
    `${SOURCE_NAME.split("/")[0]}:registry=${GITHUB_REGISTRY}`,
    `//npm.pkg.github.com/:_authToken=${requireEnv("GITHUB_NPM_AUTH_TOKEN")}`,
    `//gitlab.xait.no/api/v4/projects/xait-france%2Fbabel-plugin-styled-components-css-namespace/packages/npm/:_authToken=${requireEnv("GITLAB_NPM_AUTH_TOKEN")}`,
  ].join("\n");

const npm = (args, options = {}) =>
  execFileSync("npm", [...args, "--userconfig", options.npmrc], {
    cwd: options.cwd,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });

const parseSemver = (version) => {
  const [core, pre = ""] = version.split("-");
  const [major, minor, patch] = core.split(".").map(Number);
  return { major, minor, patch, pre };
};

const compareSemver = (a, b) => {
  const left = parseSemver(a);
  const right = parseSemver(b);
  const core =
    left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (core !== 0) return core;
  if (left.pre === right.pre) return 0;
  if (left.pre === "") return 1;
  if (right.pre === "") return -1;
  return left.pre < right.pre ? -1 : 1;
};

const isPrerelease = (version) => version.includes("-");

const listSourceVersions = (npmrc) => {
  const raw = npm(["view", SOURCE_NAME, "versions", "--json"], { npmrc, capture: true });
  const parsed = JSON.parse(raw);
  return [].concat(parsed).sort(compareSemver);
};

const packFromGithub = (version, workDir, npmrc) => {
  const output = npm(
    ["pack", `${SOURCE_NAME}@${version}`, "--pack-destination", workDir],
    { npmrc, capture: true },
  );
  const tarball = output.trim().split("\n").pop();
  return join(workDir, tarball);
};

const extractPackage = (tarball, workDir) => {
  const destination = join(workDir, `extract-${tarball.length}`);
  execFileSync("mkdir", ["-p", destination]);
  execFileSync("tar", ["-xzf", tarball, "-C", destination]);
  return join(destination, "package");
};

const rewriteManifest = (packageDir) => {
  const manifestPath = join(packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rescoped = {
    ...manifest,
    name: GITLAB_NAME,
    publishConfig: { ...manifest.publishConfig, registry: GITLAB_REGISTRY },
  };
  writeFileSync(manifestPath, `${JSON.stringify(rescoped, null, 2)}\n`);
};

const publishToGitlab = (packageDir, version, npmrc) => {
  const tagArgs = isPrerelease(version) ? ["--tag", "rc"] : [];
  try {
    npm(["publish", "--ignore-scripts", ...tagArgs], { cwd: packageDir, npmrc, capture: true });
    return "published";
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (/already exists|E409|E403|cannot publish over/i.test(detail)) return "skipped";
    throw new Error(`Echec publication ${version} :\n${detail}`);
  }
};

const backfillVersion = (version, workDir, npmrc) => {
  const tarball = packFromGithub(version, workDir, npmrc);
  const packageDir = extractPackage(tarball, workDir);
  rewriteManifest(packageDir);
  return publishToGitlab(packageDir, version, npmrc);
};

const run = () => {
  assertRepository();
  const workDir = mkdtempSync(join(tmpdir(), "babel-plugin-backfill-"));
  const npmrc = join(workDir, ".npmrc");
  writeFileSync(npmrc, npmrcContents());
  try {
    const versions = listSourceVersions(npmrc);
    console.log(`${versions.length} version(s) trouvee(s) sur GitHub : ${versions.join(", ")}`);
    for (const version of versions) {
      const status = backfillVersion(version, workDir, npmrc);
      console.log(`  ${status === "skipped" ? "= deja present" : "+ publie"} : ${version}`);
    }
    console.log("Backfill termine.");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
};

run();
