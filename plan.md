# GitHub App Token Refresh Daemon Implementation Plan

## Overview

This plan implements a background daemon that manages GitHub App authentication tokens with automatic refresh capabilities, extending the action timeout to 6 hours as requested in [this comment](https://github.com/actions/create-github-app-token/issues/121#issuecomment-2043214796).

## Current Authentication Flow Analysis

- Current system uses OIDC token exchange with Anthropic's API to get short-lived GitHub App tokens
- Tokens expire after ~1 hour, limiting action execution time
- Authentication is handled in `src/github/token.ts` with `setupGitHubToken()` function
- Action accepts `github_token` input but prioritizes OIDC flow when available

## Proposed Architecture

### 1. New Input Parameters

Add to `action.yml`:

- `app_id`: GitHub App ID (alternative to OIDC)
- `app_private_key`: GitHub App private key (alternative to OIDC)
- Ensure mutual exclusivity: either provide `github_token` OR use OIDC OR use `app_id`/`app_private_key`

### 2. Background Token Refresh Daemon

Create `src/daemon/token-refresh-daemon.ts`:

- Spawns background process that runs for up to 6 hours
- Uses GitHub App credentials to generate installation tokens directly
- Refreshes tokens every 30 minutes (before 1-hour expiration)
- Automatically runs `gh auth login --with-token` and `gh auth setup-git` after each refresh
- Logs all refresh operations for debugging
- Handles errors gracefully with exponential backoff retry

### 3. Token Management Service

Create `src/daemon/token-manager.ts`:

- Encapsulates GitHub App token generation logic
- Uses `@octokit/auth-app` for proper GitHub App authentication
- Manages installation token lifecycle
- Provides consistent interface for both initial token and refreshes

### 4. Daemon Lifecycle Management

Create `src/daemon/daemon-controller.ts`:

- Starts daemon process in background during prepare phase
- Monitors daemon health
- Provides cleanup on action completion
- Writes daemon PID and status to temp files for coordination

### 5. Enhanced Prepare Phase

Modify `src/entrypoints/prepare.ts`:

- Detect authentication method (OIDC vs GitHub App vs provided token)
- Start token refresh daemon when using GitHub App credentials
- Set extended timeout (6 hours) when daemon is active
- Pass daemon status to Claude prompts for debugging context

### 6. MCP Server for Notifications (Bonus)

Create `src/mcp/token-refresh-server.ts`:

- Implements MCP server that can send notifications to Claude about token refresh events
- Provides read-only tools for Claude to check token refresh status
- NO tools for Claude to trigger refreshes (must remain automated)
- Exposes token refresh logs and health status

### 7. Updated Prompt Generation

Modify `src/create-prompt/index.ts`:

- Include daemon status and token refresh information when active
- Provide debugging context about authentication method used
- Include token refresh logs if daemon encounters issues

## Implementation Steps

### Phase 1: Core Infrastructure

1. Add new input parameters to `action.yml`
2. Create token management service with GitHub App auth
3. Implement basic daemon structure
4. Update prepare phase to detect auth method

### Phase 2: Daemon Implementation

1. Implement background token refresh daemon
2. Add daemon lifecycle management
3. Integrate `gh auth` commands for credential updates
4. Add comprehensive logging and error handling

### Phase 3: Integration & Testing

1. Update prepare phase to start daemon when appropriate
2. Modify timeout handling for extended execution
3. Update prompt generation with daemon context
4. Test authentication flow switching

### Phase 4: MCP Server (Bonus)

1. Create MCP server for token refresh notifications
2. Add read-only status tools for Claude
3. Integrate with existing MCP configuration system

## File Structure Changes

```
src/
├── daemon/
│   ├── token-refresh-daemon.ts    # Main daemon process
│   ├── token-manager.ts           # GitHub App token operations
│   └── daemon-controller.ts       # Daemon lifecycle management
├── mcp/
│   └── token-refresh-server.ts    # MCP server for notifications
├── entrypoints/
│   └── prepare.ts                 # Enhanced auth detection
└── create-prompt/
    └── index.ts                   # Include daemon context
```

## Key Dependencies

- `@octokit/auth-app`: For GitHub App authentication
- `@octokit/rest`: For GitHub API operations
- Node.js `child_process`: For daemon management
- GitHub CLI (`gh`): For credential updates

## Security Considerations

- Private keys handled securely, never logged
- Daemon process isolated with minimal permissions
- Token refresh logs sanitized to avoid credential exposure
- Fail-safe mechanisms to prevent infinite loops

## Testing Strategy

- Unit tests for token manager and daemon controller
- Integration tests for complete auth flow
- Error scenario testing (network failures, invalid credentials)
- Timeout testing to ensure 6-hour capability

## Backwards Compatibility

- Existing OIDC flow remains default and unchanged
- New inputs are optional, maintaining current behavior
- Graceful fallback if daemon fails to start
- Clear error messages guide users between auth methods

This plan provides a robust, secure implementation that extends action capabilities while maintaining backward compatibility and providing excellent debugging capabilities for Claude.
