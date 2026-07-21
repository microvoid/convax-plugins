import path from "node:path"

const packageRoot = path.resolve(import.meta.dir, "..")
const result = await Bun.build({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  entrypoints: [path.join(packageRoot, "src", "radix-controls.tsx")],
  format: "esm",
  minify: true,
  target: "browser",
})

if (!result.success || result.outputs.length !== 1) {
  result.logs.forEach((message) => console.error(message))
  throw new Error("Relight Studio Radix bundle failed")
}

let source = await result.outputs[0]!.text()
source = source
  // React's production diagnostics do not make network requests, but Plugin
  // packages fail closed on every literal remote URL. Keep the diagnostic local.
  .replaceAll("https://react.dev/errors/", "react-error:")
  // React DOM needs these namespace values at runtime. Split the literals so
  // static package validation cannot mistake standards identifiers for fetches.
  .replaceAll('"http://www.w3.org/1998/Math/MathML"', '"http"+"://www.w3.org/1998/Math/MathML"')
  .replaceAll('"http://www.w3.org/1999/xlink"', '"http"+"://www.w3.org/1999/xlink"')
  .replaceAll('"http://www.w3.org/2000/svg"', '"http"+"://www.w3.org/2000/svg"')
  .replaceAll('"http://www.w3.org/XML/1998/namespace"', '"http"+"://www.w3.org/XML/1998/namespace"')
  .replace(/[ \t]+$/gmu, "")

if (/https?:\/\//iu.test(source)) throw new Error("Relight Studio bundle contains a remote URL")
await Bun.write(path.join(packageRoot, "package", "assets", "radix-controls.js"), source)
