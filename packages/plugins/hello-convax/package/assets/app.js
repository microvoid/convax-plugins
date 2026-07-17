(() => {
  "use strict"

  const PROTOCOL = "convax.plugin-host/1"
  const PLUGIN_ID = "hello-convax"
  const status = document.getElementById("status")
  const context = document.getElementById("context")
  const refreshButton = document.getElementById("refresh")
  const pending = new Map()
  let port = null
  let requestSequence = 0

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
  }

  function request(method, params) {
    if (!port) return Promise.reject(new Error("Convax host is not connected"))
    const id = `hello-${++requestSequence}`
    port.postMessage({
      id,
      method,
      ...(params === undefined ? {} : { params }),
      protocol: PROTOCOL,
      type: "request",
    })
    return new Promise((resolve, reject) => pending.set(id, { reject, resolve }))
  }

  function receive(event) {
    const message = event.data
    if (!isObject(message) || message.protocol !== PROTOCOL ||
        message.type !== "response" || typeof message.id !== "string") return
    const operation = pending.get(message.id)
    if (!operation) return
    pending.delete(message.id)
    if (message.ok === true) operation.resolve(message.result)
    else operation.reject(new Error(typeof message.error === "string" ? message.error : "Host request failed"))
  }

  async function refresh() {
    status.textContent = "Reading the active scoped context…"
    try {
      const result = await request("host.context.get")
      context.textContent = JSON.stringify(result, null, 2)
      status.textContent = "Connected through convax.plugin-host/1."
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    }
  }

  function connect(event) {
    const message = event.data
    if (event.source !== window.parent || !isObject(message) ||
        message.protocol !== PROTOCOL || message.type !== "connect" ||
        message.pluginId !== PLUGIN_ID || event.ports.length !== 1 || port) return
    window.removeEventListener("message", connect)
    port = event.ports[0]
    port.onmessage = (portEvent) => {
      if (isObject(portEvent.data) && portEvent.data.protocol === PROTOCOL &&
          portEvent.data.type === "command" && portEvent.data.command === "refresh") {
        void refresh()
        return
      }
      receive(portEvent)
    }
    port.start()
    refreshButton.disabled = false
    void refresh()
  }

  refreshButton.addEventListener("click", () => void refresh())
  window.addEventListener("message", connect)
})()
