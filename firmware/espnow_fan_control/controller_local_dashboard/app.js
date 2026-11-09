const SERVICE_UUID = '33a0b0a9-e3bd-4c03-9789-005a94e37647'
const STATUS_UUID = 'fe47cbad-6901-413c-8cf4-8b17d81f967c'
const READING_TTL_MS = 60000
const toggleButton = document.querySelector('#toggle-view')
const connectButton = document.querySelector('#connect')
const dashboard = document.querySelector('#dashboard')
const message = document.querySelector('#message')
const connectionText = document.querySelector('#connection-text')
const connectionDot = document.querySelector('#connection-dot')

let device = null
let characteristic = null
let connecting = false
let connectionEpoch = 0
let latestStatus = null
let latestStatusAt = 0

function setMessage(text, error = false) {
  message.textContent = text
  message.classList.toggle('error', error)
}

function setConnection(text, state = '') {
  connectionText.textContent = text
  connectionDot.className = `connection-dot ${state}`.trim()
  connectButton.textContent = device?.gatt?.connected ? 'Disconnect Bluetooth' : 'Connect Bluetooth'
  connectButton.disabled = connecting
}

function decodeStatus(view) {
  if (!(view instanceof DataView) || view.byteLength !== 17 || view.getUint8(0) !== 1) return null
  const uint16OrNull = (offset) => {
    const value = view.getUint16(offset, true)
    return value === 0xffff ? null : value
  }
  const flags = view.getUint8(1)
  const count = view.getUint8(3)
  if (count > 3) return null
  return {
    fan_on: Boolean(flags & 1),
    radio_ready: Boolean(flags & 2),
    channel: view.getUint8(2),
    valid_loggers: count,
    mean_co2_ppm: uint16OrNull(4),
    loggers: [1, 2, 3].map((id, index) => {
      const seconds = view.getUint8(12 + index)
      return {
        id,
        co2_ppm: uint16OrNull(6 + index * 2),
        age_ms: seconds === 0xff ? null : seconds * 1000,
      }
    }),
    on_hold_remaining_ms: uint16OrNull(15) === null ? null : uint16OrNull(15) * 1000,
  }
}

function acceptStatus(view) {
  const status = decodeStatus(view)
  if (!status) return
  latestStatus = status
  latestStatusAt = Date.now()
  renderStatus()
  setMessage('Receiving controller status over Bluetooth. No cloud connection is used.')
}

function onValueChanged(event) {
  if (event.target?.value) acceptStatus(event.target.value)
}

function renderStatus() {
  if (!latestStatus || dashboard.hidden) return
  const status = latestStatus
  const frameAgeMs = Date.now() - latestStatusAt
  const streamFresh = frameAgeMs < 7000

  document.querySelector('#fan-state').textContent = status.fan_on ? 'ON' : 'OFF'
  document.querySelector('.fan-metric').className = `metric fan-metric ${status.fan_on ? 'on' : 'off'}`
  document.querySelector('#fan-detail').textContent = !streamFresh
    ? 'Last reported command; Bluetooth data has paused'
    : status.fan_on ? 'Controller is commanding the relay on' : 'Controller is commanding the relay off'
  document.querySelector('#mean-co2').textContent = status.mean_co2_ppm === null
    ? '—' : status.mean_co2_ppm.toFixed(0)
  document.querySelector('#valid-count').textContent = String(status.valid_loggers)
  document.querySelector('#mean-detail').textContent = status.on_hold_remaining_ms !== null
    ? `Fan-on hold: ${Math.ceil(status.on_hold_remaining_ms / 1000)} s remaining`
    : status.valid_loggers === 0 ? 'No fresh logger readings; fan fails off' : 'Mean of fresh logger readings'
  document.querySelector('#radio-detail').textContent = status.radio_ready
    ? `ESP-NOW listening · channel ${status.channel}` : 'ESP-NOW receiver unavailable'
  document.querySelector('#updated-at').textContent = streamFresh
    ? `Updated ${Math.round(frameAgeMs / 1000)} s ago` : 'Bluetooth status is out of date'

  for (const logger of status.loggers) {
    const card = document.querySelector(`#logger-${logger.id}`)
    const ageMs = logger.age_ms === null ? null : logger.age_ms + frameAgeMs
    const fresh = streamFresh && ageMs !== null && ageMs <= READING_TTL_MS
    card.className = `logger ${fresh ? 'fresh' : 'stale'}`
    card.querySelector('.logger-status').textContent = fresh ? 'Fresh' : 'Unavailable'
    card.querySelector('.logger-value').textContent = logger.co2_ppm === null ? '—' : `${logger.co2_ppm} ppm`
    card.querySelector('.logger-age').textContent = ageMs === null
      ? 'No reading received' : `Last measurement ${Math.round(ageMs / 1000)} s ago`
  }

  if (device?.gatt?.connected) {
    setConnection(streamFresh ? 'Live from controller Bluetooth' : 'Waiting for controller data', streamFresh ? 'live' : 'waiting')
  }
}

function onDisconnected() {
  characteristic?.removeEventListener('characteristicvaluechanged', onValueChanged)
  characteristic = null
  device = null
  if (!dashboard.hidden) {
    setConnection('Bluetooth disconnected')
    setMessage('Choose AQ-FAN to reconnect.')
  }
}

function disconnectBluetooth() {
  ++connectionEpoch
  characteristic?.removeEventListener('characteristicvaluechanged', onValueChanged)
  characteristic = null
  if (device) {
    device.removeEventListener('gattserverdisconnected', onDisconnected)
    if (device.gatt?.connected) device.gatt.disconnect()
    device = null
  }
  if (!dashboard.hidden) {
    setConnection('Bluetooth disconnected')
    setMessage('Choose AQ-FAN to reconnect.')
  }
}

async function connectBluetooth() {
  if (device?.gatt?.connected || connecting) return
  if (!navigator.bluetooth) {
    setConnection('Web Bluetooth unavailable')
    setMessage('Use desktop Chrome or Edge on a computer with Bluetooth enabled.', true)
    return
  }
  connecting = true
  const epoch = ++connectionEpoch
  setConnection('Choose AQ-FAN', 'waiting')
  setMessage('Choose AQ-FAN in your browser’s Bluetooth device picker.')
  let selectedDevice = null
  try {
    // requestDevice must run from this click, before any await.
    selectedDevice = await navigator.bluetooth.requestDevice({
      filters: [{ name: 'AQ-FAN' }],
      optionalServices: [SERVICE_UUID],
    })
    if (connectionEpoch !== epoch || dashboard.hidden) return
    selectedDevice.addEventListener('gattserverdisconnected', onDisconnected)
    const server = await selectedDevice.gatt.connect()
    if (connectionEpoch !== epoch || dashboard.hidden) {
      server.disconnect()
      return
    }
    const service = await server.getPrimaryService(SERVICE_UUID)
    const nextCharacteristic = await service.getCharacteristic(STATUS_UUID)
    await nextCharacteristic.startNotifications()
    if (connectionEpoch !== epoch || dashboard.hidden) {
      server.disconnect()
      return
    }
    device = selectedDevice
    characteristic = nextCharacteristic
    characteristic.addEventListener('characteristicvaluechanged', onValueChanged)
    setConnection('Waiting for controller status', 'waiting')
    setMessage('Connected. A status update should arrive within two seconds.')
    acceptStatus(await characteristic.readValue())
  } catch (error) {
    selectedDevice?.gatt?.disconnect()
    if (connectionEpoch === epoch && !dashboard.hidden) {
      const canceled = error instanceof DOMException && error.name === 'NotFoundError'
      setConnection(canceled ? 'No device selected' : 'Connection failed')
      setMessage(canceled ? 'Choose AQ-FAN when ready.' :
        `Could not connect: ${error instanceof Error ? error.message : 'unknown error'}. Make sure Bluetooth is on and the controller is nearby.`, !canceled)
    }
  } finally {
    connecting = false
    connectButton.disabled = false
  }
}

toggleButton.addEventListener('click', () => {
  if (dashboard.hidden) {
    dashboard.hidden = false
    toggleButton.textContent = 'Hide local dashboard'
    toggleButton.setAttribute('aria-expanded', 'true')
    void connectBluetooth()
  } else {
    dashboard.hidden = true
    toggleButton.textContent = 'Show local dashboard'
    toggleButton.setAttribute('aria-expanded', 'false')
    disconnectBluetooth()
  }
})

connectButton.addEventListener('click', () => {
  if (device?.gatt?.connected) disconnectBluetooth()
  else void connectBluetooth()
})

window.setInterval(renderStatus, 1000)
window.addEventListener('pagehide', disconnectBluetooth)
