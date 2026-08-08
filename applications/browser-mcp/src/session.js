/**
 * One BrowserSession per MCP session.
 *
 * Lazy by design: constructing this object provisions NOTHING. The AgentCore
 * browser session and its dedicated chrome-devtools-mcp child are created on the
 * first actual tool call, and torn down again when the session goes idle. So an
 * agent that merely knows about the browser tools costs nothing, and a pod at
 * rest holds no browser sessions.
 *
 * Each MCP session gets its OWN AgentCore session, so conversations never share
 * cookies or page state. The pod is only a signer/router: the browser itself runs
 * in AgentCore, which is why one pod can host many concurrent sessions.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { config } from './config.js';
import { log } from './log.js';
import { signWsHeaders, startSession, stopSession } from './agentcore.js';

export class BrowserSession {
  /**
   * @param {object} deps { region, browserId, dataPlane } shared, resolved once at boot.
   */
  constructor(mcpSessionId, deps) {
    this.mcpSessionId = mcpSessionId;
    this.deps = deps;
    this.client = null;
    this.transport = null;
    this.browserSessionId = null;
    this.idleTimer = null;
    this.ttlTimer = null;
    this.closed = false;
    this.holdsSlot = false;
    // Serialises concurrent first-calls so we mint exactly one browser session.
    this.activating = null;
  }

  get active() {
    return this.client !== null;
  }

  /** Mint the AgentCore session and attach a dedicated chrome-devtools-mcp child. */
  async #activate() {
    const { region, browserId, dataPlane, limiter } = this.deps;

    // Cap applies to LIVE browser sessions; idle MCP sessions cost nothing.
    limiter.acquire();
    this.holdsSlot = true;

    let sessionId;
    try {
      ({ sessionId } = await startSession(dataPlane, browserId, 'browser-mcp'));
    } catch (err) {
      this.#releaseSlot();
      throw err;
    }
    this.browserSessionId = sessionId;
    log.info(
      { mcpSessionId: this.mcpSessionId, browserSessionId: sessionId },
      'Started AgentCore browser session',
    );

    try {
      const { wsUrl, headers } = await signWsHeaders(region, browserId, sessionId);

      this.transport = new StdioClientTransport({
        command: config.cdpCommand,
        args: [
          '--headless=true',
          `--wsEndpoint=${wsUrl}`,
          `--wsHeaders=${JSON.stringify(headers)}`,
        ],
        stderr: 'pipe',
      });
      const client = new Client({ name: 'browser-mcp', version: '0.1.0' });
      await client.connect(this.transport);
      this.client = client;

      // Each session owns its TTL, so expiry is handled per session rather than
      // by recycling the whole pod.
      this.ttlTimer = setTimeout(
        () => this.deactivate('session-ttl').catch(() => {}),
        Math.max(1, config.sessionTimeoutSeconds - 30) * 1000,
      );

      log.info({ mcpSessionId: this.mcpSessionId }, 'Attached to browser over CDP');
    } catch (err) {
      // Never leak a paid-for AgentCore session if attaching failed.
      await this.#stopBrowserSession();
      throw err;
    }
  }

  async #ensureActive() {
    if (this.closed) throw new Error('MCP session is closed');
    if (this.active) return;
    if (!this.activating) {
      this.activating = this.#activate().finally(() => {
        this.activating = null;
      });
    }
    await this.activating;
  }

  #resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (config.sessionIdleSeconds <= 0) return;
    this.idleTimer = setTimeout(
      () => this.deactivate('idle').catch(() => {}),
      config.sessionIdleSeconds * 1000,
    );
  }

  /** Forward a tool call, activating the browser on first use. */
  async callTool(name, args) {
    await this.#ensureActive();
    this.#resetIdleTimer();
    return this.client.callTool({ name, arguments: args || {} });
  }

  #releaseSlot() {
    if (this.holdsSlot) {
      this.holdsSlot = false;
      this.deps.limiter.release();
    }
  }

  async #stopBrowserSession() {
    if (!this.browserSessionId) {
      this.#releaseSlot();
      return;
    }
    const id = this.browserSessionId;
    this.browserSessionId = null;
    try {
      await stopSession(this.deps.dataPlane, this.deps.browserId, id);
      log.info({ mcpSessionId: this.mcpSessionId, browserSessionId: id }, 'Stopped AgentCore browser session');
    } catch (err) {
      log.warn({ browserSessionId: id, err: err.message }, 'Failed to stop browser session');
    } finally {
      this.#releaseSlot();
    }
  }

  /**
   * Release the browser but keep the MCP session usable: tools/list keeps working
   * and the next tool call transparently re-mints a fresh browser session.
   */
  async deactivate(reason) {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.ttlTimer) { clearTimeout(this.ttlTimer); this.ttlTimer = null; }

    const client = this.client;
    this.client = null;
    this.transport = null;

    if (client) {
      log.info({ mcpSessionId: this.mcpSessionId, reason }, 'Releasing browser');
      await client.close().catch(() => {});
    }
    await this.#stopBrowserSession();
  }

  /** Terminal teardown for this MCP session. */
  async close(reason = 'closed') {
    this.closed = true;
    await this.deactivate(reason);
  }
}
