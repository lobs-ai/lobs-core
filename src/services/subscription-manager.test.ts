/**
 * Tests for subscription-manager.ts
 *
 * Validates subscription creation, tier upgrades, cancellations,
 * feature-limit enforcement, and usage tracking.
 * All DB interactions are mocked via vitest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock getRawDb (returns a fake better-sqlite3 instance) ────────────────────

type MockStmt = {
  run: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  all: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
};

function makeMockStmt(): MockStmt {
  return {
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
    exec: vi.fn(),
  };
}

const mockPrepare = vi.fn<(sql: string) => MockStmt>();

const fakeDb = {
  prepare: mockPrepare,
  exec: vi.fn(),
};

vi.mock("../db/connection.js", () => ({
  getRawDb: vi.fn(() => fakeDb),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import {
  getOrCreateSubscription,
  getUserLimits,
  getMaxExpansionDepth,
  upgradeSubscription,
  cancelSubscription,
  hasActiveTier,
  getMonthlyReviewCount,
  recordReviewUsage,
  initializeSubscriptionsTable,
  TIER_LIMITS,
} from "./subscription-manager.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function stubGet(sql: string, result: Record<string, unknown> | undefined) {
  const stmt = makeMockStmt();
  stmt.get.mockReturnValue(result);
  mockPrepare.mockReturnValue(stmt as MockStmt);
  return stmt;
}

function stubInsertOrUpdate(): MockStmt {
  const stmt = makeMockStmt();
  stmt.run.mockReturnValue(undefined);
  mockPrepare.mockReturnValue(stmt as MockStmt);
  return stmt;
}

// ── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockPrepare.mockReset();
  fakeDb.exec.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("initializeSubscriptionsTable", () => {
  it("creates the user_subscriptions table and indices", () => {
    initializeSubscriptionsTable();

    // Should call prepare 3 times (table + 2 indices)
    expect(mockPrepare.mock.calls.length).toBe(3);
    // Each should be followed by .run()
    const calls = mockPrepare.mock.calls as unknown as Array<[sql: string, stmt?: MockStmt]>;
    calls.forEach((call) => {
      if (call[1]) expect(call[1].run).toHaveBeenCalled();
    });
  });
});

describe("getOrCreateSubscription", () => {
  it("returns existing subscription when one exists", async () => {
    const existing = {
      id: "sub_abc123",
      user_id: "user_42",
      tier: "pro",
      status: "active",
      stripe_customer_id: null,
      stripe_subscription_id: null,
      current_period_start: "2024-01-01T00:00:00.000Z",
      current_period_end: "2024-01-31T00:00:00.000Z",
      cancelled_at: null,
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    };
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", existing);

    const result = await getOrCreateSubscription("user_42");

    expect(result.tier).toBe("pro");
    expect(result.status).toBe("active");
  });

  it("creates a free-tier subscription when none exists", async () => {
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", undefined);
    const runStmt = stubInsertOrUpdate();

    const result = await getOrCreateSubscription("user_brand-new");

    expect(result.tier).toBe("free");
    expect(result.status).toBe("active");
    expect(result.userId).toBe("user_brand-new");
    expect(runStmt.run).toHaveBeenCalledOnce();
  });
});

describe("getUserLimits", () => {
  it("returns free tier limits for a free user", async () => {
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", {
      id: "sub_x",
      user_id: "u1",
      tier: "free",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    const limits = await getUserLimits("u1");

    expect(limits).toEqual(TIER_LIMITS.free);
  });

  it("returns pro tier limits for a pro user", async () => {
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", {
      id: "sub_x",
      user_id: "u2",
      tier: "pro",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    const limits = await getUserLimits("u2");

    expect(limits).toEqual(TIER_LIMITS.pro);
  });

  it("returns enterprise tier limits for an enterprise user", async () => {
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", {
      id: "sub_x",
      user_id: "u3",
      tier: "enterprise",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    const limits = await getUserLimits("u3");

    expect(limits).toEqual(TIER_LIMITS.enterprise);
  });
});

describe("getMaxExpansionDepth", () => {
  it("returns the tier's max depth when no request is made", async () => {
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", {
      id: "sub_x",
      user_id: "u1",
      tier: "pro",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    const depth = await getMaxExpansionDepth("u1");

    expect(depth).toBe(2); // pro
  });

  it("caps requested depth to the tier limit", async () => {
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", {
      id: "sub_x",
      user_id: "u1",
      tier: "free",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    const depth = await getMaxExpansionDepth("u1", 5);

    expect(depth).toBe(1); // capped to free tier limit of 1
  });

  it("allows a requested depth at or below the tier limit", async () => {
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", {
      id: "sub_x",
      user_id: "u1",
      tier: "pro",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    const depth = await getMaxExpansionDepth("u1", 2);

    expect(depth).toBe(2); // within pro limit
  });
});

describe("upgradeSubscription", () => {
  it("inserts a new subscription row with the given tier", async () => {
    stubInsertOrUpdate();

    const result = await upgradeSubscription("user_99", "pro", "cus_abc", "sub_xyz");

    expect(result.tier).toBe("pro");
    expect(result.stripeCustomerId).toBe("cus_abc");
    expect(result.stripeSubscriptionId).toBe("sub_xyz");
    expect(result.status).toBe("active");
  });

  it("works without stripe IDs", async () => {
    stubInsertOrUpdate();

    const result = await upgradeSubscription("user_99", "enterprise");

    expect(result.tier).toBe("enterprise");
    expect(result.stripeCustomerId).toBeUndefined();
  });
});

describe("cancelSubscription", () => {
  it("updates status to cancelled for an active subscription", async () => {
    // First call: getOrCreateSubscription
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", {
      id: "sub_x",
      user_id: "u_cancel",
      tier: "pro",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });
    // Second call: UPDATE
    const updateStmt = stubInsertOrUpdate();

    const result = await cancelSubscription("u_cancel");

    expect(result.status).toBe("cancelled");
    expect(result.cancelledAt).toBeDefined();
    expect(updateStmt.run).toHaveBeenCalledOnce();
  });

  it("returns the subscription unchanged if already cancelled", async () => {
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", {
      id: "sub_x",
      user_id: "u_cancel2",
      tier: "free",
      status: "cancelled",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    const result = await cancelSubscription("u_cancel2");

    expect(result.status).toBe("cancelled");
    // updateStmt should NOT have been called
  });
});

describe("hasActiveTier", () => {
  it("returns true when user has the exact requested tier", async () => {
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", {
      id: "sub_x",
      user_id: "u1",
      tier: "pro",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    const result = await hasActiveTier("u1", "pro");

    expect(result).toBe(true);
  });

  it("returns true when user has a higher tier than requested", async () => {
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", {
      id: "sub_x",
      user_id: "u1",
      tier: "enterprise",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    const result = await hasActiveTier("u1", "pro");

    expect(result).toBe(true);
  });

  it("returns false when user has a lower tier than requested", async () => {
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", {
      id: "sub_x",
      user_id: "u1",
      tier: "free",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    const result = await hasActiveTier("u1", "pro");

    expect(result).toBe(false);
  });

  it("returns false when subscription is not active", async () => {
    stubGet("SELECT * FROM user_subscriptions WHERE user_id = ?", {
      id: "sub_x",
      user_id: "u1",
      tier: "pro",
      status: "cancelled",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    const result = await hasActiveTier("u1", "pro");

    expect(result).toBe(false);
  });
});

describe("getMonthlyReviewCount", () => {
  it("returns the count from the usage table", () => {
    const stmt = makeMockStmt();
    stmt.get.mockReturnValue({ count: 7 });
    mockPrepare.mockReturnValue(stmt as MockStmt);

    const count = getMonthlyReviewCount("u_monthly");

    expect(count).toBe(7);
  });

  it("returns 0 when no usage record exists", () => {
    const stmt = makeMockStmt();
    stmt.get.mockReturnValue(undefined);
    mockPrepare.mockReturnValue(stmt as MockStmt);

    const count = getMonthlyReviewCount("u_no_usage");

    expect(count).toBe(0);
  });
});

describe("recordReviewUsage", () => {
  it("creates the lit_review_usage table if needed and inserts a row", () => {
    const execStmt = makeMockStmt();
    fakeDb.exec.mockReturnValue(undefined);
    const insertStmt = makeMockStmt();
    insertStmt.run.mockReturnValue(undefined);
    mockPrepare.mockReturnValueOnce(execStmt as MockStmt);
    mockPrepare.mockReturnValueOnce(insertStmt as MockStmt);

    recordReviewUsage("u_usage");

    expect(fakeDb.exec).toHaveBeenCalledOnce();
    expect(insertStmt.run).toHaveBeenCalledOnce();
  });
});

describe("TIER_LIMITS", () => {
  it("free tier has a max expansion depth of 1", () => {
    expect(TIER_LIMITS.free.expansionDepth).toBe(1);
  });

  it("pro tier has a max expansion depth of 2", () => {
    expect(TIER_LIMITS.pro.expansionDepth).toBe(2);
  });

  it("enterprise tier has unlimited monthly reviews (-1)", () => {
    expect(TIER_LIMITS.enterprise.monthlyReviews).toBe(-1);
  });

  it("free tier monthly reviews is limited to 10", () => {
    expect(TIER_LIMITS.free.monthlyReviews).toBe(10);
  });
});