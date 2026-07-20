import path from "node:path"

export function defaultStateDirectory(environment: Record<string, string | undefined> = Bun.env) {
  const xdg = environment.XDG_CONFIG_HOME?.trim()
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "convax", "xiaoyunque")
  const home = environment.HOME?.trim()
  if (!home || !path.isAbsolute(home)) {
    throw new Error("A valid home directory is required for XiaoYunque authorization")
  }
  return process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Convax", "XiaoYunque")
    : path.join(home, ".config", "convax", "xiaoyunque")
}
