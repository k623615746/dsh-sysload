/**
 * dsh-sysload — Host half.
 *
 * Samples machine-wide CPU / GPU / memory load on the Host process (the only
 * place that can read it) and publishes one JSON document on the browser
 * carrier, `/dsh-sysload/stats`. The Client half in the Session header polls
 * that route with a path RELATIVE to the page, so the widget keeps working
 * behind a reverse-proxy prefix and inside the desktop shell.
 *
 * The route takes no input: it never reads the query string, the body, or the
 * headers, so nothing a caller sends can reach the shell commands below.
 */
import os from 'node:os'
import { execFile } from 'node:child_process'

/** Browser route answering the Client poll. */
const ROUTE_PATH = '/dsh-sysload/stats'
/** A GPU reading younger than this is reused instead of spawning a probe. */
const GPU_FRESH_MS = 1800
/** nvidia-smi answers in about 100 ms; this bound only guards a hung driver. */
const NVIDIA_TIMEOUT_MS = 5000
/** The Windows GPU perf-counter set is slow to enumerate — bound it hard. */
const COUNTER_TIMEOUT_MS = 25000
/** After a failed perf-counter attempt, stop retrying for a while. */
const COUNTER_COOLDOWN_MS = 300000

/** Clamp to a percentage, or `null` when the sample is not a number. */
const toPct = (value) => (Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null)

/* ------------------------------------------------------------------ CPU --- */

/** Counters from the previous sample; a delta between two reads is the load. */
let previousCpu = null

function readCpuCounters() {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const times = cpu.times
    idle += times.idle
    for (const key of Object.keys(times)) total += times[key]
  }
  return { idle, total, cores: cpus.length }
}

/**
 * Load since the previous call. The first call has no predecessor, so it
 * reports the average since boot — one poll later the delta takes over.
 */
function sampleCpu() {
  const current = readCpuCounters()
  const previous = previousCpu
  previousCpu = current
  if (previous !== null) {
    const idle = current.idle - previous.idle
    const total = current.total - previous.total
    if (total > 0) return { pct: toPct((1 - idle / total) * 100), cores: current.cores }
  }
  if (current.total > 0) return { pct: toPct((1 - current.idle / current.total) * 100), cores: current.cores }
  return { pct: null, cores: current.cores }
}

/* ------------------------------------------------------------- memory ----- */

function sampleMemory() {
  const total = os.totalmem()
  const free = os.freemem()
  const used = Math.max(0, total - free)
  return { pct: total > 0 ? toPct((used / total) * 100) : null, used, total }
}

/* ---------------------------------------------------------------- GPU ----- */

/** Run one probe; a missing binary, non-zero exit, or timeout resolves to `null`. */
function run(file, args, timeout) {
  return new Promise((resolve) => {
    const settle = (error, stdout) => resolve(error === null || error === undefined ? String(stdout) : null)
    try {
      execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, settle)
    } catch {
      // Some hosts refuse to spawn at all (a confined process without pipe
      // rights). That is "no GPU reading available", never a failed request.
      resolve(null)
    }
  })
}

/** `null` = not probed yet, `false` = absent on this machine, string = command. */
let nvidiaCommand = null
let nvidiaProbe = null

function nvidiaCandidates() {
  if (process.platform !== 'win32') return ['nvidia-smi']
  return [
    'nvidia-smi',
    'C:\\Windows\\System32\\nvidia-smi.exe',
    'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
  ]
}

async function resolveNvidia() {
  if (nvidiaCommand !== null) return nvidiaCommand
  if (nvidiaProbe !== null) return nvidiaProbe
  nvidiaProbe = (async () => {
    for (const candidate of nvidiaCandidates()) {
      const answer = await run(candidate, ['--query-gpu=name', '--format=csv,noheader'], NVIDIA_TIMEOUT_MS)
      if (answer !== null && answer.trim() !== '') {
        nvidiaCommand = candidate
        return candidate
      }
    }
    nvidiaCommand = false
    return false
  })()
  try {
    return await nvidiaProbe
  } finally {
    nvidiaProbe = null
  }
}

/** One `utilization.gpu,memory.used,memory.total,name` row per adapter. */
function parseNvidia(text) {
  const gpus = []
  for (const line of text.split(/\r?\n/)) {
    const row = line.trim()
    if (row === '') continue
    const cells = row.split(',').map((cell) => cell.trim())
    if (cells.length < 4) continue
    const utilization = Number.parseFloat(cells[0])
    const usedMib = Number.parseFloat(cells[1])
    const totalMib = Number.parseFloat(cells[2])
    gpus.push({
      pct: toPct(utilization),
      memUsed: Number.isFinite(usedMib) ? usedMib * 1024 * 1024 : null,
      memTotal: Number.isFinite(totalMib) ? totalMib * 1024 * 1024 : null,
      name: cells.slice(3).join(', '),
    })
  }
  return gpus
}

/** Busiest adapter for the bar, summed VRAM for the tooltip. */
function summariseGpus(gpus, source) {
  let pct = null
  let memUsed = null
  let memTotal = null
  for (const gpu of gpus) {
    if (gpu.pct !== null) pct = pct === null ? gpu.pct : Math.max(pct, gpu.pct)
    if (gpu.memUsed !== null) memUsed = (memUsed === null ? 0 : memUsed) + gpu.memUsed
    if (gpu.memTotal !== null) memTotal = (memTotal === null ? 0 : memTotal) + gpu.memTotal
  }
  const name = gpus.length === 1 ? gpus[0].name : `${gpus[0].name} +${gpus.length - 1}`
  return { pct, memUsed, memTotal, name, source }
}

/**
 * Non-NVIDIA adapters (Intel/AMD) expose load only through the GPU Engine
 * performance counter set. It is expensive, so the answer is cached hard and a
 * failure parks the whole strategy for a few minutes.
 */
const COUNTER_SCRIPT = [
  "$s = (Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue)"
  + ' | Measure-Object -Property CookedValue -Sum;',
  "if ($s.Count -gt 0) { [math]::Round($s.Sum, 1) } else { '' }",
].join(' ')

let gpuCache = null
let gpuPending = null
let counterCooldownUntil = 0

/** Absolute Windows PowerShell, so a trimmed PATH cannot hide the shell. */
function powerShellExecutable() {
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows'
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

async function sampleGpu() {
  const now = Date.now()
  if (gpuCache !== null && now - gpuCache.at < GPU_FRESH_MS) return gpuCache.value
  if (gpuPending !== null) return gpuPending

  gpuPending = (async () => {
    let value = null

    const nvidia = await resolveNvidia()
    if (nvidia !== false) {
      const text = await run(
        nvidia,
        ['--query-gpu=utilization.gpu,memory.used,memory.total,name', '--format=csv,noheader,nounits'],
        NVIDIA_TIMEOUT_MS,
      )
      const gpus = text === null ? [] : parseNvidia(text)
      if (gpus.length > 0) value = summariseGpus(gpus, 'nvidia-smi')
    }

    if (value === null && process.platform === 'win32' && Date.now() >= counterCooldownUntil) {
      const text = await run(
        powerShellExecutable(),
        ['-NoProfile', '-NonInteractive', '-Command', COUNTER_SCRIPT],
        COUNTER_TIMEOUT_MS,
      )
      const sum = text === null ? Number.NaN : Number.parseFloat(text.trim())
      if (Number.isFinite(sum)) {
        value = { pct: toPct(sum), memUsed: null, memTotal: null, name: '', source: 'perf-counter' }
      } else {
        counterCooldownUntil = Date.now() + COUNTER_COOLDOWN_MS
      }
    }

    if (value === null) {
      value = { pct: null, memUsed: null, memTotal: null, name: '', source: 'unavailable' }
    }
    gpuCache = { at: Date.now(), value }
    return value
  })()

  try {
    return await gpuPending
  } finally {
    gpuPending = null
  }
}

/* ------------------------------------------------------------- payload ---- */

async function collect() {
  // CPU and memory are read before the GPU probe so the delta covers the gap
  // between two polls instead of the probe's own latency.
  const cpu = sampleCpu()
  const mem = sampleMemory()
  const gpu = await sampleGpu()
  return { at: Date.now(), cpu, mem, gpu }
}

async function handle(req, res) {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('allow', 'GET, HEAD')
    res.end()
    return
  }
  let body
  try {
    body = JSON.stringify(await collect())
  } catch (error) {
    res.statusCode = 500
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'sample failed' }))
    return
  }
  res.statusCode = 200
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store, max-age=0')
  res.end(method === 'HEAD' ? undefined : body)
}

/**
 * Register the sample route on the browser carrier. Without a carrier (a
 * headless composition) there is nothing to serve, so the plugin stays inert.
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  ctx.effect(() => webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: handle }))
}
