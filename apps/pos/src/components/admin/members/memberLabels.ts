import { getTiers } from '@/store/catalogStore';

// The tiers that require verification (the default tier is the absence of an
// entry). Driven by each tier's `requiresVerification` flag.
export const verifiedTiers = (): string[] =>
  getTiers()
    .filter((t) => t.requiresVerification)
    .map((t) => t.id);
