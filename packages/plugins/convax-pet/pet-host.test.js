import { afterEach, describe, expect, jest, mock, test } from "bun:test"

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

afterEach(() => {
  jest.useRealTimers()
})

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

    const pendingSnapshot = client.request("activity.getSnapshot", {})
    const pendingPreferences = client.request("preferences.get", {})
    client.close()
    await expect(pendingSnapshot).rejects.toThrow("closed")
    await expect(pendingPreferences).rejects.toThrow("closed")
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

  test("times out an absent host and removes the handshake listener", async () => {
    jest.useFakeTimers()
    const { connectPetHost } = await import("./package/assets/pet-host.js")
    const source = new FakeSource()
    let timeoutError
    const connecting = connectPetHost({
      expectedSource: {},
      handshakeTimeoutMs: 25,
      pluginId: "convax-pet",
      source,
      surface: "overlay",
    })
    void connecting.catch((error) => {
      timeoutError = error
    })

    expect(source.listeners.size).toBe(1)
    jest.advanceTimersByTime(25)
    await Promise.resolve()

    expect(timeoutError?.message).toContain("timed out")
    expect(source.listeners.size).toBe(0)
  })

  test("times out a silent request and removes it from pending work", async () => {
    jest.useFakeTimers()
    const { connectPetHost } = await import("./package/assets/pet-host.js")
    const source = new FakeSource()
    const parent = {}
    const port = new FakePort()
    const connecting = connectPetHost({
      expectedSource: parent,
      pluginId: "convax-pet",
      requestTimeoutMs: 25,
      source,
      surface: "settings",
    })
    source.emit({ data: { pluginId: "convax-pet", protocol: "convax.pet-host/1", surface: "settings", type: "connect" }, ports: [port], source: parent })
    const client = await connecting
    let timeoutError
    const silent = client.request("preferences.get", {})
    void silent.catch((error) => {
      timeoutError = error
    })

    jest.advanceTimersByTime(25)
    await Promise.resolve()
    expect(timeoutError?.message).toContain("timed out")

    const next = client.request("preferences.get", {})
    port.emit({ id: "2", ok: true, protocol: "convax.pet-host/1", result: { selectedPetId: "violet" }, type: "response" })
    expect(await next).toEqual({ selectedPetId: "violet" })

    const pending = Array.from({ length: 64 }, () => client.request("preferences.get", {}).catch(() => undefined))
    expect(port.postMessage).toHaveBeenCalledTimes(66)
    await expect(client.request("preferences.get", {})).rejects.toThrow("pending request limit")
    client.close()
    await Promise.all(pending)
  })
})
