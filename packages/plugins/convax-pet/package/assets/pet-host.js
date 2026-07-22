const protocol = "convax.pet-host/1"
const maximumPendingRequests = 64
const maximumMessageCharacters = 64 * 1024

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function bounded(value) {
  try {
    return JSON.stringify(value).length <= maximumMessageCharacters
  } catch {
    return false
  }
}

function clientForPort(port) {
  const pending = new Map()
  const listeners = new Map()
  let closed = false
  let nextId = 1

  port.onmessage = ({ data }) => {
    if (closed || !isRecord(data) || data.protocol !== protocol || !bounded(data)) return
    if (data.type === "response" && typeof data.id === "string") {
      const request = pending.get(data.id)
      if (!request) return
      pending.delete(data.id)
      if (data.ok === true) request.resolve(data.result)
      else request.reject(new Error(typeof data.error === "string" ? data.error.slice(0, 500) : "Pet host request failed"))
      return
    }
    if (data.type === "event" && typeof data.event === "string") {
      for (const listener of listeners.get(data.event) ?? []) listener(data.payload)
    }
  }
  port.start()

  return Object.freeze({
    close() {
      if (closed) return
      closed = true
      port.onmessage = null
      port.close()
      for (const request of pending.values()) request.reject(new Error("Pet host connection closed"))
      pending.clear()
      listeners.clear()
    },
    request(method, params) {
      if (closed) return Promise.reject(new Error("Pet host connection closed"))
      if (typeof method !== "string" || method.length < 1 || method.length > 80 || !bounded(params)) {
        return Promise.reject(new Error("Pet host request is invalid"))
      }
      if (pending.size >= maximumPendingRequests) return Promise.reject(new Error("Pet host pending request limit reached"))
      const id = String(nextId++)
      return new Promise((resolve, reject) => {
        pending.set(id, { reject, resolve })
        port.postMessage({ id, method, params, protocol, type: "request" })
      })
    },
    subscribe(event, listener) {
      if (closed || typeof event !== "string" || event.length < 1 || event.length > 80 || typeof listener !== "function") {
        return () => undefined
      }
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
      return () => {
        eventListeners.delete(listener)
        if (eventListeners.size === 0) listeners.delete(event)
      }
    },
  })
}

export function connectPetHost({
  expectedSource = window.parent,
  pluginId,
  source = window,
  surface,
}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginId) || (surface !== "overlay" && surface !== "settings")) {
    return Promise.reject(new Error("Pet host connection scope is invalid"))
  }
  return new Promise((resolve) => {
    const connect = (event) => {
      const message = event.data
      if (
        event.source !== expectedSource ||
        !isRecord(message) ||
        message.protocol !== protocol ||
        message.type !== "connect" ||
        message.pluginId !== pluginId ||
        message.surface !== surface ||
        event.ports?.length !== 1
      ) {
        return
      }
      source.removeEventListener("message", connect)
      resolve(clientForPort(event.ports[0]))
    }
    source.addEventListener("message", connect)
  })
}
