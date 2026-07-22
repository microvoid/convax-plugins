import { Select, Slider, Tooltip } from "radix-ui"
import { createRoot, type Root } from "react-dom/client"

interface MountedControl {
  host: HTMLElement
  render(): void
  root: Root
}

export interface RadixControls {
  destroy(): void
  sync(): void
}

function dispatchNativeControl(element: HTMLElement, type: "change" | "input") {
  element.dispatchEvent(new Event(type, { bubbles: true }))
}

function labelFor(element: HTMLInputElement | HTMLSelectElement) {
  return element.getAttribute("aria-label") || element.labels?.[0]?.textContent?.trim() || "Control"
}

function mountSelect(select: HTMLSelectElement, controls: MountedControl[]) {
  const host = document.createElement("span")
  host.className = "radix-select-host"
  select.insertAdjacentElement("afterend", host)
  const root = createRoot(host)
  const mounted: MountedControl = {
    host,
    root,
    render() {
      const options = Array.from(select.options)
        .filter((option) => option.value.length > 0)
        .map((option) => ({
          description: option.title,
          disabled: option.disabled,
          label: option.textContent || option.value,
          value: option.value,
        }))
      const selected = options.some((option) => option.value === select.value) ? select.value : undefined
      const placeholder = select.options[0]?.textContent || "请选择"
      root.render(
        <Select.Root
          disabled={select.disabled}
          value={selected}
          onValueChange={(value) => {
            select.value = value
            dispatchNativeControl(select, "change")
            mounted.render()
          }}
        >
          <Select.Trigger className="radix-select-trigger" aria-label={labelFor(select)}>
            <Select.Value placeholder={placeholder} />
            <Select.Icon className="radix-select-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="m7 9 5 5 5-5" /></svg>
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content className="radix-select-content" position="popper" sideOffset={5}>
              <Select.Viewport className="radix-select-viewport">
                {options.map((option) => (
                  <Select.Item
                    className="radix-select-item"
                    disabled={option.disabled}
                    key={option.value}
                    title={option.description}
                    value={option.value}
                  >
                    <Select.ItemText>{option.label}</Select.ItemText>
                    <Select.ItemIndicator className="radix-select-indicator" aria-hidden="true">✓</Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>,
      )
    },
  }
  controls.push(mounted)
}

function mountSlider(input: HTMLInputElement, controls: MountedControl[]) {
  const host = document.createElement("span")
  host.className = "radix-slider-host"
  input.insertAdjacentElement("afterend", host)
  const root = createRoot(host)
  const mounted: MountedControl = {
    host,
    root,
    render() {
      const minimum = Number(input.min)
      const maximum = Number(input.max)
      const step = Number(input.step)
      const value = Number(input.value)
      const displayValue = input.labels?.[0]?.querySelector("output")?.textContent || input.value
      root.render(
        <Tooltip.Provider delayDuration={260}>
          <Slider.Root
            aria-label={labelFor(input)}
            className="radix-slider-root"
            disabled={input.disabled}
            max={Number.isFinite(maximum) ? maximum : 100}
            min={Number.isFinite(minimum) ? minimum : 0}
            step={Number.isFinite(step) && step > 0 ? step : 1}
            value={[Number.isFinite(value) ? value : 0]}
            onValueChange={([next]) => {
              if (next === undefined) return
              input.value = String(next)
              dispatchNativeControl(input, "input")
              mounted.render()
            }}
            onValueCommit={() => dispatchNativeControl(input, "change")}
          >
            <Slider.Track className="radix-slider-track">
              <Slider.Range className="radix-slider-range" />
            </Slider.Track>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <Slider.Thumb className="radix-slider-thumb" />
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content className="radix-tooltip-content" sideOffset={7}>
                  {displayValue}
                  <Tooltip.Arrow className="radix-tooltip-arrow" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Slider.Root>
        </Tooltip.Provider>,
      )
    },
  }
  controls.push(mounted)
}

export function mountRadixControls(scope: ParentNode = document): RadixControls {
  const controls: MountedControl[] = []
  scope.querySelectorAll<HTMLSelectElement>("select[data-radix-select]").forEach((select) => {
    select.classList.add("radix-native-control")
    select.hidden = true
    select.tabIndex = -1
    select.setAttribute("aria-hidden", "true")
    mountSelect(select, controls)
  })
  scope.querySelectorAll<HTMLInputElement>('input[type="range"][data-radix-slider]').forEach((input) => {
    input.classList.add("radix-native-control")
    input.hidden = true
    input.tabIndex = -1
    input.setAttribute("aria-hidden", "true")
    mountSlider(input, controls)
  })
  controls.forEach((control) => control.render())
  return {
    destroy() {
      controls.forEach((control) => {
        control.root.unmount()
        control.host.remove()
      })
      controls.length = 0
    },
    sync() {
      controls.forEach((control) => control.render())
    },
  }
}
