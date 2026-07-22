import { describe, expect, mock, test } from "bun:test"

class FakeSource {
  listeners = new Set()

  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener)
  }

  removeEventListener(type, listener) {
    if (type === "message") this.listeners.delete(listener)
  }

  emit(event) {
    for (const listener of [...this.listeners]) listener(event)
  }
}

class FakePort {
  close = mock(() => undefined)
  postMessage = mock(() => undefined)
  start = mock(() => undefined)
  onmessage = null

  emit(data) {
    this.onmessage?.({ data })
  }
}

describe("pet host client", () => {
  test("accepts one exact scoped connection and matches responses", async () => {
    const { connectPetHost } = await import("./package/assets/pet-host.js")
    const source = new FakeSource()
    const parent = {}
    const port = new FakePort()
    const connecting = connectPetHost({ expectedSource: parent, pluginId: "convax-pet", source, surface: "settings" })

    source.emit({ data: { pluginId: "other", protocol: "convax.pet-host/1", surface: "settings", type: "connect" }, ports: [port], source: parent })
    source.emit({ data: { pluginId: "convax-pet", protocol: "wrong", surface: "settings", type: "connect" }, ports: [port], source: parent })
    source.emit({ data: { pluginId: "convax-pet", protocol: "convax.pet-host/1", surface: "settings", type: "connect" }, ports: [port], source: parent })

    const client = await connecting
    expect(port.start).toHaveBeenCalledTimes(1)
    const response = client.request("preferences.get", {})
    expect(port.postMessage).toHaveBeenCalledWith({
      id: "1",
      method: "preferences.get",
      params: {},
      protocol: "convax.pet-host/1",
      type: "request",
    })
    port.emit({ id: "1", ok: true, protocol: "convax.pet-host/1", result: { selectedPetId: "violet" }, type: "response" })
    expect(await response).toEqual({ selectedPetId: "violet" })
  })

  test("delivers bounded events and rejects pending work when closed", async () => {
    const { connectPetHost } = await import("./package/assets/pet-host.js")
    const source = new FakeSource()
    const parent = {}
    const port = new FakePort()
    const connecting = connectPetHost({ expectedSource: parent, pluginId: "convax-pet", source, surface: "overlay" })
    source.emit({ data: { pluginId: "convax-pet", protocol: "convax.pet-host/1", surface: "overlay", type: "connect" }, ports: [port], source: parent })
    const client = await connecting
    const listener = mock(() => undefined)
    const unsubscribe = client.subscribe("activity.changed", listener)

    port.emit({ event: "activity.changed", payload: { revision: 2 }, protocol: "convax.pet-host/1", type: "event" })
    expect(listener).toHaveBeenCalledWith({ revision: 2 })
    unsubscribe()
    port.emit({ event: "activity.changed", payload: { revision: 3 }, protocol: "convax.pet-host/1", type: "event" })
    expect(listener).toHaveBeenCalledTimes(1)

    const pending = client.request("activity.getSnapshot", {})
    client.close()
    await expect(pending).rejects.toThrow("closed")
    await expect(client.request("activity.getSnapshot", {})).rejects.toThrow("closed")
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  test("caps pending requests at 64", async () => {
    const { connectPetHost } = await import("./package/assets/pet-host.js")
    const source = new FakeSource()
    const parent = {}
    const port = new FakePort()
    const connecting = connectPetHost({ expectedSource: parent, pluginId: "convax-pet", source, surface: "overlay" })
    source.emit({ data: { pluginId: "convax-pet", protocol: "convax.pet-host/1", surface: "overlay", type: "connect" }, ports: [port], source: parent })
    const client = await connecting
    const pending = Array.from({ length: 64 }, () => client.request("activity.getSnapshot", {}).catch(() => undefined))

    await expect(client.request("activity.getSnapshot", {})).rejects.toThrow("pending request limit")
    client.close()
    await Promise.all(pending)
  })
})
