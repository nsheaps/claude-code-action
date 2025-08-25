#!/usr/bin/env bun

import { spawn, ChildProcess } from "child_process";
import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import type { TokenManagerConfig } from "./token-manager";

export interface DaemonConfig extends TokenManagerConfig {
  refreshIntervalMinutes?: number;
  maxRuntimeHours?: number;
  logFile?: string;
}

export interface DaemonStatus {
  pid: number;
  startTime: string;
  status: "running" | "stopped" | "error";
  lastRefresh?: string;
  nextRefresh?: string;
  refreshCount: number;
}

export class DaemonController {
  private config: DaemonConfig;
  private daemonProcess: ChildProcess | null = null;
  private statusFile: string;
  private pidFile: string;
  private logFile: string;

  constructor(config: DaemonConfig) {
    this.config = {
      refreshIntervalMinutes: 30,
      maxRuntimeHours: 6,
      ...config,
    };

    const tempDir = process.env.RUNNER_TEMP || "/tmp";
    this.statusFile = path.join(tempDir, "claude-daemon-status.json");
    this.pidFile = path.join(tempDir, "claude-daemon.pid");
    this.logFile = config.logFile || path.join(tempDir, "claude-daemon.log");
  }

  /**
   * Start the token refresh daemon
   */
  async startDaemon(): Promise<DaemonStatus> {
    try {
      core.info("Starting GitHub App token refresh daemon...");

      // Clean up any existing daemon
      await this.stopDaemon();

      const daemonScript = path.join(__dirname, "token-refresh-daemon.ts");

      // Spawn the daemon process
      this.daemonProcess = spawn("bun", ["run", daemonScript], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          DAEMON_CONFIG: JSON.stringify(this.config),
          DAEMON_STATUS_FILE: this.statusFile,
          DAEMON_LOG_FILE: this.logFile,
        },
      });

      if (!this.daemonProcess.pid) {
        throw new Error("Failed to start daemon process");
      }

      // Write PID file
      fs.writeFileSync(this.pidFile, this.daemonProcess.pid.toString());

      // Set up logging
      if (this.daemonProcess.stdout) {
        this.daemonProcess.stdout.on("data", (data) => {
          fs.appendFileSync(this.logFile, `[STDOUT] ${data}`);
        });
      }

      if (this.daemonProcess.stderr) {
        this.daemonProcess.stderr.on("data", (data) => {
          fs.appendFileSync(this.logFile, `[STDERR] ${data}`);
        });
      }

      // Handle daemon exit
      this.daemonProcess.on("exit", (code, signal) => {
        core.info(`Daemon process exited with code ${code}, signal ${signal}`);
        this.updateStatus({ status: "stopped" });
      });

      // Detach the process so it can run independently
      this.daemonProcess.unref();

      const initialStatus: DaemonStatus = {
        pid: this.daemonProcess.pid,
        startTime: new Date().toISOString(),
        status: "running",
        refreshCount: 0,
      };

      this.updateStatus(initialStatus);
      core.info(`Daemon started successfully (PID: ${this.daemonProcess.pid})`);

      return initialStatus;
    } catch (error) {
      core.error(`Failed to start daemon: ${error}`);
      throw error;
    }
  }

  /**
   * Stop the daemon process
   */
  async stopDaemon(): Promise<void> {
    try {
      // Try to read existing PID
      let pid: number | null = null;

      if (fs.existsSync(this.pidFile)) {
        const pidStr = fs.readFileSync(this.pidFile, "utf8").trim();
        pid = parseInt(pidStr, 10);
      }

      if (this.daemonProcess && this.daemonProcess.pid) {
        pid = this.daemonProcess.pid;
      }

      if (pid && this.isProcessRunning(pid)) {
        core.info(`Stopping daemon process (PID: ${pid})...`);
        process.kill(pid, "SIGTERM");

        // Wait a moment for graceful shutdown
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Force kill if still running
        if (this.isProcessRunning(pid)) {
          core.warning(`Daemon did not stop gracefully, force killing...`);
          process.kill(pid, "SIGKILL");
        }
      }

      // Clean up files
      [this.pidFile, this.statusFile].forEach((file) => {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      });

      this.daemonProcess = null;
      core.info("Daemon stopped successfully");
    } catch (error) {
      core.warning(`Error stopping daemon: ${error}`);
    }
  }

  /**
   * Get current daemon status
   */
  getStatus(): DaemonStatus | null {
    try {
      if (!fs.existsSync(this.statusFile)) {
        return null;
      }

      const statusData = fs.readFileSync(this.statusFile, "utf8");
      return JSON.parse(statusData) as DaemonStatus;
    } catch (error) {
      core.warning(`Failed to read daemon status: ${error}`);
      return null;
    }
  }

  /**
   * Check if daemon is running and healthy
   */
  isHealthy(): boolean {
    const status = this.getStatus();
    if (!status || status.status !== "running") {
      return false;
    }

    return this.isProcessRunning(status.pid);
  }

  /**
   * Get daemon logs
   */
  getLogs(tailLines: number = 50): string {
    try {
      if (!fs.existsSync(this.logFile)) {
        return "No logs available";
      }

      const logContent = fs.readFileSync(this.logFile, "utf8");
      const lines = logContent.split("\n");

      return lines
        .slice(-tailLines)
        .filter((line) => line.trim())
        .join("\n");
    } catch (error) {
      return `Error reading logs: ${error}`;
    }
  }

  private updateStatus(updates: Partial<DaemonStatus>): void {
    try {
      const currentStatus = this.getStatus() || {
        pid: 0,
        startTime: new Date().toISOString(),
        status: "stopped" as const,
        refreshCount: 0,
      };

      const newStatus = { ...currentStatus, ...updates };
      fs.writeFileSync(this.statusFile, JSON.stringify(newStatus, null, 2));
    } catch (error) {
      core.warning(`Failed to update daemon status: ${error}`);
    }
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
