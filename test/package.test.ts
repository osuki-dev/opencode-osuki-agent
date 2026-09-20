import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("package exports the built plugin and retains its workflow assets", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const build = Bun.spawn([process.execPath, "run", "build"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [code, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text()
  ])
  if (code !== 0) throw new Error(`Package build failed: ${stdout}\n${stderr}`)

  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
  expect(manifest.exports["."]).toBe("./dist/index.js")
  expect(manifest.main).toBe(manifest.exports["."])
  expect(manifest.author).toBe("osuki-dev")
  expect(manifest.homepage).toBe("https://github.com/osuki-dev/opencode-osuki-agent#readme")
  expect(manifest.bugs.url).toBe("https://github.com/osuki-dev/opencode-osuki-agent/issues")
  expect(manifest.files).toEqual(["dist", "agents", "skills", "README.md", "CHANGELOG.md", "LICENSE"])
  expect(manifest.license).toBe("MIT")
  expect(await Bun.file(new URL("../LICENSE", import.meta.url)).text()).toContain("MIT License")
  expect(manifest.scripts.prepack).toBe("bun run build")

  const entry = new URL(manifest.exports["."], new URL("../", import.meta.url))
  const { default: plugin } = await import(entry.href)
  expect(plugin.id).toBe("osuki")
  expect(typeof plugin.effect).toBe("function")

  const workflow = new URL("../skills/osuki-workflow/SKILL.md", entry)
  expect(await Bun.file(workflow).exists()).toBe(true)
  expect(await Bun.file(workflow).text()).toContain("/osuki-goal")
})
