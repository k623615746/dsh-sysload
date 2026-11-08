/**
 * dsh-sysload — Client half.
 *
 * One compact readout in the Session header (`conversation.session.header.
 * utilities`) showing live CPU / GPU / memory load. The numbers come from the
 * Host route registered in `./index.js`; this module only polls and paints.
 *
 * Polling notes:
 * - The endpoint is requested as a path RELATIVE to the page, so a GUI served
 *   under a reverse-proxy prefix (and the desktop shell's forwarded origin)
 *   resolves it inside the same directory the page lives in.
 * - One shared loop serves every mounted header: `refs` counts subscribers and
 *   the loop stops when the last widget unmounts.
 * - A failed poll backs off to 20 s instead of hammering a missing route, and a
 *   hidden tab polls at 15 s so no `nvidia-smi` spawn rides along with it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sysload',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-sysload'
    const ENDPOINT = 'dsh-sysload/stats'
    const POLL_MS = 2000
    const HIDDEN_POLL_MS = 15000
    const MAX_BACKOFF_MS = 20000

    /* ------------------------------------------------------------ texts --- */

    const DICT = {
      en: {
        title: 'System load',
        cpu: 'CPU',
        gpu: 'GPU',
        mem: 'MEM',
        cores: 'cores',
        unavailable: 'unavailable',
        waiting: 'Waiting for the first sample',
        offline: 'Host sampler unreachable',
      },
      zh: {
        title: '系统负载',
        cpu: 'CPU',
        gpu: 'GPU',
        mem: '内存',
        cores: '线程',
        unavailable: '不可用',
        waiting: '等待首次采样',
        offline: '主机采样不可达',
      },
    }

    /** Bound once in `apply`; the widget only reads it through `t`. */
    let translate = null

    /** Every dictionary this pack ships; registered defensively in `apply`. */
    const PACKS = {
      en: DICT.en,
      zh: DICT.zh,
      'zh-CN': DICT.zh,
      'zh-Hans': DICT.zh,
    }

    function t(key, fallback) {
      if (translate === null) return fallback
      try {
        const value = translate(key)
        return typeof value === 'string' && value !== '' && value !== key ? value : fallback
      } catch {
        return fallback
      }
    }

    /* ------------------------------------------------------------ store --- */

    function createStore() {
      let snapshot = { status: 'idle', data: null }
      const listeners = new Set()
      let timer = 0
      let controller = null
      let failures = 0
      let refs = 0
      let watchingVisibility = false

      const notify = () => {
        for (const listener of Array.from(listeners)) listener()
      }

      function publish(next) {
        snapshot = next
        notify()
      }

      function delayFor() {
        const base = failures === 0
          ? POLL_MS
          : Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(failures, 4))
        return document.visibilityState === 'hidden' ? Math.max(base, HIDDEN_POLL_MS) : base
      }

      function schedule() {
        if (refs <= 0) return
        if (timer !== 0) window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          timer = 0
          void tick()
        }, delayFor())
      }

      async function tick() {
        if (refs <= 0) return
        const local = new AbortController()
        controller = local
        try {
          const response = await fetch(ENDPOINT, {
            signal: local.signal,
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          if (local.signal.aborted) return
          failures = 0
          publish({ status: 'ready', data })
        } catch {
          if (local.signal.aborted) return
          failures += 1
          publish({ status: 'error', data: snapshot.data })
        } finally {
          if (controller === local) controller = null
        }
        if (local.signal.aborted) return
        schedule()
      }

      function onVisibilityChange() {
        if (refs <= 0 || document.visibilityState !== 'visible') return
        if (timer !== 0) {
          window.clearTimeout(timer)
          timer = 0
        }
        void tick()
      }

      function teardown() {
        if (timer !== 0) {
          window.clearTimeout(timer)
          timer = 0
        }
        if (controller !== null) {
          controller.abort()
          controller = null
        }
        if (watchingVisibility) {
          document.removeEventListener('visibilitychange', onVisibilityChange)
          watchingVisibility = false
        }
      }

      return {
        getSnapshot() {
          return snapshot
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        start() {
          refs += 1
          if (refs > 1) return
          if (!watchingVisibility) {
            document.addEventListener('visibilitychange', onVisibilityChange)
            watchingVisibility = true
          }
          void tick()
        },
        stop() {
          refs = Math.max(0, refs - 1)
          if (refs > 0) return
          failures = 0
          teardown()
        },
        halt() {
          refs = 0
          failures = 0
          teardown()
        },
      }
    }

    const store = createStore()

    function useSample() {
      const [snapshot, setSnapshot] = React.useState(store.getSnapshot)
      React.useEffect(() => {
        const unsubscribe = store.subscribe(() => setSnapshot(store.getSnapshot()))
        store.start()
        setSnapshot(store.getSnapshot())
        return () => {
          unsubscribe()
          store.stop()
        }
      }, [])
      return snapshot
    }

    /* ------------------------------------------------------------ values -- */

    const round = (value) => (Number.isFinite(value) ? Math.round(value) : null)
    const gib = 1024 * 1024 * 1024

    function gigabytes(bytes) {
      if (!Number.isFinite(bytes)) return null
      const value = bytes / gib
      return value >= 10 ? value.toFixed(0) : value.toFixed(1)
    }

    function percentOf(data, key) {
      if (data === null || typeof data !== 'object') return null
      if (key === 'cpu') return round(data.cpu && data.cpu.pct)
      if (key === 'mem') return round(data.mem && data.mem.pct)
      return round(data.gpu && data.gpu.pct)
    }

    function toneOf(pct) {
      if (pct === null) return 'idle'
      if (pct >= 90) return 'error'
      if (pct >= 75) return 'warn'
      return 'normal'
    }

    const TONE_COLOR = {
      normal: 'var(--dsw-alias-label-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-label-tertiary)',
    }

    /** Detail line for the tooltip: numbers only, words from the locale. */
    function titleFor(key, data, pct) {
      const label = t(key, key === 'mem' ? 'MEM' : key.toUpperCase())
      if (data === null) return t('waiting', 'Waiting for the first sample')
      if (pct === null) return `${label} · ${t('unavailable', 'unavailable')}`
      if (key === 'cpu') {
        const cores = data.cpu && Number.isFinite(data.cpu.cores) ? `${data.cpu.cores} ${t('cores', 'cores')}` : null
        return [`${label} ${pct}%`, cores].filter(Boolean).join(' · ')
      }
      if (key === 'mem') {
        const used = gigabytes(data.mem && data.mem.used)
        const total = gigabytes(data.mem && data.mem.total)
        const size = used === null || total === null ? null : `${used} / ${total} GB`
        return [`${label} ${pct}%`, size].filter(Boolean).join(' · ')
      }
      const gpu = data.gpu || {}
      const used = gigabytes(gpu.memUsed)
      const total = gigabytes(gpu.memTotal)
      const size = used === null || total === null ? null : `${used} / ${total} GB`
      return [`${label} ${pct}%`, gpu.name || null, size].filter(Boolean).join(' · ')
    }

    /* ------------------------------------------------------------ styles -- */

    const ROOT = {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '0 2px',
      transition: 'opacity 240ms ease',
    }
    const CELL = {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: 3,
      minWidth: 30,
    }
    const HEAD = { display: 'flex', alignItems: 'baseline', gap: 3, lineHeight: '10px' }
    const LABEL = {
      fontFamily: 'var(--dsw-font-family)',
      fontSize: 9,
      fontWeight: 600,
      letterSpacing: '0.04em',
      color: 'var(--dsw-alias-label-tertiary)',
    }
    const VALUE = {
      fontFamily: 'var(--dsw-font-family)',
      fontSize: 11,
      fontWeight: 600,
      lineHeight: '11px',
      fontVariantNumeric: 'tabular-nums',
    }
    const UNIT = { fontSize: 8, fontWeight: 500, opacity: 0.6, marginLeft: 0.5 }
    const TRACK = {
      height: 2,
      borderRadius: 1,
      background: 'var(--dsw-alias-border-l1)',
      overflow: 'hidden',
    }
    const FILL = {
      height: '100%',
      borderRadius: 1,
      transition: 'width 400ms cubic-bezier(.22,1,.36,1)',
    }

    function Cell(props) {
      const pct = props.pct
      const color = TONE_COLOR[toneOf(pct)]
      const width = pct === null ? 0 : Math.max(pct, pct > 0 ? 3 : 0)
      return h(
        'div',
        { style: CELL, title: props.title },
        h(
          'div',
          { style: HEAD },
          h('span', { style: LABEL }, props.label),
          h(
            'span',
            { style: { ...VALUE, color } },
            pct === null ? '—' : String(pct),
            pct === null ? null : h('span', { style: UNIT }, '%'),
          ),
        ),
        h('div', { style: TRACK }, h('div', { style: { ...FILL, width: `${width}%`, background: color } })),
      )
    }

    function Monitor() {
      const snapshot = useSample()
      const data = snapshot.data
      const cpu = percentOf(data, 'cpu')
      const gpu = percentOf(data, 'gpu')
      const mem = percentOf(data, 'mem')
      const empty = data === null && snapshot.status === 'error'
      const fallbackTitle = empty ? t('offline', 'Host sampler unreachable') : t('waiting', 'Waiting for the first sample')

      return h(
        'div',
        {
          role: 'group',
          'aria-label': t('title', 'System load'),
          style: { ...ROOT, opacity: empty ? 0.5 : 1 },
        },
        h(Cell, { label: t('cpu', 'CPU'), pct: cpu, title: data === null ? fallbackTitle : titleFor('cpu', data, cpu) }),
        h(Cell, { label: t('gpu', 'GPU'), pct: gpu, title: data === null ? fallbackTitle : titleFor('gpu', data, gpu) }),
        h(Cell, { label: t('mem', 'MEM'), pct: mem, title: data === null ? fallbackTitle : titleFor('mem', data, mem) }),
      )
    }

    /* ------------------------------------------------------------- plugin -- */

    return {
      inject: ['slots'],
      apply(ctx) {
        // `locale` is optional: the labels already fall back to plain text, so a
        // composition without the service keeps the widget readable.
        const locale = ctx.get('locale')
        if (locale !== undefined) {
          translate = locale.bind(NS)
          ctx.effect(() => {
            const disposers = []
            for (const [language, dict] of Object.entries(PACKS)) {
              try {
                disposers.push(locale.register(NS, language, dict))
              } catch {
                /* this catalog rejects the tag: keep the other packs */
              }
            }
            return () => {
              for (const dispose of disposers) {
                try {
                  dispose()
                } catch {
                  /* already gone */
                }
              }
            }
          })
        }

        ctx.effect(() => () => store.halt())

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'dsh-sysload:stats',
            order: 5,
            label: () => t('title', 'System load'),
          },
          Monitor,
        ))
      },
    }
  },
})
