"use strict";

/**
 * lib/system-info.js - zero-dependency host facts for /api/system and startup.
 *
 * The values are read from the OS on every call. Nothing here is cached:
 * memory, load and disk change while the server runs, and a stale banner is
 * worse than a slightly slower one.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function bytes(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function roundGb(value) {
  return Math.round((bytes(value) / 1024 / 1024 / 1024) * 10) / 10;
}

function diskUsage(target) {
  const probe = target || ROOT;
  try {
    if (typeof fs.statfsSync === "function") {
      const s = fs.statfsSync(probe);
      const total = bytes(s.bsize) * bytes(s.blocks);
      const free = bytes(s.bsize) * bytes(s.bavail);
      return {
        path: probe,
        total_bytes: total,
        free_bytes: free,
        used_bytes: Math.max(0, total - free),
        total_gb: roundGb(total),
        free_gb: roundGb(free),
        used_percent: total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : 0,
      };
    }
  } catch (_) {
    /* statfs is unavailable on some filesystems; report null below */
  }
  return { path: probe, total_bytes: 0, free_bytes: 0, used_bytes: 0, total_gb: 0, free_gb: 0, used_percent: 0 };
}

function cpuInfo() {
  const cpus = os.cpus() || [];
  const first = cpus[0] || {};
  return {
    model: (first.model || "unknown").trim(),
    speed_mhz: first.speed || 0,
    cores: cpus.length,
  };
}

function networkInfo() {
  const interfaces = os.networkInterfaces() || {};
  const list = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      if (!addr || addr.internal && addr.family !== "IPv4") continue;
      list.push({
        name,
        family: addr.family,
        address: addr.address,
        internal: !!addr.internal,
        mac: addr.mac || "",
      });
    }
  }
  return list;
}

function collectSystemInfo() {
  const cpu = cpuInfo();
  const totalMem = bytes(os.totalmem());
  const freeMem = bytes(os.freemem());
  return {
    hostname: os.hostname(),
    os: os.type(),
    platform: os.platform(),
    kernel: os.release(),
    arch: os.arch(),
    node: process.version,
    pid: process.pid,
    cwd: process.cwd(),
    root: ROOT,
    uptime_sec: Math.floor(os.uptime()),
    process_uptime_sec: Math.floor(process.uptime()),
    cpu,
    memory: {
      total_bytes: totalMem,
      free_bytes: freeMem,
      used_bytes: Math.max(0, totalMem - freeMem),
      total_gb: roundGb(totalMem),
      free_gb: roundGb(freeMem),
      used_percent: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10 : 0,
    },
    disk: diskUsage(ROOT),
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    network: networkInfo(),
    runtime: {
      rss_bytes: process.memoryUsage().rss,
      heap_used_bytes: process.memoryUsage().heapUsed,
    },
  };
}

function compactSystemInfo(info) {
  const i = info || collectSystemInfo();
  return {
    os: i.os,
    platform: i.platform,
    kernel: i.kernel,
    arch: i.arch,
    hostname: i.hostname,
    cpu: i.cpu.model,
    cores: i.cpu.cores,
    memory: {
      total_gb: i.memory.total_gb,
      free_gb: i.memory.free_gb,
      used_percent: i.memory.used_percent,
    },
    disk: {
      total_gb: i.disk.total_gb,
      free_gb: i.disk.free_gb,
      used_percent: i.disk.used_percent,
    },
    node: i.node,
    pid: i.pid,
    uptime_sec: i.uptime_sec,
    process_uptime_sec: i.process_uptime_sec,
    load: i.load,
  };
}

function formatBytes(value) {
  const n = bytes(value);
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + " GB";
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

function formatSummary(info) {
  const i = info || collectSystemInfo();
  return [
    i.os + " " + i.kernel + " (" + i.arch + ")",
    "host=" + i.hostname,
    "cpu=" + i.cpu.model + " x" + i.cpu.cores,
    "mem=" + i.memory.free_gb + "/" + i.memory.total_gb + " GB free",
    "disk=" + i.disk.free_gb + "/" + i.disk.total_gb + " GB free",
    "node=" + i.node,
    "load=" + i.load.join(","),
  ].join(" | ");
}

module.exports = {
  collectSystemInfo,
  compactSystemInfo,
  diskUsage,
  formatBytes,
  formatSummary,
};
