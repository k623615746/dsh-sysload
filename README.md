# dsh-sysload

Live CPU, GPU and memory load for the DeepSeek Harness Web UI — three small cells in the Session header, where the session utilities already live, instead of another floating window.

Each cell is a label, a percentage and a 2 px bar. The bar and the number take the warning colour at 75 % and the error colour at 90 %. Hovering a cell shows the detail: core count, memory in GiB, VRAM, the adapter name, and which strategy produced the GPU reading.

```
CPU 37%   GPU 23%   MEM 77%
▬▬▬▬▬▬    ▬▬▬▬     ▬▬▬▬▬▬▬▬▬▬▬▬
```

## How it works

A plugin is two halves. The Host half samples the machine and serves one JSON document; the Client half polls it and renders.

| Reading | Source |
| --- | --- |
| CPU | `os.cpus()` — idle/total delta between two polls, so the number is load *since the last poll*; the very first sample of a process falls back to the average since boot |
| Memory | `os.totalmem()` and `os.freemem()` |
| GPU | `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,name`; with several adapters the busiest one drives the bar and VRAM is summed. Without NVIDIA, Windows falls back to the `GPU Engine(*)\Utilization Percentage` performance counter set (slow: ~7 s per reading, so it is bounded at 25 s and parked for five minutes after a failure). Neither path available → the cell shows `—` |

A GPU reading younger than 1.8 s is reused, so overlapping polls never spawn two probes. The route takes no input: it reads no query string, no body and no headers, so nothing a caller sends can reach the commands above.

Polling runs at 2 s in a visible tab, drops to 15 s when the tab is hidden, and backs off exponentially to a 20 s ceiling while requests fail — a closed tab stops polling entirely. The Client requests the route with a path *relative* to the page, so the widget keeps working behind a reverse-proxy prefix and inside the desktop shell.

## Requirements

- DeepSeek Harness with the `webServer` service (the Web UI). Without that service the plugin registers nothing and stays inert.
- CPU and memory: any platform Node runs on.
- GPU: `nvidia-smi` on PATH (Linux and Windows), or Windows performance counters for Intel/AMD adapters. macOS reports `—`.

## Install

```sh
dsh plugin add github:k623615746/dsh-sysload
```

From a local checkout instead:

```sh
dsh plugin add file:/absolute/path/to/dsh-sysload
```

The widget appears in the Session header on the next page load; no restart.

## Endpoint

```sh
curl http://127.0.0.1:56142/dsh-sysload/stats
```

```json
{
  "at": 1763000000000,
  "cpu": { "pct": 35.5, "cores": 20 },
  "mem": { "pct": 77.1, "used": 12947177472, "total": 16962281472 },
  "gpu": {
    "pct": 23,
    "memUsed": 1509949440,
    "memTotal": 8589934592,
    "name": "NVIDIA GeForce RTX 3070 Laptop GPU",
    "source": "nvidia-smi"
  }
}
```

`source` is one of `nvidia-smi`, `perf-counter` or `unavailable`; any field the machine cannot supply is `null`. Only `GET` and `HEAD` are answered (other methods get `405` with `allow: GET, HEAD`), and every response is `cache-control: no-store`.

## Privacy

Reads local kernel counters and, when a GPU exists, spawns a local CLI. No network egress, no telemetry, no files written.

## License

MIT — see [LICENSE](LICENSE).

---

# 中文

在 DeepSeek Harness 会话顶栏显示本机的 CPU、GPU 与内存占用率：三个小格，每格一行标签、一个百分比和一条 2 px 细条，75 % 变告警色、90 % 变错误色；悬停可看核数、内存 GiB、显存、显卡型号，以及 GPU 读数来自哪条采集路径。

- **CPU**：`os.cpus()` 两次轮询之间的 idle/total 差值，即「距上次轮询以来的负载」；进程内第一次采样退回开机以来的平均值。
- **内存**：`os.totalmem()` 与 `os.freemem()`。
- **GPU**：优先 `nvidia-smi`（多张卡时取最忙的一张驱动进度条、显存求和）；没有 NVIDIA 时，Windows 退回 `GPU Engine(*)\Utilization Percentage` 性能计数器（一次约 7 秒，因此限时 25 秒、失败后停用五分钟）；两条路都取不到就显示 `—`。

轮询在前台 2 秒一次，标签页切到后台降为 15 秒，请求失败时指数退避到 20 秒上限；关闭标签页即停止。前端用**相对路径**请求，放在反向代理前缀下或桌面壳里都不会打歪。

安装：

```sh
dsh plugin add github:k623615746/dsh-sysload
```

数据接口 `GET /dsh-sysload/stats` 返回一份 JSON，只接受 `GET`/`HEAD`，`cache-control: no-store`；插件只读本机计数器并调用本机命令行工具，不上报任何数据。

MIT 许可。
