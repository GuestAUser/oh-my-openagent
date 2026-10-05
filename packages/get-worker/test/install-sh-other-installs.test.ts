import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { spawnSync } from "node:child_process"

const installer = join(import.meta.dir, "..", "scripts", "install.sh")
const roots: string[] = []

type Fixture = { root: string; home: string; work: string; newOmo: string; oldOmo: string; packageDir: string; unrelated: string; env: Record<string, string> }

function file(path: string, content: string, executable = false): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  if (executable) chmodSync(path, 0o755)
}

function fixture(failingRemoval = false): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omo-installer-other-")))
  roots.push(root)
  const home = join(root, "home")
  const work = join(root, "work")
  const bunRoot = join(root, "bun")
  const bunBin = join(bunRoot, "bin")
  const packageDir = join(bunRoot, "install", "global", "node_modules", "omo-ai")
  const entry = join(packageDir, "bin", "omo")
  file(join(packageDir, "package.json"), JSON.stringify({ name: "omo-ai", version: "4.0.0", bin: { omo: "bin/omo" } }))
  file(entry, "#!/bin/sh\necho 'omo 4.0.0'\n", true)
  mkdirSync(bunBin, { recursive: true })
  symlinkSync(relative(bunBin, entry), join(bunBin, "omo"))
  const newOmo = join(root, "new-bin", "omo")
  file(newOmo, "#!/bin/sh\necho 'omo 5.0.0'\n", true)
  const tools = join(root, "tools")
  file(join(tools, "bun"), failingRemoval
    ? "#!/bin/sh\nexit 1\n"
    : "#!/bin/sh\nrm -rf \"$BUN_INSTALL/install/global/node_modules/omo-ai\"\nrm -f \"$BUN_INSTALL/bin/omo\"\n", true)
  const unrelated = join(packageDir, "..", "unrelated-package", "keep.txt")
  file(unrelated, "keep\n")
  mkdirSync(work)
  return {
    root, home, work, newOmo, oldOmo: join(bunBin, "omo"), packageDir, unrelated,
    env: { HOME: home, PATH: `${dirname(newOmo)}:${bunBin}:${tools}:/usr/bin:/bin`, OMO_INSTALL_SOURCE_ONLY: "1" },
  }
}

function report(f: Fixture, body: string, input?: string) {
  return spawnSync("/bin/bash", ["-c", `source ${JSON.stringify(installer)}\n${body}`], {
    input, encoding: "utf8", env: f.env,
  })
}

const goodCandidate = "#!/bin/sh\necho 'omo 5.0.0'\n"

function installMain(f: Fixture, env: Record<string, string>, candidate = goodCandidate, checksummed = candidate) {
  const downloads = join(f.root, "downloads")
  file(join(downloads, "omo-linux-x64"), candidate)
  const checksum = createHash("sha256").update(checksummed).digest("hex")
  file(join(downloads, "SHA256SUMS"), `${checksum}  omo-linux-x64\n`)

  return spawnSync("/bin/bash", ["-c", [
    `source ${JSON.stringify(installer)}`,
    "detect_asset() { printf '%s\\n' omo-linux-x64; }",
    'download() { cp "$FIXTURE_DOWNLOADS/$2" "$3"; }',
    "main 5.0.0",
  ].join("\n")], {
    encoding: "utf8",
    timeout: 10_000,
    cwd: f.root,
    env: {
      HOME: f.home,
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/sh",
      TMPDIR: f.work,
      OMO_INSTALL_ALLOW_SUDO: "1",
      OMO_NO_MODIFY_PATH: "1",
      FIXTURE_DOWNLOADS: downloads,
      ...env,
    },
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("install.sh candidate validation", () => {
  for (const exitCode of [23, 0]) {
    test(`a checksum-valid candidate exiting ${exitCode} preserves or replaces the installation safely`, () => {
      const f = fixture()
      const installDir = join(f.root, "install bin")
      const launcher = join(installDir, "omo")
      const receipt = join(f.home, ".omo", "install.json")
      const downloads = join(f.root, "downloads")
      const probe = join(f.root, "candidate-probe")
      const oldLauncher = "#!/bin/sh\necho 'omo 4.0.0'\n"
      const oldReceipt = JSON.stringify({
        method: "standalone",
        version: "4.0.0",
        binPath: launcher,
      }) + "\n"
      const candidate = [
        "#!/bin/sh",
        '[ "$1" = --version ] || exit 99',
        'printf "%s\\n" "$0" >>"$FIXTURE_PROBE"',
        "echo 'omo 5.0.0'",
        `exit ${exitCode}`,
        "",
      ].join("\n")

      file(launcher, oldLauncher, true)
      chmodSync(launcher, 0o751)
      file(receipt, oldReceipt)
      chmodSync(receipt, 0o640)
      file(join(downloads, "omo-linux-x64"), candidate)
      const checksum = createHash("sha256").update(candidate).digest("hex")
      file(join(downloads, "SHA256SUMS"), `${checksum}  omo-linux-x64\n`)

      const result = spawnSync("/bin/bash", ["-c", [
        `source ${JSON.stringify(installer)}`,
        "detect_asset() { printf '%s\\n' omo-linux-x64; }",
        'download() { cp "$FIXTURE_DOWNLOADS/$2" "$3"; }',
        "main 5.0.0",
      ].join("\n")], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          HOME: f.home,
          PATH: "/usr/bin:/bin",
          TMPDIR: f.work,
          OMO_INSTALL_DIR: installDir,
          OMO_INSTALL_ALLOW_SUDO: "1",
          OMO_NO_MODIFY_PATH: "1",
          FIXTURE_DOWNLOADS: downloads,
          FIXTURE_PROBE: probe,
        },
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(exitCode === 0 ? 0 : 1)
      expect(readFileSync(probe, "utf8").split("\n")[0]).toStartWith(`${launcher}.new.`)
      expect(readdirSync(installDir)).toEqual(["omo"])

      if (exitCode !== 0) {
        expect(readFileSync(launcher, "utf8")).toBe(oldLauncher)
        expect(statSync(launcher).mode & 0o777).toBe(0o751)
        expect(readFileSync(receipt, "utf8")).toBe(oldReceipt)
        expect(statSync(receipt).mode & 0o777).toBe(0o640)
      } else {
        expect(readFileSync(launcher, "utf8")).toBe(candidate)
        expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({
          method: "standalone",
          channel: "pinned",
          version: "5.0.0",
          asset: "omo-linux-x64",
          binPath: launcher,
          profileEdits: [],
        })
      }

      const version = spawnSync(launcher, ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: "/usr/bin:/bin", FIXTURE_PROBE: probe },
      })

      expect(version.error).toBeUndefined()
      expect(version.status).toBe(0)
      expect(version.stdout.trim()).toBe(exitCode === 0 ? "omo 5.0.0" : "omo 4.0.0")
    })
  }
})

describe("install.sh other-install handling", () => {
  test("a launcher reached through a symlinked install directory is never removed as another install", () => {
    const f = fixture()
    const realDir = join(f.root, "real bin")
    const aliasDir = join(f.root, "alias bin")
    file(join(realDir, "omo"), goodCandidate, true)
    symlinkSync(realDir, aliasDir)
    file(join(f.home, ".omo", "install.json"), JSON.stringify({ method: "standalone", binPath: join(realDir, "omo") }))
    f.env.PATH = `${realDir}:${join(f.root, "tools")}:/usr/bin:/bin`

    const result = report(f, `report_other_installs ${JSON.stringify(join(aliasDir, "omo"))} 1 ${JSON.stringify(f.work)}`)
    const version = spawnSync(join(aliasDir, "omo"), ["--version"], { encoding: "utf8", timeout: 10_000 })

    expect(result.status).toBe(0)
    expect(existsSync(join(realDir, "omo"))).toBe(true)
    expect(version.status).toBe(0)
    expect(version.stdout.trim()).toBe("omo 5.0.0")
  })

  test("a real terminal prompts before removing another installation", async () => {
    const f = fixture()
    let output = ""
    let answered = false
    const child = Bun.spawn(["/bin/bash", "-c",
      `source ${JSON.stringify(installer)}\nreport_other_installs ${JSON.stringify(f.newOmo)} 0 ${JSON.stringify(f.work)}`,
    ], {
      env: f.env,
      terminal: {
        cols: 100, rows: 24,
        data(terminal, bytes) {
          output += Buffer.from(bytes).toString()
          if (!answered && output.includes("[y/N] ")) {
            answered = true
            terminal.write("yes\n")
          }
        },
      },
    })
    const deadline = setTimeout(() => child.kill(), 5000)
    try {
      expect(await child.exited).toBe(0)
      expect(answered).toBe(true)
      expect(existsSync(f.packageDir)).toBe(false)
      expect(readFileSync(f.unrelated, "utf8")).toBe("keep\n")
    } finally {
      clearTimeout(deadline)
      child.terminal?.close()
    }
  })

  test("receipt paths round-trip JSON special and control characters", () => {
    const f = fixture()
    const launcher = join(f.root, 'quoted "bin"\\line\n\t\u0001', "omo")
    const profile = join(f.home, 'profile "quoted"\\name')
    f.env.FIXTURE_LAUNCHER = launcher
    f.env.FIXTURE_PROFILE = profile
    const result = report(f, 'write_receipt latest 5.0.0 omo-linux-x64 "$FIXTURE_LAUNCHER" "$FIXTURE_PROFILE"')
    expect(result.status).toBe(0)
    const receipt = JSON.parse(readFileSync(join(f.home, ".omo/install.json"), "utf8"))
    expect(receipt.binPath).toBe(launcher)
    expect(receipt.profileEdits).toEqual([profile])
  })

  test("accepting the interactive prompt removes the bun-global install and leaves one omo on PATH", () => {
    const f = fixture()
    const result = report(f, `is_interactive() { return 0; }\nreport_other_installs ${JSON.stringify(f.newOmo)} 0 ${JSON.stringify(f.work)}\ntype -ap omo`, "yes\n")

    expect(result.status).toBe(0)
    expect(result.stderr).toContain(`Remove the other omo install at ${f.oldOmo}? [y/N]`)
    expect(result.stderr).toContain(`Removed the other omo install at ${f.oldOmo}.`)
    expect(result.stdout.trim().split("\n")).toEqual([f.newOmo])
    expect(existsSync(f.packageDir)).toBe(false)
    expect(readFileSync(f.unrelated, "utf8")).toBe("keep\n")
  })

  test("a non-interactive run never deletes without the explicit flag", () => {
    const f = fixture()
    const result = report(f, `is_interactive() { return 1; }\nreport_other_installs ${JSON.stringify(f.newOmo)} 0 ${JSON.stringify(f.work)}`)

    expect(result.status).toBe(0)
    expect(result.stderr).toContain("Nothing was removed in this non-interactive run. Re-run with --remove-other-installs")
    expect(readFileSync(join(f.packageDir, "package.json"), "utf8")).toContain('"name":"omo-ai"')
    expect(readFileSync(f.unrelated, "utf8")).toBe("keep\n")
  })

  test("the explicit flag removes only the verified omo package and shim", () => {
    const f = fixture()
    const lookalike = join(dirname(f.oldOmo), "omo-helper")
    file(lookalike, "unrelated\n")
    const result = report(f, `report_other_installs ${JSON.stringify(f.newOmo)} 1 ${JSON.stringify(f.work)}`)

    expect(result.status).toBe(0)
    expect(existsSync(f.oldOmo)).toBe(false)
    expect(existsSync(join(f.packageDir, "package.json"))).toBe(false)
    expect(readFileSync(lookalike, "utf8")).toBe("unrelated\n")
    expect(readFileSync(f.unrelated, "utf8")).toBe("keep\n")
  })

  test("declining the prompt changes nothing on disk", () => {
    const f = fixture()
    const before = readFileSync(join(f.packageDir, "package.json"), "utf8")
    const result = report(f, `is_interactive() { return 0; }\nreport_other_installs ${JSON.stringify(f.newOmo)} 0 ${JSON.stringify(f.work)}`, "no\n")

    expect(result.status).toBe(0)
    expect(result.stderr).toContain("Kept it. Remove it later with:")
    expect(readFileSync(join(f.packageDir, "package.json"), "utf8")).toBe(before)
    expect(readFileSync(f.unrelated, "utf8")).toBe("keep\n")
  })

  test("a failed removal leaves the new install working and prints the exact command", () => {
    const f = fixture(true)
    const result = report(f, `report_other_installs ${JSON.stringify(f.newOmo)} 1 ${JSON.stringify(f.work)}\n${JSON.stringify(f.newOmo)} --version`)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("omo 5.0.0")
    expect(result.stderr).toContain("the new install still works")
    expect(result.stderr).toContain(`BUN_INSTALL=${f.root}/bun bun remove -g omo-ai`)
    expect(readFileSync(join(f.packageDir, "package.json"), "utf8")).toContain('"name":"omo-ai"')
  })

  test("an unverified look-alike omo is never removed", () => {
    const f = fixture()
    rmSync(f.oldOmo)
    const foreign = join(dirname(f.oldOmo), "omo")
    file(foreign, "#!/bin/sh\necho look-alike\n", true)
    const result = report(f, `report_other_installs ${JSON.stringify(f.newOmo)} 1 ${JSON.stringify(f.work)}`)

    expect(result.status).toBe(0)
    expect(result.stderr).toContain("could not be verified, so nothing was removed")
    expect(readFileSync(foreign, "utf8")).toContain("look-alike")
    expect(readFileSync(f.unrelated, "utf8")).toBe("keep\n")
  })

  test("a prior standalone receipt permits removing only that old launcher", () => {
    const f = fixture()
    rmSync(f.oldOmo)
    const oldStandalone = join(dirname(f.oldOmo), "omo")
    file(oldStandalone, "#!/bin/sh\necho 'omo 3.0.0'\n", true)
    file(join(f.home, ".omo", "install.json"), JSON.stringify({ method: "standalone", binPath: oldStandalone }))
    const neighbor = join(dirname(oldStandalone), "keep")
    file(neighbor, "keep\n")
    const result = report(f, `report_other_installs ${JSON.stringify(f.newOmo)} 1 ${JSON.stringify(f.work)}`)

    expect(result.status).toBe(0)
    expect(existsSync(oldStandalone)).toBe(false)
    expect(readFileSync(neighbor, "utf8")).toBe("keep\n")
  })
})

describe("install.sh main robustness", () => {
  test("shell syntax in the install path stays data in the profile line and the printed PATH command", () => {
    const f = fixture()
    const home = join(f.root, 'home "quoted" $(touch injected) `touch ticked` back\\slash')
    const installDir = join(home, ".local", "bin")
    mkdirSync(home)

    const result = installMain(f, { HOME: home, OMO_NO_MODIFY_PATH: "" })
    expect(result.status).toBe(0)

    const sourced = spawnSync("/bin/sh", ["-c", '. "$HOME/.profile"; printf "%s\\n" "$PATH"'], {
      encoding: "utf8", timeout: 10_000, cwd: f.root, env: { HOME: home, PATH: "/usr/bin:/bin" },
    })
    const hint = result.stderr.slice(result.stderr.indexOf("run: export PATH=") + "run: ".length, result.stderr.lastIndexOf(") and run: omo"))
    const pasted = spawnSync("/bin/sh", ["-c", `${hint}\nprintf "%s\\n" "$PATH"`], {
      encoding: "utf8", timeout: 10_000, cwd: f.root, env: { PATH: "/usr/bin:/bin" },
    })

    expect(sourced.status).toBe(0)
    expect(sourced.stdout.split(":")[0]).toBe(installDir)
    expect(pasted.status).toBe(0)
    expect(pasted.stdout.split(":")[0]).toBe(installDir)
    expect(existsSync(join(f.root, "injected"))).toBe(false)
    expect(existsSync(join(f.root, "ticked"))).toBe(false)
  })

  test.skipIf(process.getuid?.() === 0)("a profile that cannot be written fails the install without a receipt or temp file", () => {
    const f = fixture()
    const profile = join(f.home, ".profile")
    const original = "# existing user profile\n"
    file(profile, original)
    chmodSync(profile, 0o444)

    const result = installMain(f, { OMO_NO_MODIFY_PATH: "" })

    expect(result.status).toBe(1)
    expect(readFileSync(profile, "utf8")).toBe(original)
    expect(existsSync(join(f.home, ".omo", "install.json"))).toBe(false)
    expect(readdirSync(f.home).filter((name) => name.startsWith(".profile.omo."))).toEqual([])
  })

  test("a backslash in TMPDIR neither corrupts the checksum nor relaxes it", () => {
    const f = fixture()
    const tmp = join(f.work, "tmp\\backslash")
    const launcher = join(f.home, ".local", "bin", "omo")
    mkdirSync(tmp)

    const accepted = installMain(f, { TMPDIR: tmp })
    expect(accepted.status).toBe(0)
    expect(readFileSync(launcher, "utf8")).toBe(goodCandidate)

    const rejected = installMain(f, { TMPDIR: tmp }, "#!/bin/sh\necho 'omo 6.0.0'\n", "something else\n")
    expect(rejected.status).toBe(1)
    expect(readFileSync(launcher, "utf8")).toBe(goodCandidate)
    expect(readdirSync(tmp)).toEqual([])
  })

  test("an apostrophe in TMPDIR still cleans the work directory on success and failure", () => {
    const f = fixture()
    const tmp = join(f.work, "tmp's")
    mkdirSync(tmp)

    const succeeded = installMain(f, { TMPDIR: tmp })
    expect(succeeded.status).toBe(0)
    expect(readdirSync(tmp)).toEqual([])

    const failed = installMain(f, { TMPDIR: tmp }, "#!/bin/sh\nexit 23\n")
    expect(failed.status).toBe(1)
    expect(readdirSync(tmp)).toEqual([])
  })

  test("SIGTERM during candidate validation keeps the old launcher and removes the staged one", () => {
    const f = fixture()
    const installDir = join(f.home, ".local", "bin")
    const launcher = join(installDir, "omo")
    const oldLauncher = "#!/bin/sh\necho 'omo 4.0.0'\n"
    file(launcher, oldLauncher, true)

    // The candidate's --version run signals the installer itself, so the interruption lands at an exact point.
    const result = installMain(f, {}, '#!/bin/sh\nkill -TERM "$PPID"\nexit 0\n')

    expect(result.signal).toBe("SIGTERM")
    expect(readFileSync(launcher, "utf8")).toBe(oldLauncher)
    expect(readdirSync(installDir)).toEqual(["omo"])
    expect(readdirSync(f.work)).toEqual([])
  })
})
