/**
 * Adapters barrel + wiring hub.
 *
 * Services import ports (from '@/ports'), never adapters.
 * Adapters are wired here, in wireAllAdapters(), called from main.tsx.
 *
 * Per 2.6 Adapter Design rules:
 * - Adapters MUST NOT contain business logic
 * - Adapters MUST NOT import other adapters
 * - Adapters MAY import store + ports + pure utilities
 * - NotificationAdapter MAY import Toast (leaf component exception)
 */

import { wireMessaging, wireNPC, wireArchive, wireCampaignContext, wireSettings, wireNotifications } from '../ports';
import { createMessagingAdapter } from './messagingAdapter';
import { createNPCAdapter } from './npcAdapter';
import { createArchiveAdapter } from './archiveAdapter';
import { createCampaignContextAdapter } from './campaignContextAdapter';
import { createSettingsAdapter } from './settingsAdapter';
import { createNotificationAdapter } from './notificationAdapter';

let wired = false;

/**
 * Wire all 6 adapters to their ports + register store with embedding scheduler.
 */
export function wireAllAdapters(): void {
  if (wired) {
    if (import.meta.env.DEV) {
      console.warn('[adapters] wireAllAdapters() called twice — ignoring');
    }
    return;
  }

  wireMessaging(createMessagingAdapter());
  wireNPC(createNPCAdapter());
  wireArchive(createArchiveAdapter());
  wireCampaignContext(createCampaignContextAdapter());
  wireSettings(createSettingsAdapter());
  wireNotifications(createNotificationAdapter());

  // Register the store with the embedding scheduler (was in useAppStore.ts)

  wired = true;

  if (import.meta.env.DEV) {
    console.info('[adapters] all 6 adapters wired + store registered with scheduler');
  }
}

/** Test-only: reset wired flag. Used by smoke tests to re-wire fresh adapters. */
export function _resetAdaptersForTesting(): void {
  wired = false;
}
