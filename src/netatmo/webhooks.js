// -----------------------------------------------------------------------------
// Gladys Plus webhooks (issue #5, SDK 0.9.0 contract B.17).
//
// A local Gladys is not reachable from the Internet, so Netatmo events cannot
// hit it directly. Gladys Plus relays them: the SDK gives us a public URL
// (getWebhooks), we register it at Netatmo (addwebhook), and Netatmo POSTs its
// events to it — relayed to onWebhook.
//
// Doctrine "trigger, not data": events arrive duplicated, late or out of order,
// and their payloads are partial — a webhook event only TRIGGERS a refresh
// through the Netatmo API (the poll stays the source of truth), it is never
// applied as a state. A burst of events is debounced into a single refresh.
//
// Availability degrades cleanly: no Gladys Plus linked (getWebhooks.available
// false), or an older core without the endpoint → we stay on poll only.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { WEBHOOK_KEY, WEBHOOK_DEBOUNCE_MS } from './constants.js';

const logger = createLogger({ name: 'netatmo-webhooks' });

/**
 * Create the webhook engine.
 * @param {object} deps dependencies
 * @param {object} deps.gladys SDK instance (getWebhooks)
 * @param {object} deps.client Netatmo API client (addWebhook/dropWebhook)
 * @param {() => Promise<void>} deps.refresh refresh triggered by an event
 * @param {number} [deps.debounceMs] debounce window (tests)
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers] injectable timers (tests)
 */
export function createWebhooks({
  gladys,
  client,
  refresh,
  debounceMs = WEBHOOK_DEBOUNCE_MS,
  timers = { setTimeout, clearTimeout },
}) {
  let debounceTimer = null;
  let registered = false;

  /**
   * (Re)register the relay URL at Netatmo. Best effort: called on every
   * successful connection and whenever the Gladys Plus availability changes.
   * @returns {Promise<boolean>} true when the webhook is registered
   */
  async function register() {
    let info;
    try {
      info = await gladys.getWebhooks();
    } catch (err) {
      // Older Gladys core without the webhook relay: poll only.
      logger.debug(`getWebhooks unavailable (older core?): ${err.message}`);
      return false;
    }
    if (!info || !info.available) {
      logger.debug('Gladys Plus not linked — webhooks unavailable, staying on poll only');
      registered = false;
      return false;
    }
    const events = (info.webhooks ?? []).find((webhook) => webhook.key === WEBHOOK_KEY);
    if (!events || !events.url) {
      logger.warn(`No "${WEBHOOK_KEY}" webhook returned by Gladys — staying on poll only`);
      return false;
    }
    try {
      await client.addWebhook(events.url);
      registered = true;
      logger.info('Netatmo webhook registered — events will trigger an immediate refresh');
      return true;
    } catch (err) {
      logger.warn(`Netatmo addwebhook failed (${err.message}) — staying on poll only`);
      return false;
    }
  }

  /**
   * Handle one relayed webhook event: debounce a refresh (never apply the
   * payload). Fire-and-forget mode — the resolved value is ignored.
   */
  function handleEvent() {
    if (debounceTimer) {
      return; // a refresh is already scheduled for this burst
    }
    debounceTimer = timers.setTimeout(async () => {
      debounceTimer = null;
      try {
        await refresh();
      } catch (err) {
        logger.warn(`Webhook-triggered refresh failed: ${err.message}`);
      }
    }, debounceMs);
  }

  /** Cancel a pending debounced refresh (on disconnect / shutdown). */
  function stop() {
    if (debounceTimer) {
      timers.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  /** Best-effort drop of the Netatmo webhook (only when one was registered). */
  async function drop() {
    if (!registered) {
      return;
    }
    try {
      await client.dropWebhook();
      registered = false;
      logger.info('Netatmo webhook dropped');
    } catch (err) {
      logger.debug(`Netatmo dropwebhook failed (ignored): ${err.message}`);
    }
  }

  return { register, handleEvent, stop, drop, isRegistered: () => registered };
}
