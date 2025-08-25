#!/usr/bin/env bun

import { TokenManager } from "./token-manager";
import type { TokenManagerConfig } from "./token-manager";
import * as fs from "fs";
import { spawn } from "child_process";

interface DaemonConfig extends TokenManagerConfig {
  refreshIntervalMinutes: number;
  maxRuntimeHours: number;
}

interface DaemonStatus {
  pid: number;
  startTime: string;
  status: "running" | "stopped" | "error";
  lastRefresh?: string;
  nextRefresh?: string;
  refreshCount: number;
}

class TokenRefreshDaemon {
  private config: DaemonConfig;
  private tokenManager: TokenManager;
  private statusFile: string;
  private logFile: string;
  private refreshTimer: Timer | null = null;
  private maxRuntimeTimer: Timer | null = null;
  private refreshCount = 0;

  constructor() {
    // Get configuration from environment
    const configStr = process.env.DAEMON_CONFIG;
    if (!configStr) {
      throw new Error("DAEMON_CONFIG environment variable not set");
    }

    this.config = JSON.parse(configStr);
    this.statusFile =
      process.env.DAEMON_STATUS_FILE || "/tmp/claude-daemon-status.json";
    this.logFile = process.env.DAEMON_LOG_FILE || "/tmp/claude-daemon.log";

    this.tokenManager = new TokenManager(this.config);

    this.log("Token refresh daemon starting...");
    this.log(
      `Configuration: ${JSON.stringify({
        appId: this.config.appId,
        repositoryOwner: this.config.repositoryOwner,
        repositoryName: this.config.repositoryName,
        refreshIntervalMinutes: this.config.refreshIntervalMinutes,
        maxRuntimeHours: this.config.maxRuntimeHours,
      })}`,
    );
  }

  /**
   * Start the daemon
   */
  async start(): Promise<void> {
    try {
      this.log("Starting token refresh daemon");

      // Set up signal handlers for graceful shutdown
      process.on("SIGTERM", () => this.shutdown("SIGTERM"));
      process.on("SIGINT", () => this.shutdown("SIGINT"));
      process.on("uncaughtException", (error) => {
        this.log(`Uncaught exception: ${error}`);
        this.updateStatus({ status: "error" });
        process.exit(1);
      });

      // Initial status update
      this.updateStatus({
        pid: process.pid,
        startTime: new Date().toISOString(),
        status: "running",
        refreshCount: 0,
      });

      // Perform initial token refresh and auth setup
      await this.refreshTokenAndAuth();

      // Set up periodic refresh
      this.scheduleNextRefresh();

      // Set up maximum runtime timer
      const maxRuntimeMs = this.config.maxRuntimeHours * 60 * 60 * 1000;
      this.maxRuntimeTimer = setTimeout(() => {
        this.log(
          `Maximum runtime of ${this.config.maxRuntimeHours} hours reached, shutting down`,
        );
        this.shutdown("MAX_RUNTIME");
      }, maxRuntimeMs);

      this.log(
        `Daemon started successfully. Will refresh every ${this.config.refreshIntervalMinutes} minutes for max ${this.config.maxRuntimeHours} hours`,
      );

      // Keep the process alive
      setInterval(() => {
        // Health check - just keep alive
      }, 10000);
    } catch (error) {
      this.log(`Failed to start daemon: ${error}`);
      this.updateStatus({ status: "error" });
      process.exit(1);
    }
  }

  /**
   * Refresh the GitHub token and update git/gh auth
   */
  private async refreshTokenAndAuth(): Promise<void> {
    try {
      this.log("Refreshing GitHub App token...");

      const tokenInfo = await this.tokenManager.getToken();
      this.log(`Successfully obtained token (expires: ${tokenInfo.expiresAt})`);

      // Update git configuration
      await this.updateGitAuth(tokenInfo.token);

      // Update GitHub CLI authentication
      await this.updateGhAuth(tokenInfo.token);

      this.refreshCount++;
      const nextRefresh = new Date(
        Date.now() + this.config.refreshIntervalMinutes * 60 * 1000,
      ).toISOString();

      this.updateStatus({
        lastRefresh: new Date().toISOString(),
        nextRefresh,
        refreshCount: this.refreshCount,
      });

      this.log(
        `Token refresh completed successfully (refresh #${this.refreshCount}). Next refresh: ${nextRefresh}`,
      );
    } catch (error) {
      this.log(`Token refresh failed: ${error}`);
      this.updateStatus({ status: "error" });
      throw error;
    }
  }

  /**
   * Update git authentication with new token
   */
  private async updateGitAuth(token: string): Promise<void> {
    try {
      this.log("Updating git authentication...");

      // Set git credentials
      await this.runCommand("git", [
        "config",
        "--global",
        "url.https://x-access-token:" + token + "@github.com/.insteadOf",
        "https://github.com/",
      ]);

      this.log("Git authentication updated successfully");
    } catch (error) {
      this.log(`Failed to update git authentication: ${error}`);
      throw error;
    }
  }

  /**
   * Update GitHub CLI authentication with new token
   */
  private async updateGhAuth(token: string): Promise<void> {
    try {
      this.log("Updating GitHub CLI authentication...");

      // Login with token
      const loginProcess = spawn("gh", ["auth", "login", "--with-token"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (loginProcess.stdin) {
        loginProcess.stdin.write(token);
        loginProcess.stdin.end();
      }

      await new Promise((resolve, reject) => {
        loginProcess.on("close", (code) => {
          if (code === 0) {
            resolve(void 0);
          } else {
            reject(new Error(`gh auth login failed with code ${code}`));
          }
        });
      });

      // Setup git integration
      await this.runCommand("gh", ["auth", "setup-git"]);

      this.log("GitHub CLI authentication updated successfully");
    } catch (error) {
      this.log(`Failed to update GitHub CLI authentication: ${error}`);
      throw error;
    }
  }

  /**
   * Schedule the next token refresh
   */
  private scheduleNextRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    const intervalMs = this.config.refreshIntervalMinutes * 60 * 1000;
    this.refreshTimer = setTimeout(async () => {
      try {
        await this.refreshTokenAndAuth();
        this.scheduleNextRefresh(); // Schedule next refresh
      } catch (error) {
        this.log(`Scheduled refresh failed: ${error}`);
        // Continue trying - don't exit on refresh failures
        this.scheduleNextRefresh();
      }
    }, intervalMs);
  }

  /**
   * Shutdown the daemon gracefully
   */
  private shutdown(reason: string): void {
    this.log(`Shutting down daemon (reason: ${reason})`);

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    if (this.maxRuntimeTimer) {
      clearTimeout(this.maxRuntimeTimer);
    }

    this.updateStatus({ status: "stopped" });
    this.log("Daemon shutdown complete");
    process.exit(0);
  }

  /**
   * Update daemon status file
   */
  private updateStatus(updates: Partial<DaemonStatus>): void {
    try {
      let currentStatus: DaemonStatus;

      if (fs.existsSync(this.statusFile)) {
        const statusData = fs.readFileSync(this.statusFile, "utf8");
        currentStatus = JSON.parse(statusData);
      } else {
        currentStatus = {
          pid: process.pid,
          startTime: new Date().toISOString(),
          status: "running",
          refreshCount: 0,
        };
      }

      const newStatus = { ...currentStatus, ...updates };
      fs.writeFileSync(this.statusFile, JSON.stringify(newStatus, null, 2));
    } catch (error) {
      this.log(`Failed to update status: ${error}`);
    }
  }

  /**
   * Log message with timestamp
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;

    // Log to console
    console.log(`[DAEMON] ${message}`);

    // Log to file
    try {
      fs.appendFileSync(this.logFile, logEntry);
    } catch {
      // Ignore file write errors
    }
  }

  /**
   * Run a command and return a promise
   */
  private async runCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const process = spawn(command, args, { stdio: "pipe" });

      let stdout = "";
      let stderr = "";

      if (process.stdout) {
        process.stdout.on("data", (data) => {
          stdout += data.toString();
        });
      }

      if (process.stderr) {
        process.stderr.on("data", (data) => {
          stderr += data.toString();
        });
      }

      process.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `Command ${command} ${args.join(" ")} failed: ${stderr || stdout}`,
            ),
          );
        }
      });
    });
  }
}

// Start the daemon if this script is run directly
if (import.meta.main) {
  const daemon = new TokenRefreshDaemon();
  daemon.start().catch((error) => {
    console.error("Daemon failed to start:", error);
    process.exit(1);
  });
}
