import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const width = 1280
const height = 720
const fps = 30
const seconds = 4.8
const frameCount = Math.round(fps * seconds)

function commandAvailable(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0
}

function rasterizeSvgFrames(frames, destination) {
  if (process.platform === "darwin" && commandAvailable("sips")) {
    execFileSync("sips", ["-s", "format", "png", ...frames, "--out", destination], { stdio: "ignore" })
    return
  }
  if (commandAvailable("rsvg-convert")) {
    for (const frame of frames) {
      const output = join(destination, `${frame.slice(frame.lastIndexOf("/") + 1, -4)}.png`)
      execFileSync("rsvg-convert", ["--width", String(width), "--height", String(height), "--output", output, frame])
    }
    return
  }
  if (commandAvailable("magick")) {
    for (const frame of frames) {
      const output = join(destination, `${frame.slice(frame.lastIndexOf("/") + 1, -4)}.png`)
      execFileSync("magick", [frame, output])
    }
    return
  }
  throw new Error("Rendering showcases requires macOS sips, librsvg's rsvg-convert, or ImageMagick")
}

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const mix = (from, to, amount) => from + (to - from) * amount
const smooth = (from, to, value) => {
  const amount = clamp((value - from) / (to - from))
  return amount * amount * (3 - 2 * amount)
}
const escapeXml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character])
const n = (value) => Number(value).toFixed(2)

function text(value, x, y, options = {}) {
  const {
    anchor = "start",
    fill = "#f7f8fb",
    opacity = 1,
    size = 24,
    weight = 500,
    tracking = 0,
  } = options
  return `<text x="${n(x)}" y="${n(y)}" fill="${fill}" fill-opacity="${n(opacity)}" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="${size}" font-weight="${weight}" letter-spacing="${tracking}" text-anchor="${anchor}">${escapeXml(value)}</text>`
}

function roundedRect(x, y, w, h, options = {}) {
  const {
    fill = "#101b2c",
    opacity = 1,
    radius = 20,
    stroke = "#26344c",
    strokeOpacity = 1,
    strokeWidth = 1,
  } = options
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${radius}" fill="${fill}" fill-opacity="${n(opacity)}" stroke="${stroke}" stroke-opacity="${n(strokeOpacity)}" stroke-width="${strokeWidth}"/>`
}

function header({ accent, label, subtitle, title }, progress) {
  const enter = smooth(0.02, 0.16, progress)
  return `
    <g opacity="${n(enter)}" transform="translate(0 ${n(mix(18, 0, enter))})">
      ${roundedRect(72, 58, 170, 34, { fill: accent, opacity: 0.13, radius: 17, stroke: accent, strokeOpacity: 0.45 })}
      <circle cx="92" cy="75" r="5" fill="${accent}"/>
      ${text("CONVAX SKILL", 108, 81, { fill: accent, size: 13, tracking: 1.8, weight: 700 })}
      ${text(title, 72, 145, { size: 46, weight: 760, tracking: -1.2 })}
      ${text(subtitle, 74, 181, { fill: "#9ba9bd", size: 18 })}
      ${text(label, 1208, 83, { anchor: "end", fill: "#77869d", size: 13, tracking: 1.2, weight: 650 })}
    </g>`
}

function footer(accent, labels, progress) {
  const enter = smooth(0.56, 0.78, progress)
  const items = labels.map((label, index) => {
    const x = 74 + index * 196
    return `${roundedRect(x, 660, 180, 30, { fill: index === labels.length - 1 ? accent : "#142238", opacity: index === labels.length - 1 ? 0.15 : 0.75, radius: 15, stroke: index === labels.length - 1 ? accent : "#2a3a54", strokeOpacity: 0.45 })}${text(label, x + 90, 680, { anchor: "middle", fill: index === labels.length - 1 ? accent : "#a8b4c6", size: 12, tracking: 0.8, weight: 650 })}`
  }).join("")
  return `<g opacity="${n(enter)}">${items}</g>`
}

function shell(content, metadata, progress) {
  const sceneOpacity = smooth(0, 0.06, progress) * (1 - smooth(0.95, 1, progress))
  const scan = -180 + progress * 1680
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <radialGradient id="glow" cx="50%" cy="0%" r="90%">
        <stop offset="0%" stop-color="${metadata.accent}" stop-opacity="0.16"/>
        <stop offset="58%" stop-color="#091321" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="surface" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#122037"/><stop offset="1" stop-color="#0c1626"/>
      </linearGradient>
      <filter id="soft"><feGaussianBlur stdDeviation="16"/></filter>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#02050a" flood-opacity="0.38"/></filter>
      <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#b9c8dc" stroke-opacity="0.035"/></pattern>
    </defs>
    <rect width="1280" height="720" fill="#08111e"/>
    <rect width="1280" height="720" fill="url(#grid)"/>
    <rect width="1280" height="720" fill="url(#glow)"/>
    <circle cx="${n(scan)}" cy="250" r="120" fill="${metadata.accent}" fill-opacity="0.045" filter="url(#soft)"/>
    <g opacity="${n(sceneOpacity)}">
      ${header(metadata, progress)}
      ${content}
      ${footer(metadata.accent, metadata.footer, progress)}
    </g>
  </svg>`
}

function imageRemix(progress) {
  const accent = "#b88cff"
  const input = smooth(0.1, 0.28, progress)
  const process = smooth(0.25, 0.5, progress)
  const output = smooth(0.44, 0.72, progress)
  const cursorX = mix(350, 675, process)
  const cards = [
    { color: "#f2b36d", label: "WARM STUDIO", x: 694, offset: 0 },
    { color: "#71d7cb", label: "COASTAL", x: 872, offset: 0.07 },
    { color: "#c799ff", label: "NEON NIGHT", x: 1050, offset: 0.14 },
  ].map(({ color, label, x, offset }) => {
    const visible = smooth(0.44 + offset, 0.62 + offset, progress)
    const y = mix(250, 224, visible)
    return `<g opacity="${n(visible)}" transform="translate(0 ${n(mix(20, 0, visible))})">
      ${roundedRect(x, y, 154, 308, { fill: "#0f1b2e", radius: 18, stroke: color, strokeOpacity: 0.36 })}
      <rect x="${x + 10}" y="${n(y + 10)}" width="134" height="224" rx="12" fill="${color}" fill-opacity="0.18"/>
      <circle cx="${x + 77}" cy="${n(y + 80)}" r="56" fill="${color}" fill-opacity="0.16"/>
      <path d="M${x + 56} ${n(y + 81)} h42 l9 84 q1 18 -18 18 h-24 q-19 0 -18 -18z" fill="#e8edf5" fill-opacity="0.92"/>
      <rect x="${x + 67}" y="${n(y + 54)}" width="20" height="16" rx="5" fill="#e8edf5"/>
      <rect x="${x + 57}" y="${n(y + 112)}" width="40" height="36" rx="7" fill="${color}" fill-opacity="0.86"/>
      ${text(label, x + 77, y + 264, { anchor: "middle", fill: color, size: 11, tracking: 0.8, weight: 700 })}
      ${text("Identity  98%", x + 77, y + 286, { anchor: "middle", fill: "#8493a9", size: 10 })}
    </g>`
  }).join("")
  const beamWidth = Math.max(0, cursorX - 390)
  return shell(`
    <g opacity="${n(input)}" filter="url(#shadow)">
      ${roundedRect(72, 220, 292, 330, { fill: "url(#surface)", radius: 24, stroke: accent, strokeOpacity: 0.28 })}
      ${text("REFERENCE", 96, 252, { fill: "#8f9db2", size: 11, tracking: 1.4, weight: 700 })}
      <rect x="94" y="272" width="248" height="210" rx="16" fill="#8d68cb" fill-opacity="0.14"/>
      <circle cx="218" cy="349" r="78" fill="#b88cff" fill-opacity="0.12"/>
      <path d="M182 333 h72 l13 99 q2 22 -22 22 h-54 q-24 0 -22 -22z" fill="#f2f4f8"/>
      <rect x="199" y="298" width="38" height="28" rx="8" fill="#f2f4f8"/>
      <rect x="188" y="371" width="60" height="52" rx="9" fill="#a977ee"/>
      ${text("LOCKED", 107, 518, { fill: accent, size: 12, tracking: 1.1, weight: 700 })}
      ${text("shape · label · proportions", 166, 518, { fill: "#8493a9", size: 11 })}
    </g>
    <g opacity="${n(process)}">
      <path d="M390 386 C475 316 555 455 660 360" fill="none" stroke="#31425f" stroke-width="2" stroke-dasharray="7 9"/>
      <path d="M390 386 C475 316 555 455 ${n(cursorX)} ${n(386 - (cursorX - 390) * 0.08)}" fill="none" stroke="${accent}" stroke-opacity="0.75" stroke-width="3"/>
      <circle cx="${n(cursorX)}" cy="${n(386 - (cursorX - 390) * 0.08)}" r="25" fill="${accent}" fill-opacity="0.1"/>
      <circle cx="${n(cursorX)}" cy="${n(386 - (cursorX - 390) * 0.08)}" r="6" fill="${accent}"/>
      ${text("PRESERVE", 449, 333, { anchor: "middle", fill: "#8998ae", size: 10, tracking: 1.2, weight: 700 })}
      ${text("TRANSFORM", 543, 443, { anchor: "middle", fill: "#8998ae", size: 10, tracking: 1.2, weight: 700 })}
      ${text("VERIFY", 633, 323, { anchor: "middle", fill: "#8998ae", size: 10, tracking: 1.2, weight: 700 })}
      <rect x="390" y="540" width="${n(beamWidth)}" height="3" rx="2" fill="${accent}" fill-opacity="0.7"/>
    </g>
    ${cards}
    <g opacity="${n(output)}">${roundedRect(957, 555, 247, 42, { fill: accent, opacity: 0.1, radius: 12, stroke: accent, strokeOpacity: 0.25 })}${text("3 controlled variations ready", 1080, 581, { anchor: "middle", fill: accent, size: 12, weight: 700 })}</g>
  `, { accent, footer: ["REFERENCE", "CONSTRAINTS", "VARIATIONS", "REVIEW"], label: "VISUAL WORKFLOW", subtitle: "Preserve identity. Transform everything else.", title: "Image Remix" }, progress)
}

function audiobook(progress) {
  const accent = "#58d6bd"
  const manuscript = smooth(0.08, 0.27, progress)
  const narration = smooth(0.26, 0.52, progress)
  const chapters = smooth(0.48, 0.74, progress)
  const playhead = mix(548, 1160, smooth(0.34, 0.87, progress))
  const bars = Array.from({ length: 34 }, (_, index) => {
    const x = 538 + index * 18
    const phase = progress * Math.PI * 8 + index * 0.73
    const barHeight = 18 + Math.abs(Math.sin(phase)) * 66 + (index % 4) * 5
    const active = x < playhead
    return `<rect x="${x}" y="${n(382 - barHeight / 2)}" width="8" height="${n(barHeight)}" rx="4" fill="${active ? accent : "#405069"}" fill-opacity="${active ? "0.88" : "0.55"}"/>`
  }).join("")
  return shell(`
    <g opacity="${n(manuscript)}" filter="url(#shadow)">
      ${roundedRect(72, 218, 350, 360, { fill: "url(#surface)", radius: 24, stroke: accent, strokeOpacity: 0.26 })}
      ${text("MANUSCRIPT", 98, 252, { fill: "#8f9db2", size: 11, tracking: 1.4, weight: 700 })}
      ${roundedRect(98, 274, 298, 236, { fill: "#e8ebe8", radius: 12, stroke: "#ffffff", strokeOpacity: 0.25 })}
      ${text("CHAPTER 03", 122, 308, { fill: "#3b4959", size: 10, tracking: 1.4, weight: 750 })}
      ${text("The quiet station", 122, 340, { fill: "#16212d", size: 23, weight: 730 })}
      ${[0, 1, 2, 3, 4, 5].map((index) => `<rect x="122" y="${365 + index * 21}" width="${index === 5 ? 160 : 244 - (index % 3) * 28}" height="7" rx="3.5" fill="#536172" fill-opacity="${0.22 + index * 0.025}"/>`).join("")}
      ${text("2,480 words", 100, 548, { fill: "#8a99ae", size: 12 })}
      ${roundedRect(286, 528, 110, 30, { fill: accent, opacity: 0.12, radius: 15, stroke: accent, strokeOpacity: 0.35 })}
      ${text("ADAPTED", 341, 548, { anchor: "middle", fill: accent, size: 10, tracking: 1.1, weight: 750 })}
    </g>
    <g opacity="${n(narration)}">
      ${roundedRect(480, 218, 724, 236, { fill: "#0e1a2c", radius: 24, stroke: accent, strokeOpacity: 0.25 })}
      ${text("NARRATION · MARA", 512, 253, { fill: accent, size: 11, tracking: 1.3, weight: 750 })}
      ${text("Warm, observant · 142 wpm", 1174, 253, { anchor: "end", fill: "#8796ab", size: 11 })}
      <line x1="518" y1="382" x2="1170" y2="382" stroke="#33435c" stroke-opacity="0.65"/>
      ${bars}
      <line x1="${n(playhead)}" y1="286" x2="${n(playhead)}" y2="430" stroke="#f1f8f6" stroke-opacity="0.75" stroke-width="2"/>
      <circle cx="${n(playhead)}" cy="382" r="8" fill="${accent}"/>
      ${text("03:42", 514, 430, { fill: "#8190a6", size: 11 })}
      ${text("08:16", 1170, 430, { anchor: "end", fill: "#8190a6", size: 11 })}
    </g>
    <g opacity="${n(chapters)}">
      ${roundedRect(480, 478, 724, 100, { fill: "#0e1a2c", radius: 20, stroke: "#263750", strokeOpacity: 0.9 })}
      ${["ARRIVAL", "VOICE NOTE", "REVEAL", "OUTRO"].map((label, index) => {
        const x = 504 + index * 170
        const active = index <= Math.floor(smooth(0.48, 0.85, progress) * 3.99)
        return `${roundedRect(x, 502, 150, 48, { fill: active ? accent : "#17253a", opacity: active ? 0.12 : 0.65, radius: 12, stroke: active ? accent : "#33445e", strokeOpacity: active ? 0.45 : 0.55 })}${text(label, x + 75, 532, { anchor: "middle", fill: active ? accent : "#8392a8", size: 10, tracking: 0.9, weight: 700 })}`
      }).join("")}
    </g>
  `, { accent, footer: ["SCRIPT", "VOICE BIBLE", "CUE SHEET", "DELIVERY"], label: "AUDIO WORKFLOW", subtitle: "From manuscript to a production-ready listening experience.", title: "Audiobook" }, progress)
}

function ecommerce(progress) {
  const accent = "#ff9c67"
  const source = smooth(0.08, 0.28, progress)
  const outputs = smooth(0.3, 0.7, progress)
  const reviewed = smooth(0.67, 0.86, progress)
  const variants = [
    { label: "HERO", x: 502, y: 222, color: "#f0d9bf", delay: 0 },
    { label: "DETAIL", x: 724, y: 222, color: "#d8c3a5", delay: 0.07 },
    { label: "LIFESTYLE", x: 946, y: 222, color: "#9bc6b6", delay: 0.14 },
    { label: "CAMPAIGN", x: 724, y: 422, color: "#d99b7d", delay: 0.21 },
    { label: "MOBILE CROP", x: 946, y: 422, color: "#9d90d9", delay: 0.28 },
  ]
  return shell(`
    <g opacity="${n(source)}" filter="url(#shadow)">
      ${roundedRect(72, 218, 364, 372, { fill: "url(#surface)", radius: 24, stroke: accent, strokeOpacity: 0.28 })}
      ${text("PRODUCT SOURCE", 98, 252, { fill: "#8f9db2", size: 11, tracking: 1.4, weight: 700 })}
      <rect x="98" y="274" width="312" height="228" rx="16" fill="#f5ede5"/>
      <ellipse cx="254" cy="456" rx="98" ry="18" fill="#593e2f" fill-opacity="0.14"/>
      <path d="M190 348 q64 -78 128 0 l18 91 q5 35 -34 35 h-96 q-39 0 -34 -35z" fill="#d88252"/>
      <path d="M212 337 q42 -49 84 0" fill="none" stroke="#6c4a3a" stroke-width="11" stroke-linecap="round"/>
      <rect x="202" y="374" width="104" height="58" rx="10" fill="#f0c8a8" fill-opacity="0.88"/>
      ${text("VERIFIED", 100, 542, { fill: accent, size: 11, tracking: 1, weight: 750 })}
      ${text("color · logo · material", 168, 542, { fill: "#8997ab", size: 11 })}
      <circle cx="390" cy="539" r="8" fill="${accent}" fill-opacity="0.18"/>
      <path d="M386 539 l3 3 6 -7" fill="none" stroke="${accent}" stroke-width="2"/>
    </g>
    ${variants.map(({ color, delay, label, x, y }, index) => {
      const visible = smooth(0.3 + delay, 0.52 + delay, progress)
      const w = index === 0 ? 410 : 188
      const h = index === 0 ? 372 : 172
      const actualY = index === 0 ? y : y
      if (index === 0) {
        return `<g opacity="${n(visible)}" transform="translate(0 ${n(mix(18, 0, visible))})">
          ${roundedRect(x, actualY, w, h, { fill: "#0f1a2b", radius: 22, stroke: color, strokeOpacity: 0.38 })}
          <rect x="${x + 12}" y="${actualY + 12}" width="386" height="292" rx="14" fill="${color}"/>
          <ellipse cx="${x + 205}" cy="${actualY + 265}" rx="106" ry="17" fill="#503326" fill-opacity="0.14"/>
          <path d="M${x + 145} ${actualY + 130} q60 -70 120 0 l18 104 q4 30 -31 30 h-94 q-35 0 -31 -30z" fill="#d88252"/>
          <path d="M${x + 164} ${actualY + 121} q41 -47 82 0" fill="none" stroke="#674537" stroke-width="10" stroke-linecap="round"/>
          ${text(label, x + 25, actualY + 337, { fill: color === "#f0d9bf" ? accent : color, size: 11, tracking: 1.2, weight: 750 })}
          ${text("1:1 · clean background", x + w - 24, actualY + 337, { anchor: "end", fill: "#8492a7", size: 10 })}
        </g>`
      }
      return `<g opacity="${n(visible)}" transform="translate(0 ${n(mix(18, 0, visible))})">
        ${roundedRect(x, actualY, w, h, { fill: "#0f1a2b", radius: 18, stroke: color, strokeOpacity: 0.36 })}
        <rect x="${x + 10}" y="${actualY + 10}" width="168" height="112" rx="11" fill="${color}" fill-opacity="0.82"/>
        <path d="M${x + 67} ${actualY + 50} q27 -30 54 0 l8 46 q2 15 -14 15 h-42 q-16 0 -14 -15z" fill="#d67f50"/>
        ${text(label, x + 15, actualY + 151, { fill: color, size: 9, tracking: 0.8, weight: 750 })}
      </g>`
    }).join("")}
    <g opacity="${n(reviewed)}">
      ${roundedRect(502, 610, 632, 30, { fill: accent, opacity: 0.1, radius: 15, stroke: accent, strokeOpacity: 0.3 })}
      ${text("✓  identity     ✓  label     ✓  variant     ✓  channel crops", 818, 630, { anchor: "middle", fill: accent, size: 11, tracking: 0.45, weight: 700 })}
    </g>
  `, { accent, footer: ["SOURCE", "SHOT MATRIX", "GENERATE", "QUALITY CHECK"], label: "COMMERCE WORKFLOW", subtitle: "One verified product. A coherent, channel-ready image set.", title: "Ecommerce Image" }, progress)
}

const showcases = [
  { id: "image-remix", render: imageRemix, posterProgress: 0.78 },
  { id: "audiobook", render: audiobook, posterProgress: 0.82 },
  { id: "ecommerce-image", render: ecommerce, posterProgress: 0.86 },
]

function renderShowcase(showcase) {
  const destination = join(root, "packages", "skills", showcase.id, "showcase")
  mkdirSync(destination, { recursive: true })
  const working = mkdtempSync(join(tmpdir(), `convax-${showcase.id}-`))
  try {
    const svgDirectory = join(working, "svg")
    const pngDirectory = join(working, "png")
    mkdirSync(svgDirectory)
    mkdirSync(pngDirectory)
    const frames = []
    for (let index = 0; index < frameCount; index += 1) {
      const progress = index / (frameCount - 1)
      const frame = join(svgDirectory, `${String(index).padStart(4, "0")}.svg`)
      writeFileSync(frame, showcase.render(progress))
      frames.push(frame)
    }
    rasterizeSvgFrames(frames, pngDirectory)
    const posterIndex = Math.round(showcase.posterProgress * (frameCount - 1))
    copyFileSync(join(pngDirectory, `${String(posterIndex).padStart(4, "0")}.png`), join(destination, "poster.png"))
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps),
      "-i", join(pngDirectory, "%04d.png"), "-c:v", "libx264", "-preset", "slow", "-crf", "21",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", join(destination, "animation.mp4"),
    ])
  } finally {
    rmSync(working, { force: true, recursive: true })
  }
}

for (const showcase of showcases) {
  renderShowcase(showcase)
  const destination = dirname(join(root, "packages", "skills", showcase.id, "showcase", "poster.png"))
  process.stdout.write(`Rendered ${showcase.id} → ${destination}\n`)
}

const readmePreview = join(root, "docs", "assets", "skill-showcases.gif")
mkdirSync(dirname(readmePreview), { recursive: true })
execFileSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  ...showcases.flatMap((showcase) => ["-i", join(root, "packages", "skills", showcase.id, "showcase", "animation.mp4")]),
  "-filter_complex",
  "[0:v]trim=start=0.6:end=4.2,setpts=PTS-STARTPTS,scale=800:450:flags=lanczos[v0];" +
    "[1:v]trim=start=0.6:end=4.2,setpts=PTS-STARTPTS,scale=800:450:flags=lanczos[v1];" +
    "[2:v]trim=start=0.6:end=4.2,setpts=PTS-STARTPTS,scale=800:450:flags=lanczos[v2];" +
    "[v0][v1][v2]concat=n=3:v=1:a=0,fps=12,split[preview][palette-source];" +
    "[palette-source]palettegen=max_colors=96:stats_mode=diff[palette];" +
    "[preview][palette]paletteuse=dither=bayer:bayer_scale=3",
  "-loop", "0", readmePreview,
])
process.stdout.write(`Rendered README preview → ${readmePreview}\n`)
