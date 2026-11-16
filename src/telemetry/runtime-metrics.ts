import type { Meter, ObservableResult } from '@opentelemetry/api';

/**
 * Runtime (process-level) gauges: memory RSS/heap and event-loop delay.
 * Collected by the MeterProvider on every export cycle — no timers of our
 * own for the memory gauges, so nothing to clean up there; the event-loop
 * monitor's timer is unref'd and disabled on shutdown (see below).
 */

let loopMonitor: LoopMonitor | null = null;

/**
 * Previous tick's CPU reading for the utilization gauge — (user+system) in
 * microseconds over the wall clock between export ticks. First tick has no
 * window and observes nothing (no invented zero for a stale denominator).
 */
let lastCpu: { usageUs: number; wallMs: number } | null = null;

export function initRuntimeMetrics(meter: Meter): void {
  meter
    .createObservableGauge('process.memory.rss', {
      description: 'Process resident set size',
      unit: 'By',
    })
    .addCallback((obs: ObservableResult) => {
      obs.observe(process.memoryUsage().rss);
    });

  meter
    .createObservableGauge('process.memory.heap_used', {
      description: 'V8 heap used',
      unit: 'By',
    })
    .addCallback((obs: ObservableResult) => {
      obs.observe(process.memoryUsage().heapUsed);
    });

  // CPU saturation is the third golden-signal gauge: on the 0.5-vCPU Render
  // instance a sustained value near 1.0 is the "why is everything slow"
  // answer. Clamped at 1.0 (the process is single-threaded; a >1 reading
  // would be a wall-clock rounding artefact, not real saturation).
  meter
    .createObservableGauge('process.cpu.utilization', {
      description: 'CPU time per wall-clock second since the previous export',
      unit: '1',
    })
    .addCallback((obs: ObservableResult) => {
      if (typeof process.cpuUsage !== 'function') return;
      const usage = process.cpuUsage();
      const wallMs = Date.now();
      const prev = lastCpu;
      lastCpu = { usageUs: usage.user + usage.system, wallMs };
      if (!prev) return;
      const wallDeltaMs = Math.max(1, wallMs - prev.wallMs);
      const utilization =
        (usage.user + usage.system - prev.usageUs) / (wallDeltaMs * 1000);
      if (Number.isFinite(utilization)) {
        obs.observe(Math.min(Math.max(utilization, 0), 1));
      }
    });

  // Boot age — the simplest "did it stay up" series; restarts reset it to
  // zero, so a sawtooth here is the deploy/restart picture at a glance.
  meter
    .createObservableGauge('process.uptime', {
      description: 'Seconds since the process started',
      unit: 's',
    })
    .addCallback((obs: ObservableResult) => {
      obs.observe(process.uptime());
    });

  // monitorEventLoopDelay is unavailable in some runtimes — degrade quietly.
  loopMonitor = tryCreateLoopMonitor();
  if (loopMonitor) {
    loopMonitor.enable();
    // Keep the histogram timer from holding the process open on shutdown.
    loopMonitor.unref?.();
    meter
      .createObservableGauge('node.eventloop.delay', {
        description: 'Mean event loop delay since the previous export',
        unit: 'ms',
      })
      .addCallback((obs: ObservableResult) => {
        const monitor = loopMonitor;
        if (!monitor) return;
        const meanMs = monitor.mean / 1e6;
        // A window with zero samples reports NaN — skip instead of
        // failing the collection cycle (obs.observe(NaN) throws).
        if (Number.isFinite(meanMs)) {
          obs.observe(meanMs);
          monitor.reset();
        }
      });
  }
}

/** Stops the event-loop monitor so shutdown is clean. Idempotent. */
export function shutdownRuntimeMetrics(): void {
  loopMonitor?.disable();
  loopMonitor = null;
}

interface LoopMonitor {
  enable(): void;
  reset(): void;
  /** Optional: Bun's IntervalHistogram typing doesn't declare unref. */
  unref?(): void;
  disable(): void;
  readonly mean: number;
}

function tryCreateLoopMonitor(): LoopMonitor | null {
  try {
    const { monitorEventLoopDelay } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('perf_hooks') as typeof import('perf_hooks');
    return monitorEventLoopDelay({ resolution: 10 });
  } catch {
    return null;
  }
}
