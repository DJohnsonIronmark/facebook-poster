import { isSwitchOn } from '../instagram/rules';
import type { PublishingSwitches } from '../instagram/release';

// Server-only: the per-platform publishing switches (all default OFF). See lib/instagram/release.ts
// for what they gate. Facebook has no switch.

export function linkedinPublishingEnabled(): boolean {
  return isSwitchOn(process.env.LINKEDIN_PUBLISHING_ENABLED);
}

export function xPublishingEnabled(): boolean {
  return isSwitchOn(process.env.X_PUBLISHING_ENABLED);
}

export function publishingSwitches(): PublishingSwitches {
  return {
    instagram: isSwitchOn(process.env.INSTAGRAM_PUBLISHING_ENABLED),
    linkedin: linkedinPublishingEnabled(),
    x: xPublishingEnabled(),
  };
}
