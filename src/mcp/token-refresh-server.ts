#!/usr/bin/env bun

/**
 * MCP Server for Token Refresh Notifications
 *
 * This server provides read-only access to token refresh daemon status and logs,
 * allowing Claude to monitor authentication health and debug issues.
 *
 * IMPORTANT: This server does NOT provide tools for Claude to trigger refreshes.
 * All token refresh operations are automated by the daemon.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";

interface DaemonStatus {
  pid: number;
  startTime: string;
  status: "running" | "stopped" | "error";
  lastRefresh?: string;
  nextRefresh?: string;
  refreshCount: number;
}

class TokenRefreshServer {
  private server: Server;
  private statusFile: string;
  private logFile: string;

  constructor() {
    this.server = new Server(
      {
        name: "github-token-refresh-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    const tempDir = process.env.RUNNER_TEMP || "/tmp";
    this.statusFile = path.join(tempDir, "claude-daemon-status.json");
    this.logFile = path.join(tempDir, "claude-daemon.log");

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "get_token_refresh_status",
            description:
              "Get the current status of the GitHub token refresh daemon",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: "get_token_refresh_logs",
            description:
              "Get recent logs from the token refresh daemon for debugging",
            inputSchema: {
              type: "object",
              properties: {
                tail_lines: {
                  type: "number",
                  description:
                    "Number of recent log lines to retrieve (default: 50)",
                  minimum: 1,
                  maximum: 200,
                },
              },
              additionalProperties: false,
            },
          },
          {
            name: "check_daemon_health",
            description: "Check if the daemon is running and healthy",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      switch (request.params.name) {
        case "get_token_refresh_status":
          return await this.getTokenRefreshStatus();

        case "get_token_refresh_logs":
          const tailLines = (request.params.arguments as any)?.tail_lines || 50;
          return await this.getTokenRefreshLogs(tailLines);

        case "check_daemon_health":
          return await this.checkDaemonHealth();

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`,
          );
      }
    });
  }

  private async getTokenRefreshStatus() {
    try {
      if (!fs.existsSync(this.statusFile)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Token refresh daemon status file not found. Daemon may not be running or may not have started yet.",
            },
          ],
        };
      }

      const statusData = fs.readFileSync(this.statusFile, "utf8");
      const status: DaemonStatus = JSON.parse(statusData);

      let statusText = `**Token Refresh Daemon Status**

**PID:** ${status.pid}
**Status:** ${status.status}
**Started:** ${status.startTime}
**Refresh Count:** ${status.refreshCount}`;

      if (status.lastRefresh) {
        statusText += `\n**Last Refresh:** ${status.lastRefresh}`;
      }

      if (status.nextRefresh) {
        statusText += `\n**Next Refresh:** ${status.nextRefresh}`;
      }

      if (status.status === "running") {
        const isHealthy = this.isProcessRunning(status.pid);
        statusText += `\n**Process Health:** ${isHealthy ? "✅ Healthy" : "❌ Process not found"}`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: statusText,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error reading daemon status: ${error}`,
          },
        ],
      };
    }
  }

  private async getTokenRefreshLogs(tailLines: number) {
    try {
      if (!fs.existsSync(this.logFile)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Token refresh daemon log file not found. Daemon may not have started logging yet.",
            },
          ],
        };
      }

      const logContent = fs.readFileSync(this.logFile, "utf8");
      const lines = logContent.split("\n");
      const recentLines = lines
        .slice(-tailLines)
        .filter((line) => line.trim())
        .join("\n");

      const logText = `**Token Refresh Daemon Logs (last ${tailLines} lines)**

\`\`\`
${recentLines || "No recent logs available"}
\`\`\``;

      return {
        content: [
          {
            type: "text" as const,
            text: logText,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error reading daemon logs: ${error}`,
          },
        ],
      };
    }
  }

  private async checkDaemonHealth() {
    try {
      if (!fs.existsSync(this.statusFile)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "❌ **Daemon Health: Unknown** - Status file not found",
            },
          ],
        };
      }

      const statusData = fs.readFileSync(this.statusFile, "utf8");
      const status: DaemonStatus = JSON.parse(statusData);

      let healthText: string;
      const isProcessRunning = this.isProcessRunning(status.pid);

      if (status.status === "running" && isProcessRunning) {
        // Check if daemon is refreshing on schedule
        const now = Date.now();
        const lastRefresh = status.lastRefresh
          ? new Date(status.lastRefresh).getTime()
          : 0;
        const timeSinceRefresh = now - lastRefresh;
        const refreshIntervalMs = 30 * 60 * 1000; // 30 minutes

        if (timeSinceRefresh > refreshIntervalMs * 1.5) {
          // 45 minutes grace period
          healthText = `⚠️  **Daemon Health: Warning** 
- Process is running but last refresh was ${Math.round(timeSinceRefresh / (60 * 1000))} minutes ago
- Expected refresh interval: 30 minutes
- This may indicate network issues or API problems`;
        } else {
          healthText = `✅ **Daemon Health: Healthy**
- Process is running (PID: ${status.pid})
- Last refresh: ${status.lastRefresh || "Not yet"}
- Refresh count: ${status.refreshCount}`;
        }
      } else if (status.status === "error") {
        healthText = `❌ **Daemon Health: Error**
- Daemon reported error status
- Check logs for details`;
      } else if (status.status === "stopped") {
        healthText = `❌ **Daemon Health: Stopped**
- Daemon has stopped running
- This may be normal if the action is completing`;
      } else if (!isProcessRunning) {
        healthText = `❌ **Daemon Health: Dead Process**
- Status file indicates running but process ${status.pid} not found
- Daemon may have crashed unexpectedly`;
      } else {
        healthText = `❓ **Daemon Health: Unknown**
- Unexpected status: ${status.status}`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: healthText,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ **Daemon Health: Error** - Failed to check health: ${error}`,
          },
        ],
      };
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

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("GitHub Token Refresh MCP server running on stdio");
  }
}

// Start the server if this script is run directly
if (import.meta.main) {
  const server = new TokenRefreshServer();
  server.run().catch(console.error);
}
