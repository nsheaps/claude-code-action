#!/usr/bin/env bun

import { createAppAuth } from "@octokit/auth-app";
import * as core from "@actions/core";

export interface TokenManagerConfig {
  appId: string;
  privateKey: string;
  installationId?: number;
  repositoryOwner: string;
  repositoryName: string;
}

export interface TokenInfo {
  token: string;
  expiresAt: string;
  installationId: number;
}

export class TokenManager {
  private config: TokenManagerConfig;
  private auth: ReturnType<typeof createAppAuth>;
  private currentToken: TokenInfo | null = null;

  constructor(config: TokenManagerConfig) {
    this.config = config;
    this.auth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
    });
  }

  /**
   * Get a fresh GitHub App installation token
   */
  async getToken(): Promise<TokenInfo> {
    try {
      core.info("Requesting new GitHub App installation token...");

      const authResult = await this.auth({
        type: "installation",
        repositoryNames: [this.config.repositoryName],
      });

      if (!("token" in authResult) || !authResult.token) {
        throw new Error("Failed to get installation token from GitHub App");
      }

      const tokenInfo: TokenInfo = {
        token: authResult.token,
        expiresAt:
          authResult.expiresAt ||
          new Date(Date.now() + 60 * 60 * 1000).toISOString(), // Default 1hr
        installationId: authResult.installationId || 0,
      };

      this.currentToken = tokenInfo;
      core.info(
        `Successfully obtained GitHub App token (expires: ${tokenInfo.expiresAt})`,
      );

      return tokenInfo;
    } catch (error) {
      core.error(`Failed to obtain GitHub App token: ${error}`);
      throw error;
    }
  }

  /**
   * Check if the current token needs refresh (expires within 5 minutes)
   */
  needsRefresh(): boolean {
    if (!this.currentToken) {
      return true;
    }

    const expiresAt = new Date(this.currentToken.expiresAt).getTime();
    const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;

    return expiresAt <= fiveMinutesFromNow;
  }

  /**
   * Get current token if valid, or refresh if needed
   */
  async getCurrentToken(): Promise<TokenInfo> {
    if (this.needsRefresh()) {
      return await this.getToken();
    }

    if (!this.currentToken) {
      return await this.getToken();
    }

    return this.currentToken;
  }

  /**
   * Get the installation ID for this repository
   */
  async getInstallationId(): Promise<number> {
    try {
      if (this.config.installationId) {
        return this.config.installationId;
      }

      // Get installation ID from GitHub API
      const appAuth = await this.auth({ type: "app" });

      const response = await fetch(
        `https://api.github.com/repos/${this.config.repositoryOwner}/${this.config.repositoryName}/installation`,
        {
          headers: {
            Authorization: `Bearer ${appAuth.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );

      if (!response.ok) {
        throw new Error(
          `Failed to get installation ID: ${response.statusText}`,
        );
      }

      const installation = (await response.json()) as { id: number };
      this.config.installationId = installation.id;

      core.info(`Found installation ID: ${installation.id}`);
      return installation.id;
    } catch (error) {
      core.error(`Failed to get installation ID: ${error}`);
      throw error;
    }
  }
}
