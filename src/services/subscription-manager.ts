/**
 * Subscription Manager — handles user subscription tiers and feature gating
 * 
 * Supports:
 * - Tier checks (free, pro, enterprise)
 * - Feature limits per tier
 * - Stripe webhook integration stubs (ready for production)
 */

import { getRawDb } from '../db/connection.js';

// ─── Types ───────────────────────────────────────────────────────

export type SubscriptionTier = 'free' | 'pro' | 'enterprise';
export type SubscriptionStatus = 'active' | 'cancelled' | 'expired';

export interface UserSubscription {
  id: string;
  userId: string;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Feature limits per subscription tier.
 * Governs what users can do with literature review and other features.
 */
export const TIER_LIMITS = {
  free: {
    expansionDepth: 1,        // Only direct search, no multi-hop
    relatedPerPaper: 2,       // Fewer related papers
    maxPapersPerReview: 5,    // Smaller literature reviews
    monthlyReviews: 10,       // 10 lit-reviews/month
  },
  pro: {
    expansionDepth: 2,        // One level of expansion
    relatedPerPaper: 4,
    maxPapersPerReview: 25,
    monthlyReviews: 100,      // 100 lit-reviews/month
  },
  enterprise: {
    expansionDepth: 3,        // Full multi-hop depth
    relatedPerPaper: 5,
    maxPapersPerReview: 50,
    monthlyReviews: -1,       // Unlimited
  },
};

// ─── Database Initialization ────────────────────────────────────

/**
 * Ensure the user_subscriptions table exists.
 * Called once on startup.
 */
export function initializeSubscriptionsTable(): void {
  const db = getRawDb();

  try {
    db.prepare(
      `CREATE TABLE IF NOT EXISTS user_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT UNIQUE NOT NULL,
        tier TEXT NOT NULL DEFAULT 'free',
        status TEXT NOT NULL DEFAULT 'active',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        current_period_start TEXT,
        current_period_end TEXT,
        cancelled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ).run();

    // Create indices for faster lookups
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id)`
    ).run();
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_user_subscriptions_stripe_customer ON user_subscriptions(stripe_customer_id)`
    ).run();
  } catch (err) {
    // Silently skip if table already exists
  }
}

// ─── Core Functions ──────────────────────────────────────────────────

/**
 * Get a user's subscription, creating a free tier entry if none exists.
 */
export async function getOrCreateSubscription(
  userId: string
): Promise<UserSubscription> {
  const db = getRawDb();

  // Try to fetch existing subscription
  const result = db
    .prepare(`SELECT * FROM user_subscriptions WHERE user_id = ?`)
    .get(userId) as Record<string, any> | undefined;

  if (result) {
    return rowToSubscription(result);
  }

  // Create default free tier subscription
  const now = new Date().toISOString();
  const id = `sub_${userId}_${Date.now()}`;

  db.prepare(
    `INSERT INTO user_subscriptions (id, user_id, tier, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, userId, 'free', 'active', now, now);

  return {
    id,
    userId,
    tier: 'free',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Get the feature limits for a user based on their subscription tier.
 */
export async function getUserLimits(userId: string) {
  const sub = await getOrCreateSubscription(userId);
  return TIER_LIMITS[sub.tier];
}

/**
 * Get the effective expansion depth for a user's literature review.
 * Can be overridden by a requested depth parameter, but capped by tier.
 */
export async function getMaxExpansionDepth(
  userId: string,
  requested?: number
): Promise<number> {
  const limits = await getUserLimits(userId);
  const maxDepth = limits.expansionDepth;

  if (requested === undefined) return maxDepth;

  // Cap the requested depth to the tier limit
  return Math.min(requested, maxDepth);
}

/**
 * Upgrade a user to a new subscription tier.
 * Typically called by Stripe webhooks or admin commands.
 */
export async function upgradeSubscription(
  userId: string,
  tier: SubscriptionTier,
  stripeCustomerId?: string,
  stripeSubscriptionId?: string
): Promise<UserSubscription> {
  const db = getRawDb();
  const now = new Date().toISOString();
  const periodEnd = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000
  ).toISOString();
  const id = `sub_${userId}_${Date.now()}`;

  // Try insert; if user_id already exists (unique constraint), update instead
  db.prepare(
    `INSERT OR REPLACE INTO user_subscriptions 
     (id, user_id, tier, status, stripe_customer_id, stripe_subscription_id, 
      current_period_start, current_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    tier,
    'active',
    stripeCustomerId || null,
    stripeSubscriptionId || null,
    now,
    periodEnd,
    now,
    now
  );

  return {
    id,
    userId,
    tier,
    status: 'active',
    stripeCustomerId,
    stripeSubscriptionId,
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Cancel a user's subscription (marks as cancelled, keeps record for history).
 */
export async function cancelSubscription(userId: string): Promise<UserSubscription> {
  const db = getRawDb();
  const now = new Date().toISOString();

  // Find the current subscription
  const current = await getOrCreateSubscription(userId);

  if (current.status === 'cancelled') {
    return current; // Already cancelled
  }

  // Update to cancelled state
  db.prepare(
    `UPDATE user_subscriptions SET status = ?, cancelled_at = ?, updated_at = ? WHERE user_id = ?`
  ).run('cancelled', now, now, userId);

  return {
    ...current,
    status: 'cancelled',
    cancelledAt: now,
    updatedAt: now,
  };
}

/**
 * Check if a user has an active subscription of a specific tier or higher.
 * Useful for access control in Discord commands.
 *
 * Tier hierarchy: free < pro < enterprise
 */
export async function hasActiveTier(
  userId: string,
  minimumTier: SubscriptionTier
): Promise<boolean> {
  const sub = await getOrCreateSubscription(userId);

  if (sub.status !== 'active') return false;

  const tierHierarchy: Record<SubscriptionTier, number> = {
    free: 0,
    pro: 1,
    enterprise: 2,
  };

  return tierHierarchy[sub.tier] >= tierHierarchy[minimumTier];
}

/**
 * Stripe webhook handler stub.
 * In production, integrate with Stripe webhook events:
 * - customer.subscription.created
 * - customer.subscription.updated
 * - customer.subscription.deleted
 * - invoice.payment_succeeded
 *
 * For now, subscriptions are managed via Discord commands.
 */
export async function handleStripeWebhook(event: any): Promise<void> {
  // TODO: Implement Stripe webhook handling
  // See: https://stripe.com/docs/webhooks
  // For now, subscriptions are managed via Discord commands only
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Convert a database row to a UserSubscription object.
 */
function rowToSubscription(row: Record<string, any>): UserSubscription {
  return {
    id: row.id,
    userId: row.user_id,
    tier: row.tier as SubscriptionTier,
    status: row.status as SubscriptionStatus,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
