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

function creativeWorkflow(spec, progress) {
  const source = smooth(0.07, 0.25, progress)
  const connection = smooth(0.2, 0.48, progress)
  const result = smooth(0.62, 0.84, progress)
  const cursorX = mix(392, 1170, connection)
  const cards = spec.cards.map((card, index) => {
    const visible = smooth(0.28 + index * 0.08, 0.5 + index * 0.08, progress)
    const selected = index === spec.selectedIndex ? smooth(0.62, 0.82, progress) : 0
    const x = 438 + index * 250
    const color = card.color ?? spec.accent
    const bars = [0.78, 0.58, 0.86].map((ratio, barIndex) =>
      `<rect x="${x + 24}" y="${390 + barIndex * 17}" width="${n(164 * ratio * visible)}" height="6" rx="3" fill="${color}" fill-opacity="${n(0.2 + barIndex * 0.08)}"/>`,
    ).join("")
    return `<g opacity="${n(visible)}" transform="translate(0 ${n(mix(22, 0, visible))})">
      ${roundedRect(x, 274, 224, 184, { fill: selected > 0.5 ? color : "#0f1b2e", opacity: selected > 0.5 ? 0.1 : 1, radius: 18, stroke: color, strokeOpacity: 0.28 + selected * 0.52, strokeWidth: selected > 0.5 ? 2 : 1 })}
      <circle cx="${x + 28}" cy="302" r="8" fill="${color}" fill-opacity="0.18"/>
      <circle cx="${x + 28}" cy="302" r="3" fill="${color}"/>
      ${text(card.label, x + 46, 307, { fill: color, size: 10, tracking: 1.1, weight: 750 })}
      ${text(card.title, x + 22, 348, { size: 18, weight: 720 })}
      ${text(card.detail, x + 22, 373, { fill: "#8796ab", size: 11 })}
      ${bars}
      ${selected > 0.01 ? `<g opacity="${n(selected)}">${roundedRect(x + 144, 290, 58, 24, { fill: color, opacity: 0.13, radius: 12, stroke: color, strokeOpacity: 0.35 })}${text("READY", x + 173, 306, { anchor: "middle", fill: color, size: 9, tracking: 0.8, weight: 750 })}</g>` : ""}
    </g>`
  }).join("")
  const sourceFacts = spec.sourceFacts.map((fact, index) => {
    const reveal = smooth(0.12 + index * 0.035, 0.3 + index * 0.035, progress)
    return `<g opacity="${n(reveal)}"><circle cx="108" cy="${390 + index * 39}" r="4" fill="${spec.accent}" fill-opacity="0.78"/>${text(fact, 124, 395 + index * 39, { fill: "#acb8c8", size: 12 })}</g>`
  }).join("")
  const resultItems = spec.resultItems.map((item, index) => {
    const x = 458 + index * 176
    return `${roundedRect(x, 506, 158, 34, { fill: index === spec.resultItems.length - 1 ? spec.accent : "#17253a", opacity: index === spec.resultItems.length - 1 ? 0.11 : 0.72, radius: 10, stroke: index === spec.resultItems.length - 1 ? spec.accent : "#33445e", strokeOpacity: 0.4 })}${text(item, x + 79, 528, { anchor: "middle", fill: index === spec.resultItems.length - 1 ? spec.accent : "#94a2b6", size: 10, tracking: 0.55, weight: 680 })}`
  }).join("")
  return shell(`
    <g opacity="${n(source)}" filter="url(#shadow)">
      ${roundedRect(72, 220, 320, 362, { fill: "url(#surface)", radius: 24, stroke: spec.accent, strokeOpacity: 0.28 })}
      ${text(spec.sourceLabel, 98, 254, { fill: "#8f9db2", size: 11, tracking: 1.35, weight: 720 })}
      ${roundedRect(98, 277, 268, 82, { fill: spec.accent, opacity: 0.08, radius: 14, stroke: spec.accent, strokeOpacity: 0.24 })}
      ${text(spec.sourceTitle, 116, 311, { size: 20, weight: 730 })}
      ${text(spec.sourceDetail, 116, 335, { fill: spec.accent, size: 11, tracking: 0.5, weight: 650 })}
      ${sourceFacts}
      ${roundedRect(98, 533, 268, 27, { fill: "#17253a", opacity: 0.8, radius: 13, stroke: "#33445e", strokeOpacity: 0.45 })}
      ${text(spec.sourceStatus, 232, 551, { anchor: "middle", fill: "#8c9aaf", size: 10, tracking: 0.7, weight: 680 })}
    </g>
    <g opacity="${n(connection)}">
      <path d="M392 366 C410 336 416 336 432 336" fill="none" stroke="${spec.accent}" stroke-opacity="0.54" stroke-width="2" stroke-dasharray="5 7"/>
      <line x1="438" y1="474" x2="1162" y2="474" stroke="#2f405a" stroke-opacity="0.75"/>
      <line x1="438" y1="474" x2="${n(cursorX)}" y2="474" stroke="${spec.accent}" stroke-opacity="0.72" stroke-width="3"/>
      <circle cx="${n(cursorX)}" cy="474" r="6" fill="${spec.accent}"/>
    </g>
    ${cards}
    <g opacity="${n(result)}">
      ${roundedRect(438, 488, 724, 70, { fill: "#0e1a2c", radius: 18, stroke: spec.accent, strokeOpacity: 0.2 })}
      ${resultItems}
    </g>
  `, spec, progress)
}

function transferWorkflow(spec, progress) {
  const source = smooth(0.07, 0.26, progress)
  const transfer = smooth(0.24, 0.68, progress)
  const destination = smooth(0.5, 0.78, progress)
  const complete = smooth(0.72, 0.9, progress)
  const cursorX = mix(430, 846, transfer)
  const sourceItems = spec.sourceItems.map((item, index) => {
    const y = 294 + index * 82
    const visible = smooth(0.12 + index * 0.05, 0.32 + index * 0.05, progress)
    return `<g opacity="${n(visible)}">
      ${roundedRect(98, y, 278, 64, { fill: "#101d30", radius: 13, stroke: item.color ?? spec.accent, strokeOpacity: 0.27 })}
      <rect x="110" y="${y + 11}" width="54" height="42" rx="8" fill="${item.color ?? spec.accent}" fill-opacity="0.16"/>
      <path d="M120 ${y + 42} l12 -12 9 8 8 -11 7 15z" fill="${item.color ?? spec.accent}" fill-opacity="0.7"/>
      ${text(item.label, 178, y + 28, { size: 12, weight: 700 })}
      ${text(item.detail, 178, y + 46, { fill: "#8291a7", size: 10 })}
    </g>`
  }).join("")
  const checkpoints = spec.checkpoints.map((checkpoint, index) => {
    const x = 484 + index * 132
    const active = smooth(0.28 + index * 0.1, 0.5 + index * 0.1, progress)
    return `<g opacity="${n(0.3 + active * 0.7)}">
      <circle cx="${x}" cy="376" r="27" fill="${spec.accent}" fill-opacity="${n(0.05 + active * 0.12)}" stroke="${spec.accent}" stroke-opacity="${n(0.2 + active * 0.55)}"/>
      <circle cx="${x}" cy="376" r="6" fill="${active > 0.6 ? spec.accent : "#43536b"}"/>
      ${text(checkpoint, x, 423, { anchor: "middle", fill: active > 0.6 ? spec.accent : "#7f8ea4", size: 9, tracking: 0.8, weight: 700 })}
    </g>`
  }).join("")
  const destinationRows = spec.destinationRows.map((row, index) => {
    const y = 356 + index * 45
    return `${roundedRect(910, y, 250, 32, { fill: index === spec.destinationRows.length - 1 ? spec.accent : "#17253a", opacity: index === spec.destinationRows.length - 1 ? 0.11 : 0.72, radius: 10, stroke: index === spec.destinationRows.length - 1 ? spec.accent : "#33445e", strokeOpacity: 0.38 })}${text(row, 1035, y + 21, { anchor: "middle", fill: index === spec.destinationRows.length - 1 ? spec.accent : "#96a4b7", size: 10, tracking: 0.45, weight: 680 })}`
  }).join("")
  return shell(`
    <g opacity="${n(source)}" filter="url(#shadow)">
      ${roundedRect(72, 220, 330, 360, { fill: "url(#surface)", radius: 24, stroke: spec.accent, strokeOpacity: 0.27 })}
      ${text(spec.sourceLabel, 98, 254, { fill: "#8f9db2", size: 11, tracking: 1.35, weight: 720 })}
      ${sourceItems}
      ${text(spec.sourceStatus, 100, 548, { fill: spec.accent, size: 11, tracking: 0.8, weight: 720 })}
    </g>
    <g opacity="${n(transfer)}">
      <line x1="430" y1="376" x2="846" y2="376" stroke="#33445d" stroke-width="2" stroke-dasharray="7 9"/>
      <line x1="430" y1="376" x2="${n(cursorX)}" y2="376" stroke="${spec.accent}" stroke-opacity="0.75" stroke-width="3"/>
      <circle cx="${n(cursorX)}" cy="376" r="22" fill="${spec.accent}" fill-opacity="0.08"/>
      <circle cx="${n(cursorX)}" cy="376" r="6" fill="${spec.accent}"/>
      ${checkpoints}
    </g>
    <g opacity="${n(destination)}" filter="url(#shadow)">
      ${roundedRect(874, 220, 334, 360, { fill: "url(#surface)", radius: 24, stroke: spec.accent, strokeOpacity: 0.29 })}
      ${text(spec.destinationLabel, 900, 254, { fill: "#8f9db2", size: 11, tracking: 1.35, weight: 720 })}
      ${roundedRect(900, 278, 282, 58, { fill: spec.accent, opacity: 0.08, radius: 14, stroke: spec.accent, strokeOpacity: 0.23 })}
      <circle cx="926" cy="307" r="10" fill="${spec.accent}" fill-opacity="0.2"/>
      <path d="M921 307 l4 4 8 -9" fill="none" stroke="${spec.accent}" stroke-width="2.5" stroke-linecap="round"/>
      ${text(spec.destinationTitle, 946, 305, { size: 14, weight: 720 })}
      ${text(spec.destinationDetail, 946, 323, { fill: "#8291a7", size: 9 })}
      ${destinationRows}
      <g opacity="${n(complete)}">
        ${roundedRect(900, 518, 282, 36, { fill: spec.accent, opacity: 0.12, radius: 12, stroke: spec.accent, strokeOpacity: 0.4 })}
        ${text(spec.completeLabel, 1041, 541, { anchor: "middle", fill: spec.accent, size: 10, tracking: 0.7, weight: 750 })}
      </g>
    </g>
  `, spec, progress)
}

function skillWorkbench(spec, progress) {
  const tree = smooth(0.07, 0.26, progress)
  const editor = smooth(0.24, 0.52, progress)
  const review = smooth(0.48, 0.8, progress)
  const complete = smooth(0.76, 0.91, progress)
  const treeRows = spec.tree.map((item, index) => {
    const visible = smooth(0.1 + index * 0.035, 0.3 + index * 0.035, progress)
    const y = 298 + index * 41
    return `<g opacity="${n(visible)}">
      <path d="M${104 + item.depth * 18} ${y - 8} v18" stroke="#34455f" stroke-opacity="0.7"/>
      <rect x="${116 + item.depth * 18}" y="${y - 14}" width="18" height="16" rx="4" fill="${item.folder ? spec.accent : "#5f718a"}" fill-opacity="${item.folder ? 0.18 : 0.13}"/>
      ${text(item.label, 145 + item.depth * 18, y, { fill: item.active ? spec.accent : "#a2afc0", size: 11, weight: item.active ? 700 : 520 })}
    </g>`
  }).join("")
  const editorLines = spec.editorLines.map((line, index) => {
    const visible = smooth(0.3 + index * 0.045, 0.52 + index * 0.045, progress)
    const y = 311 + index * 34
    const lineWidth = Math.min(382, 94 + line.length * 5.1)
    return `<g opacity="${n(visible)}">${text(String(index + 1), 424, y, { anchor: "end", fill: "#53627a", size: 10 })}<rect x="443" y="${y - 9}" width="${n(lineWidth)}" height="8" rx="4" fill="${index === 0 ? spec.accent : "#8292a9"}" fill-opacity="${index === 0 ? 0.58 : 0.26}"/>${text(line, 451, y - 1, { fill: index === 0 ? "#d8c8ff" : "#aab6c7", size: 9 })}</g>`
  }).join("")
  const checks = spec.checks.map((check, index) => {
    const active = smooth(0.5 + index * 0.06, 0.7 + index * 0.06, progress)
    const y = 307 + index * 49
    return `<g opacity="${n(0.2 + active * 0.8)}">
      <circle cx="958" cy="${y - 4}" r="10" fill="${spec.accent}" fill-opacity="${n(0.06 + active * 0.16)}" stroke="${spec.accent}" stroke-opacity="${n(0.2 + active * 0.65)}"/>
      <path d="M953 ${y - 4} l3 3 6 -7" fill="none" stroke="${active > 0.5 ? spec.accent : "#687891"}" stroke-width="2"/>
      ${text(check, 978, y, { fill: active > 0.5 ? "#b5c0ce" : "#718198", size: 11, weight: 620 })}
    </g>`
  }).join("")
  const scanY = mix(280, 526, smooth(0.32, 0.72, progress))
  return shell(`
    <g opacity="${n(tree)}" filter="url(#shadow)">
      ${roundedRect(72, 220, 296, 360, { fill: "url(#surface)", radius: 24, stroke: spec.accent, strokeOpacity: 0.26 })}
      ${text(spec.treeLabel, 98, 254, { fill: "#8f9db2", size: 11, tracking: 1.35, weight: 720 })}
      ${treeRows}
    </g>
    <g opacity="${n(editor)}" filter="url(#shadow)">
      ${roundedRect(392, 220, 512, 360, { fill: "#0d1828", radius: 24, stroke: spec.accent, strokeOpacity: 0.24 })}
      <rect x="392" y="220" width="512" height="48" rx="24" fill="#142238"/>
      <rect x="392" y="244" width="512" height="24" fill="#142238"/>
      <circle cx="420" cy="244" r="5" fill="#ff786e" fill-opacity="0.75"/><circle cx="438" cy="244" r="5" fill="#f4bd55" fill-opacity="0.75"/><circle cx="456" cy="244" r="5" fill="#55d58b" fill-opacity="0.75"/>
      ${text(spec.editorLabel, 648, 249, { anchor: "middle", fill: "#8796ab", size: 10, tracking: 0.8, weight: 650 })}
      ${editorLines}
      <line x1="414" y1="${n(scanY)}" x2="880" y2="${n(scanY)}" stroke="${spec.accent}" stroke-opacity="0.35"/>
    </g>
    <g opacity="${n(review)}" filter="url(#shadow)">
      ${roundedRect(928, 220, 280, 360, { fill: "url(#surface)", radius: 24, stroke: spec.accent, strokeOpacity: 0.27 })}
      ${text(spec.reviewLabel, 954, 254, { fill: "#8f9db2", size: 11, tracking: 1.25, weight: 720 })}
      ${checks}
      <g opacity="${n(complete)}">
        ${roundedRect(952, 512, 232, 42, { fill: spec.accent, opacity: 0.11, radius: 12, stroke: spec.accent, strokeOpacity: 0.4 })}
        ${text(spec.completeLabel, 1068, 538, { anchor: "middle", fill: spec.accent, size: 10, tracking: 0.75, weight: 750 })}
      </g>
    </g>
  `, spec, progress)
}

const showcaseRenderers = {
  creative: creativeWorkflow,
  transfer: transferWorkflow,
  workbench: skillWorkbench,
}

const generatedShowcaseSpecs = [
  {
    id: "ad-idea", type: "creative", accent: "#ffbf69", label: "CAMPAIGN WORKFLOW", title: "Ad Idea",
    subtitle: "Turn one verified brief into a distinctive, production-ready campaign.",
    footer: ["BRIEF", "TERRITORIES", "SELECT", "PRODUCTION PACK"], posterProgress: 0.84,
    sourceLabel: "CAMPAIGN BRIEF", sourceTitle: "Launch with meaning", sourceDetail: "Verified facts · clear audience",
    sourceFacts: ["Audience tension", "Product proof", "Channel behavior", "Claim boundaries"], sourceStatus: "8 CONSTRAINTS LOCKED",
    cards: [
      { label: "TERRITORY 01", title: "Human truth", detail: "Recognition before reach", color: "#ffd27f" },
      { label: "TERRITORY 02", title: "Product proof", detail: "Demonstration earns belief", color: "#65d7c1" },
      { label: "TERRITORY 03", title: "Useful surprise", detail: "A memorable reversal", color: "#c699ff" },
    ],
    selectedIndex: 2, resultItems: ["HOOK", "BEAT SHEET", "SHOT LIST", "CTA + REVIEW"],
  },
  {
    id: "film-shot", type: "creative", accent: "#66b7ff", label: "CINEMATIC WORKFLOW", title: "Film Shot",
    subtitle: "Translate dramatic intent into coherent coverage and generation-ready shots.",
    footer: ["SCENE", "COVERAGE", "CONTINUITY", "SHOT PACK"], posterProgress: 0.85,
    sourceLabel: "SCENE 07", sourceTitle: "The last train", sourceDetail: "Turning point · one location",
    sourceFacts: ["Geography anchored", "Eyelines preserved", "Performance first", "Lighting continuity"], sourceStatus: "DRAMATIC BEATS MAPPED",
    cards: [
      { label: "SHOT 01", title: "Wide master", detail: "35 mm · geography", color: "#77c4ff" },
      { label: "SHOT 02", title: "Slow push-in", detail: "50 mm · realization", color: "#6de0cf" },
      { label: "SHOT 03", title: "Held reaction", detail: "85 mm · consequence", color: "#c49cff" },
    ],
    selectedIndex: 1, resultItems: ["BLOCKING", "LENS", "EDIT ORDER", "CONTINUITY OK"],
  },
  {
    id: "short-drama-screenwriter", type: "creative", accent: "#ff7699", label: "STORY WORKFLOW", title: "Short Drama",
    subtitle: "Build an episodic engine with playable turns, hooks, and continuity.",
    footer: ["SERIES PROMISE", "EPISODE LADDER", "SCRIPT", "CONTINUITY"], posterProgress: 0.86,
    sourceLabel: "SERIES BRIEF", sourceTitle: "A promise under pressure", sourceDetail: "Vertical · 90 seconds",
    sourceFacts: ["Concrete protagonist goal", "Repeatable opposition", "Escalating consequences", "Producible locations"], sourceStatus: "CHARACTER ENGINE ACTIVE",
    cards: [
      { label: "EPISODE 01", title: "Immediate hook", detail: "The situation changes", color: "#ff8aa8" },
      { label: "EPISODE 02", title: "Costly reversal", detail: "A secret changes tactics", color: "#f6b664" },
      { label: "EPISODE 03", title: "Earned cliffhanger", detail: "A choice demands action", color: "#b99aff" },
    ],
    selectedIndex: 2, resultItems: ["BIBLE", "BEAT SHEET", "SCRIPT", "CLIFFHANGER"],
  },
  {
    id: "video-prompting", type: "creative", accent: "#8ca8ff", label: "GENERATION WORKFLOW", title: "Video Prompting",
    subtitle: "Separate identity, visible motion, and camera intent into one clear prompt.",
    footer: ["REFERENCES", "MOTION PLAN", "PROMPT", "DIAGNOSE"], posterProgress: 0.84,
    sourceLabel: "REFERENCE MAP", sourceTitle: "One role per reference", sourceDetail: "Identity · motion · framing",
    sourceFacts: ["Start and end state", "Observable action", "Motivated camera", "Explicit exclusions"], sourceStatus: "CONSTRAINTS CONSISTENT",
    cards: [
      { label: "LAYER 01", title: "Locked identity", detail: "Subject stays recognizable", color: "#93afff" },
      { label: "LAYER 02", title: "Visible motion", detail: "Clear progression in time", color: "#65d8c7" },
      { label: "LAYER 03", title: "Camera intent", detail: "One motivated move", color: "#c092ff" },
    ],
    selectedIndex: 2, resultItems: ["MASTER PROMPT", "NEGATIVES", "TIMING", "READY TO TEST"],
  },
  {
    id: "clip-export", type: "transfer", accent: "#4fd6e5", label: "MEDIA TRANSFER", title: "Clip Export",
    subtitle: "Move verified Canvas media into the right JianYing draft without guessing.",
    footer: ["QUERY", "DRAFT STATUS", "TARGET", "EXPORT ONCE"], posterProgress: 0.86,
    sourceLabel: "ACTIVE CANVAS", sourceStatus: "REVISION 42 · SELECTION VERIFIED",
    sourceItems: [
      { label: "Opening frame", detail: "IMAGE · 1920 × 1080", color: "#74c8ff" },
      { label: "Product reveal", detail: "VIDEO · 00:06", color: "#ad91ff" },
      { label: "End card", detail: "IMAGE · 1080 × 1920", color: "#5fd9bd" },
    ],
    checkpoints: ["SELECT", "STATUS", "TARGET"], destinationLabel: "JIANYING DRAFT", destinationTitle: "Campaign Cut 04",
    destinationDetail: "Active draft · token confirmed", destinationRows: ["Opening frame", "Product reveal", "End card"], completeLabel: "3 MATERIALS IMPORTED",
  },
  {
    id: "ffmpeg-canvas", type: "transfer", accent: "#62d8ff", label: "LOCAL MEDIA TOOL", title: "FFmpeg Canvas",
    subtitle: "Compose a full FFmpeg argv and save the verified output as a new Canvas node.",
    footer: ["SELECT NODE", "BUILD ARGV", "LOCAL FFMPEG", "NEW NODE"], posterProgress: 0.87,
    sourceLabel: "ACTIVE CANVAS", sourceStatus: "SOURCE PRESERVED · SCOPE VERIFIED",
    sourceItems: [
      { label: "Product reveal", detail: "VIDEO · MANAGED ASSET", color: "#72c9ff" },
      { label: "00:04.2 → 00:09.8", detail: "TRIM RANGE", color: "#b68fff" },
      { label: "1080 × 1080", detail: "CROP · H.264", color: "#67dab8" },
    ],
    checkpoints: ["SELECT", "ARGV", "RUN"], destinationLabel: "MANAGED OUTPUT", destinationTitle: "trim-square.mp4",
    destinationDetail: "Verified video · new Canvas node", destinationRows: ["Input unchanged", "Asset admitted", "Node + edge created"], completeLabel: "OUTPUT SAVED TO CANVAS",
  },
  {
    id: "hello-convax-guide", type: "transfer", accent: "#65d8b2", label: "HOST CONNECTION", title: "Hello Convax Guide",
    subtitle: "Verify that a Plugin received its scoped, capability-limited host channel.",
    footer: ["PLUGIN NODE", "MESSAGEPORT", "SCOPE", "CONNECTED"], posterProgress: 0.84,
    sourceLabel: "PLUGIN SURFACE", sourceStatus: "REFRESH CONTEXT REQUESTED",
    sourceItems: [
      { label: "Hello Convax", detail: "Sandboxed Plugin frame", color: "#68dbb6" },
      { label: "Owning node", detail: "Bound by the host", color: "#77bfff" },
      { label: "Allowed capability", detail: "Narrow and explicit", color: "#b58fff" },
    ],
    checkpoints: ["PORT", "BIND", "VERIFY"], destinationLabel: "HOST CONTEXT", destinationTitle: "Scoped connection",
    destinationDetail: "convax.plugin-host/1", destinationRows: ["Project scope", "Canvas scope", "Owning node"], completeLabel: "CONNECTED SAFELY",
  },
  {
    id: "skill-creator", type: "workbench", accent: "#8bdc8b", label: "AUTHORING WORKFLOW", title: "Skill Creator",
    subtitle: "Shape a portable Skill around real triggers, bounded steps, and truthful fallbacks.",
    footer: ["TRIGGERS", "BUNDLE", "INSTRUCTIONS", "VALIDATE"], posterProgress: 0.87,
    treeLabel: "PORTABLE BUNDLE", editorLabel: "SKILL.md", reviewLabel: "VALIDATION",
    tree: [
      { label: "my-skill", depth: 0, folder: true }, { label: "SKILL.md", depth: 1, active: true },
      { label: "agents", depth: 1, folder: true }, { label: "openai.yaml", depth: 2 },
      { label: "references", depth: 1, folder: true }, { label: "workflow.md", depth: 2 },
    ],
    editorLines: ["name + trigger description", "define the concrete job", "check host capabilities", "execute bounded steps", "degrade truthfully", "validate structure"],
    checks: ["Trigger accuracy", "Portable paths", "Real capabilities", "Failure behavior", "Minimal bundle"], completeLabel: "SKILL READY",
  },
  {
    id: "skill-reviewer", type: "workbench", accent: "#f2b766", label: "REVIEW WORKFLOW", title: "Skill Reviewer",
    subtitle: "Audit a Skill as an instruction system, then report the smallest safe fixes.",
    footer: ["BOUNDARY", "INSPECT", "FINDINGS", "READINESS"], posterProgress: 0.87,
    treeLabel: "SUPPLIED SKILL", editorLabel: "BOUNDED REVIEW", reviewLabel: "AUDIT AREAS",
    tree: [
      { label: "candidate-skill", depth: 0, folder: true }, { label: "SKILL.md", depth: 1, active: true },
      { label: "references", depth: 1, folder: true }, { label: "policy.md", depth: 2 },
      { label: "scripts", depth: 1, folder: true }, { label: "validate.sh", depth: 2 },
    ],
    editorLines: ["read instructions as data", "verify trigger boundary", "compare named tools", "trace failure paths", "check portability", "rank concrete findings"],
    checks: ["Triggering", "Workflow", "Capabilities", "State safety", "Portability"], completeLabel: "READY WITH FIXES",
  },
]

const showcases = [
  { id: "image-remix", render: imageRemix, posterProgress: 0.78, readme: true },
  { id: "audiobook", render: audiobook, posterProgress: 0.82, readme: true },
  { id: "ecommerce-image", render: ecommerce, posterProgress: 0.86, readme: true },
  ...generatedShowcaseSpecs.map((spec) => ({
    ...spec,
    render: (progress) => showcaseRenderers[spec.type](spec, progress),
  })),
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

function parseRenderOptions(argv) {
  const ids = []
  let all = false
  let readme = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--all") all = true
    else if (argument === "--readme") readme = true
    else if (argument === "--id") {
      const id = argv[++index]
      if (!id || id.startsWith("--")) throw new Error("--id requires a Showcase id")
      ids.push(id)
    } else throw new Error(`Unsupported render argument: ${argument}`)
  }
  if (all && ids.length > 0) throw new Error("Use either --all or --id, not both")
  return { ids, readme, selected: all || ids.length === 0 ? showcases : showcases.filter((showcase) => ids.includes(showcase.id)) }
}

const renderOptions = parseRenderOptions(process.argv.slice(2))
if (renderOptions.selected.length === 0) throw new Error("No matching Showcases were selected")
if (renderOptions.ids.some((id) => !showcases.some((showcase) => showcase.id === id))) {
  throw new Error(`Unknown Showcase id: ${renderOptions.ids.find((id) => !showcases.some((showcase) => showcase.id === id))}`)
}

for (const showcase of renderOptions.selected) {
  renderShowcase(showcase)
  const destination = dirname(join(root, "packages", "skills", showcase.id, "showcase", "poster.png"))
  process.stdout.write(`Rendered ${showcase.id} → ${destination}\n`)
}

if (renderOptions.readme || (renderOptions.ids.length === 0 && !renderOptions.readme)) {
  const readmeShowcases = showcases.filter((showcase) => showcase.readme)
  const readmePreview = join(root, "docs", "assets", "skill-showcases.gif")
  const filterInputs = readmeShowcases.map((_, index) =>
    `[${index}:v]trim=start=0.6:end=4.2,setpts=PTS-STARTPTS,scale=800:450:flags=lanczos[v${index}]`,
  )
  const concatInputs = readmeShowcases.map((_, index) => `[v${index}]`).join("")
  mkdirSync(dirname(readmePreview), { recursive: true })
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    ...readmeShowcases.flatMap((showcase) => ["-i", join(root, "packages", "skills", showcase.id, "showcase", "animation.mp4")]),
    "-filter_complex",
    `${filterInputs.join(";")};${concatInputs}concat=n=${readmeShowcases.length}:v=1:a=0,fps=12,split[preview][palette-source];` +
      "[palette-source]palettegen=max_colors=96:stats_mode=diff[palette];" +
      "[preview][palette]paletteuse=dither=bayer:bayer_scale=3",
    "-loop", "0", readmePreview,
  ])
  process.stdout.write(`Rendered README preview → ${readmePreview}\n`)
}
