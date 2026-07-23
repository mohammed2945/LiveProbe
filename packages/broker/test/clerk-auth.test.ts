import { describe, expect, it } from "vitest";

import {
  BearerAuthenticationError,
  clerkAuthenticatorFromEnv,
  clerkOAuthAuthenticatorFromEnv,
  createClerkAuthenticator,
  createClerkOAuthAuthenticator,
  type ClerkTokenVerifier,
} from "../src/index.js";

describe("Clerk authentication", () => {
  it("maps a verified active organization session to a tenant principal", async () => {
    let receivedOptions: Parameters<ClerkTokenVerifier>[1] | undefined;
    const verifier: ClerkTokenVerifier = async (_token, options) => {
      receivedOptions = options;
      return {
        sub: "user_123",
        sts: "active",
        o: {
          id: "org_123",
          slg: "acme-platform",
          rol: "admin",
          per: "read,manage",
        },
      };
    };
    const authenticate = createClerkAuthenticator({
      jwtKey: "test-public-key",
      authorizedParties: [" https://app.example.com "],
      audience: ["liveprobe"],
      verifier,
    });

    await expect(authenticate("session-token")).resolves.toEqual({
      type: "user",
      role: "operator",
      principalId: "user_123",
      tenantId: "org_123",
      projectId: "default",
      environmentId: "default",
      organizationId: "org_123",
      organizationRole: "org:admin",
      tenantDisplayName: "acme-platform",
    });
    expect(receivedOptions).toEqual({
      jwtKey: "test-public-key",
      authorizedParties: ["https://app.example.com"],
      audience: ["liveprobe"],
    });
  });

  it("accepts legacy organization claim names during migration", async () => {
    const authenticate = createClerkAuthenticator({
      secretKey: "sk_test_fixture",
      authorizedParties: ["https://app.example.com"],
      verifier: async () => ({
        sub: "user_legacy",
        org_id: "org_legacy",
        org_slug: "legacy-org",
        org_role: "org:member",
      }),
    });

    await expect(authenticate("legacy-token")).resolves.toMatchObject({
      role: "operator",
      principalId: "user_legacy",
      tenantId: "org_legacy",
      organizationRole: "org:member",
      tenantDisplayName: "legacy-org",
    });
  });

  it("returns undefined when token verification or claim validation fails", async () => {
    const rejected = createClerkAuthenticator({
      secretKey: "sk_test_fixture",
      authorizedParties: ["https://app.example.com"],
      verifier: async () => {
        throw new Error("invalid signature");
      },
    });
    await expect(rejected("bad-token")).resolves.toBeUndefined();

    const malformed = createClerkAuthenticator({
      secretKey: "sk_test_fixture",
      authorizedParties: ["https://app.example.com"],
      verifier: async () => ({ sub: "", o: { id: "org_123" } }),
    });
    await expect(malformed("bad-claims")).resolves.toBeUndefined();
  });

  it("rejects pending sessions and sessions without an active organization", async () => {
    const pending = createClerkAuthenticator({
      secretKey: "sk_test_fixture",
      authorizedParties: ["https://app.example.com"],
      verifier: async () => ({ sub: "user_123", sts: "pending" }),
    });
    await expect(pending("pending-token")).rejects.toMatchObject({
      statusCode: 403,
      code: "clerk_session_pending",
    } satisfies Partial<BearerAuthenticationError>);

    const personal = createClerkAuthenticator({
      secretKey: "sk_test_fixture",
      authorizedParties: ["https://app.example.com"],
      verifier: async () => ({ sub: "user_123", sts: "active" }),
    });
    await expect(personal("personal-token")).rejects.toMatchObject({
      statusCode: 403,
      code: "organization_required",
    } satisfies Partial<BearerAuthenticationError>);
  });

  it("requires verification material and an authorized-party allowlist", () => {
    expect(() =>
      createClerkAuthenticator({
        authorizedParties: ["https://app.example.com"],
      }),
    ).toThrow("CLERK_SECRET_KEY or CLERK_JWT_KEY is required");
    expect(() =>
      createClerkAuthenticator({
        secretKey: "sk_test_fixture",
        authorizedParties: [],
      }),
    ).toThrow("CLERK_AUTHORIZED_PARTIES");
  });

  it("enables Clerk from environment only when Clerk settings are present", () => {
    expect(clerkAuthenticatorFromEnv({})).toBeUndefined();
    expect(() =>
      clerkAuthenticatorFromEnv({
        CLERK_SECRET_KEY: "sk_test_fixture",
      }),
    ).toThrow("CLERK_AUTHORIZED_PARTIES");
    expect(
      clerkAuthenticatorFromEnv({
        CLERK_SECRET_KEY: "sk_test_fixture",
        CLERK_AUTHORIZED_PARTIES: "https://app.example.com",
      }),
    ).toBeTypeOf("function");
  });

  it("maps a Clerk OAuth organization grant to a tenant principal", async () => {
    const authenticate = createClerkOAuthAuthenticator({
      secretKey: "sk_test_fixture",
      publishableKey: "pk_test_fixture",
      resourceUrl: "https://probe.example.com",
      verifier: async () => ({
        userId: "user_oauth",
        scopes: ["openid", "user:org:read"],
        claims: {
          sub: "user_oauth",
          org_id: "org_oauth",
          org_slug: "oauth-team",
        },
      }),
      membershipResolver: async () => ({
        role: "org:member",
        permissions: [],
      }),
    });

    await expect(authenticate("oauth-token")).resolves.toMatchObject({
      type: "user",
      role: "operator",
      principalId: "user_oauth",
      tenantId: "org_oauth",
      organizationId: "org_oauth",
      tenantDisplayName: "oauth-team",
    });
  });

  it("uses current organization membership instead of a stale token role", async () => {
    const authenticate = createClerkAuthenticator({
      secretKey: "sk_test_fixture",
      authorizedParties: ["https://app.example.com"],
      verifier: async () => ({
        sub: "user_viewer",
        sts: "active",
        o: { id: "org_123", rol: "admin" },
      }),
      membershipResolver: async () => ({
        role: "org:liveprobe_viewer",
        permissions: [],
      }),
    });

    await expect(authenticate("session-token")).resolves.toMatchObject({
      role: "operator",
      organizationRole: "org:liveprobe_viewer",
    });
  });

  it("fails closed for removed memberships and unmapped organization roles", async () => {
    const removed = createClerkOAuthAuthenticator({
      secretKey: "sk_test_fixture",
      publishableKey: "pk_test_fixture",
      resourceUrl: "https://probe.example.com",
      verifier: async () => ({
        userId: "user_removed",
        scopes: ["user:org:read"],
        claims: { sub: "user_removed", org_id: "org_123" },
      }),
      membershipResolver: async () => undefined,
    });
    await expect(removed("oauth-token")).rejects.toMatchObject({
      statusCode: 403,
      code: "organization_membership_required",
    } satisfies Partial<BearerAuthenticationError>);

    const unmapped = createClerkAuthenticator({
      secretKey: "sk_test_fixture",
      authorizedParties: ["https://app.example.com"],
      verifier: async () => ({
        sub: "user_custom",
        sts: "active",
        o: { id: "org_123", rol: "billing" },
      }),
    });
    await expect(unmapped("session-token")).rejects.toMatchObject({
      statusCode: 403,
      code: "unsupported_organization_role",
    } satisfies Partial<BearerAuthenticationError>);
  });

  it("requires the organization scope and selected organization for OAuth", async () => {
    const missingScope = createClerkOAuthAuthenticator({
      secretKey: "sk_test_fixture",
      publishableKey: "pk_test_fixture",
      resourceUrl: "https://probe.example.com",
      verifier: async () => ({
        userId: "user_oauth",
        scopes: ["openid"],
        claims: { sub: "user_oauth", org_id: "org_oauth" },
      }),
    });
    await expect(missingScope("oauth-token")).rejects.toMatchObject({
      statusCode: 403,
      code: "insufficient_scope",
    } satisfies Partial<BearerAuthenticationError>);

    const missingOrganization = createClerkOAuthAuthenticator({
      secretKey: "sk_test_fixture",
      publishableKey: "pk_test_fixture",
      resourceUrl: "https://probe.example.com",
      verifier: async () => ({
        userId: "user_oauth",
        scopes: ["user:org:read"],
        claims: { sub: "user_oauth" },
      }),
    });
    await expect(missingOrganization("oauth-token")).rejects.toMatchObject({
      statusCode: 403,
      code: "organization_required",
    } satisfies Partial<BearerAuthenticationError>);
  });

  it("requires complete HTTPS OAuth environment configuration", () => {
    expect(clerkOAuthAuthenticatorFromEnv({})).toBeUndefined();
    expect(() =>
      clerkOAuthAuthenticatorFromEnv({
        CLERK_PUBLISHABLE_KEY: "pk_test_fixture",
      }),
    ).toThrow("CLERK_SECRET_KEY");
    expect(() =>
      createClerkOAuthAuthenticator({
        secretKey: "sk_test_fixture",
        publishableKey: "pk_test_fixture",
        resourceUrl: "http://probe.example.com",
      }),
    ).toThrow("must use https");
  });
});
