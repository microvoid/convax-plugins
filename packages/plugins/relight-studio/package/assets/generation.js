function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function normalizeGenerationTools(result) {
  if (!isRecord(result) || !Array.isArray(result.tools)) return []
  const seen = new Set()
  return result.tools.filter(function (tool) {
    if (
      !isRecord(tool) ||
      typeof tool.id !== "string" ||
      typeof tool.title !== "string" ||
      tool.kind !== "model" ||
      tool.output !== "image" ||
      !Array.isArray(tool.acceptedInputs) ||
      !tool.acceptedInputs.includes("reference_image") ||
      seen.has(tool.id)
    ) return false
    seen.add(tool.id)
    return true
  }).map(function (tool) {
    return {
      id: tool.id,
      title: tool.title,
      description: typeof tool.description === "string" ? tool.description : "",
    }
  })
}

export function buildRelightGenerationRequest(options) {
  return {
    output: "image",
    prompt: options.prompt,
    references: [{ nodeId: options.referenceNodeId, role: "reference_image" }],
    resultMode: "create-pending-node",
    toolId: options.toolId,
  }
}
