#!/usr/bin/env bun

import * as core from "@actions/core";
import { retryWithBackoff } from "../utils/retry";
import { TokenManager } from "../daemon/token-manager";
import { DaemonController } from "../daemon/daemon-controller";

async function getOidcToken(): Promise<string> {
  try {
    const oidcToken = await core.getIDToken("claude-code-github-action");

    return oidcToken;
  } catch (error) {
    console.error("Failed to get OIDC token:", error);
    throw new Error(
      "Could not fetch an OIDC token. Did you remember to add `id-token: write` to your workflow permissions?",
    );
  }
}

async function exchangeForAppToken(oidcToken: string): Promise<string> {
  const response = await fetch(
    "https://api.anthropic.com/api/github/github-app-token-exchange",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
      },
    },
  );

  if (!response.ok) {
    const responseJson = (await response.json()) as {
      error?: {
        message?: string;
        details?: {
          error_code?: string;
        };
      };
      type?: string;
      message?: string;
    };

    // Check for specific workflow validation error codes that should skip the action
    const errorCode = responseJson.error?.details?.error_code;

    if (errorCode === "workflow_not_found_on_default_branch") {
      const message =
        responseJson.message ??
        responseJson.error?.message ??
        "Workflow validation failed";
      core.warning(`Skipping action due to workflow validation: ${message}`);
      console.log(
        "Action skipped due to workflow validation error. This is expected when adding Claude Code workflows to new repositories or on PRs with workflow changes. If you're seeing this, your workflow will begin working once you merge your PR.",
      );
      core.setOutput("skipped_due_to_workflow_validation_mismatch", "true");
      process.exit(0);
    }

    console.error(
      `App token exchange failed: ${response.status} ${response.statusText} - ${responseJson?.error?.message ?? "Unknown error"}`,
    );
    throw new Error(`${responseJson?.error?.message ?? "Unknown error"}`);
  }

  const appTokenData = (await response.json()) as {
    token?: string;
    app_token?: string;
  };
  const appToken = appTokenData.token || appTokenData.app_token;

  if (!appToken) {
    throw new Error("App token not found in response");
  }

  return appToken;
}

async function setupGitHubAppAuth(): Promise<{
  token: string;
  daemonController?: DaemonController;
}> {
  const appId = process.env.APP_ID;
  const appPrivateKey = process.env.APP_PRIVATE_KEY;

  if (!appId || !appPrivateKey) {
    throw new Error(
      "APP_ID and APP_PRIVATE_KEY environment variables are required for GitHub App authentication",
    );
  }

  // Parse repository information
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY environment variable not found");
  }

  const [repositoryOwner, repositoryName] = repository.split("/");
  if (!repositoryOwner || !repositoryName) {
    throw new Error(`Invalid repository format: ${repository}`);
  }

  console.log(
    `Setting up GitHub App authentication for ${repositoryOwner}/${repositoryName}...`,
  );

  // Create token manager and get initial token
  const tokenManager = new TokenManager({
    appId,
    privateKey: appPrivateKey,
    repositoryOwner,
    repositoryName,
  });

  // Get installation ID first
  await tokenManager.getInstallationId();

  // Get initial token
  const initialToken = await tokenManager.getToken();
  console.log("Initial GitHub App token obtained successfully");

  // Set up daemon controller for token refresh
  const daemonController = new DaemonController({
    appId,
    privateKey: appPrivateKey,
    repositoryOwner,
    repositoryName,
    refreshIntervalMinutes: 30,
    maxRuntimeHours: 6,
  });

  // Start the daemon
  await daemonController.startDaemon();
  console.log("GitHub App token refresh daemon started");

  return {
    token: initialToken.token,
    daemonController,
  };
}

export async function setupGitHubToken(): Promise<{
  token: string;
  daemonController?: DaemonController;
}> {
  try {
    // Priority 1: Check if GitHub token was provided as override
    const providedToken = process.env.OVERRIDE_GITHUB_TOKEN;
    if (providedToken) {
      console.log("Using provided GITHUB_TOKEN for authentication");
      core.setOutput("GITHUB_TOKEN", providedToken);
      return { token: providedToken };
    }

    // Priority 2: Check if GitHub App credentials are provided
    const appId = process.env.APP_ID;
    const appPrivateKey = process.env.APP_PRIVATE_KEY;

    if (appId && appPrivateKey) {
      console.log("Using GitHub App authentication with token refresh daemon");
      const result = await setupGitHubAppAuth();
      core.setOutput("GITHUB_TOKEN", result.token);
      core.setOutput("DAEMON_ACTIVE", "true");
      return result;
    }

    // Priority 3: Fall back to OIDC token exchange (existing behavior)
    console.log("Requesting OIDC token...");
    const oidcToken = await retryWithBackoff(() => getOidcToken());
    console.log("OIDC token successfully obtained");

    console.log("Exchanging OIDC token for app token...");
    const appToken = await retryWithBackoff(() =>
      exchangeForAppToken(oidcToken),
    );
    console.log("App token successfully obtained");

    console.log("Using GITHUB_TOKEN from OIDC");
    core.setOutput("GITHUB_TOKEN", appToken);
    return { token: appToken };
  } catch (error) {
    // Only set failed if we get here - workflow validation errors will exit(0) before this
    core.setFailed(
      `Failed to setup GitHub token: ${error}\n\nAuthentication methods (in priority order):\n1. Provide github_token input\n2. Provide app_id and app_private_key inputs (enables 6-hour runtime)\n3. Use default OIDC authentication (requires id-token: write permission)`,
    );
    process.exit(1);
  }
}
