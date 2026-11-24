import { isSwitchOn } from '../instagram/rules';
import type { PublishingSwitches } from '../instagram/release';

// Server-only: the per-platform publishing switches (all default OFF). See lib/instagram/release.ts
// for what they gate. Facebook itself has no switch (it always publishes, via n8n by default);
// FACEBOOK_APP_PUBLISHING_ENABLED only gates the app runner for pages set to publish_via = 'app'.

/** Pages set to publish_via='app' are published by the app runner only while this is on. */
export function facebookAppPublishingEnabled(): boolean {
  return isSwitchOn(process.env.FACEBOOK_APP_PUBLISHING_ENABLED);
}

export function linkedinPublishingEnabled(): boolean {
  return isSwitchOn(process.env.LINKEDIN_PUBLISHING_ENABLED);
}

export function xPublishingEnabled(): boolean {
  return isSwitchOn(process.env.X_PUBLISHING_ENABLED);
}

export function publishingSwitches(): PublishingSwitches {
  return {
    // n8n or the app itself publishes Instagram (approval Schedule releases Instagram rows when either is on)
    instagram: isSwitchOn(process.env.INSTAGRAM_PUBLISHING_ENABLED) || isSwitchOn(process.env.INSTAGRAM_APP_PUBLISHING_ENABLED),
    linkedin: linkedinPublishingEnabled(),
    x: xPublishingEnabled(),
  };
}
