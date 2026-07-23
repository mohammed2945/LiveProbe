import { createClerkClient, verifyToken } from "@clerk/backend";
import { z } from "zod";

import {
  BearerAuthenticationError,
  type BearerAuthenticator,
  type BrokerPrincipal,
  type HumanRole,
} from "./auth.js";
import {
  DEFAULT_ENVIRONMENT_ID,
  DEFAULT_PROJECT_ID,
} from "./store/migrations.js";

const clerkClaimsSchema = z
  .object({
    sub: z.string().min(1).max(512),
    sts: z.string().optional(),
    o: z
      .object({
        id: z.string().min(1).max(512),
        slg: z.string().min(1).max(512).optional(),
        rol: z.string().min(1).max(200).optional(),
      })
      .passthrough()
      .optional(),
    org_id: z.string().min(1).max(512).optional(),
    org_slug: z.string().min(1).max(512).optional(),
    org_role: z.string().min(1).max(200).optional(),
  })
  .passthrough();

const clerkOAuthClaimsSchema = z
  .object({
    sub: z.string().min(1).max(512),
    org_id: z.string().min(1).max(512).optional(),
    org_name: z.string().min(1).max(512).optional(),
    org_slug: z.string().min(1).max(512).optional(),
  })
  .passthrough();

export interface ClerkVerificationOptions {
  secretKey?: string | undefined;
  jwtKey?: string | undefined;
  authorizedParties: readonly string[];
  audience?: string | readonly string[] | undefined;
}

export type ClerkTokenVerifier = (
  token: string,
  options: {
    secretKey?: string | undefined;
    jwtKey?: string | undefined;
    authorizedParties: string[];
    audience?: string | string[] | undefined;
  },
) => Promise<unknown>;

export interface CreateClerkAuthenticatorOptions
  extends ClerkVerificationOptions {
  projectId?: string | undefined;
  environmentId?: string | undefined;
  verifier?: ClerkTokenVerifier | undefined;
  membershipResolver?: ClerkMembershipResolver | undefined;
}

export interface ClerkMembership {
  role: string;
  permissions: readonly string[];
}

export type ClerkMembershipResolver = (
  userId: string,
  organizationId: string,
) => Promise<ClerkMembership | undefined>;

export interface ClerkOAuthVerificationResult {
  userId: string;
  scopes: readonly string[];
  claims: unknown;
}

export type ClerkOAuthTokenVerifier = (
  token: string,
) => Promise<ClerkOAuthVerificationResult | undefined>;

export interface CreateClerkOAuthAuthenticatorOptions {
  secretKey: string;
  publishableKey: string;
  resourceUrl: string;
  requiredScopes?: readonly string[] | undefined;
  projectId?: string | undefined;
  environmentId?: string | undefined;
  verifier?: ClerkOAuthTokenVerifier | undefined;
  membershipResolver?: ClerkMembershipResolver | undefined;
}

function requiredNonEmpty(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be non-empty`);
  }
  return value.trim();
}

function normalizedRole(role: string | undefined): string | undefined {
  if (role === undefined) return undefined;
  return role.startsWith("org:") ? role : `org:${role}`;
}

export function liveProbeRoleForClerkRole(role: string): HumanRole {
  switch (normalizedRole(role)) {
    case "org:admin":
    case "org:member":
    case "org:operator":
    case "org:liveprobe_operator":
    case "org:viewer":
    case "org:liveprobe_viewer":
      // The pilot has one effective human permission level. Keep the
      // historical role values for migration and audit compatibility.
      return "operator";
    default:
      throw new BearerAuthenticationError(
        403,
        "unsupported_organization_role",
        `Clerk organization role ${role} is not mapped to a LiveProbe role`,
      );
  }
}

export function createClerkMembershipResolver(
  secretKey: string,
  cacheTtlMs = 30_000,
): ClerkMembershipResolver {
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) {
    throw new RangeError("Clerk membership cacheTtlMs must be non-negative");
  }
  const clerk = createClerkClient({
    secretKey: requiredNonEmpty(secretKey, "CLERK_SECRET_KEY"),
  });
  const cache = new Map<
    string,
    { expiresAt: number; membership: ClerkMembership | undefined }
  >();
  return async (userId, organizationId) => {
    const cacheKey = `${organizationId}:${userId}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.membership;
    }
    let response: Awaited<
      ReturnType<typeof clerk.organizations.getOrganizationMembershipList>
    >;
    try {
      response = await clerk.organizations.getOrganizationMembershipList({
        organizationId,
        userId: [userId],
        limit: 1,
      });
    } catch (error: unknown) {
      throw new BearerAuthenticationError(
        503,
        "clerk_membership_unavailable",
        "Clerk organization membership could not be verified",
      );
    }
    const resolved = response.data[0];
    const membership =
      resolved === undefined
        ? undefined
        : { role: resolved.role, permissions: resolved.permissions };
    if (cache.size >= 1_000) cache.clear();
    cache.set(cacheKey, {
      expiresAt: Date.now() + cacheTtlMs,
      membership,
    });
    return membership;
  };
}

async function resolveHumanRole(
  userId: string,
  organizationId: string,
  tokenRole: string | undefined,
  resolver: ClerkMembershipResolver | undefined,
): Promise<{ role: HumanRole; organizationRole: string }> {
  let organizationRole = normalizedRole(tokenRole);
  if (resolver !== undefined) {
    const membership = await resolver(userId, organizationId);
    if (membership === undefined) {
      throw new BearerAuthenticationError(
        403,
        "organization_membership_required",
        "the Clerk user is no longer a member of the selected organization",
      );
    }
    organizationRole = normalizedRole(membership.role);
  }
  if (organizationRole === undefined) {
    throw new BearerAuthenticationError(
      403,
      "organization_role_required",
      "the Clerk organization membership has no role",
    );
  }
  return {
    role: liveProbeRoleForClerkRole(organizationRole),
    organizationRole,
  };
}

export function createClerkAuthenticator(
  options: CreateClerkAuthenticatorOptions,
): BearerAuthenticator {
  const secretKey = options.secretKey?.trim();
  const jwtKey = options.jwtKey?.trim();
  if (!secretKey && !jwtKey) {
    throw new Error("CLERK_SECRET_KEY or CLERK_JWT_KEY is required");
  }
  const authorizedParties = options.authorizedParties
    .map((party) => party.trim())
    .filter((party) => party.length > 0);
  if (authorizedParties.length === 0) {
    throw new Error("CLERK_AUTHORIZED_PARTIES must contain at least one origin");
  }
  const projectId = requiredNonEmpty(
    options.projectId ?? DEFAULT_PROJECT_ID,
    "Clerk projectId",
  );
  const environmentId = requiredNonEmpty(
    options.environmentId ?? DEFAULT_ENVIRONMENT_ID,
    "Clerk environmentId",
  );
  const verifier = options.verifier ?? verifyToken;
  const audience =
    typeof options.audience === "string"
      ? options.audience
      : options.audience === undefined
        ? undefined
        : [...options.audience];

  return async (token): Promise<BrokerPrincipal | undefined> => {
    let untrustedClaims: unknown;
    try {
      untrustedClaims = await verifier(token, {
        ...(secretKey ? { secretKey } : {}),
        ...(jwtKey ? { jwtKey } : {}),
        authorizedParties,
        ...(audience === undefined ? {} : { audience }),
      });
    } catch {
      return undefined;
    }

    const parsed = clerkClaimsSchema.safeParse(untrustedClaims);
    if (!parsed.success) return undefined;
    const claims = parsed.data;
    if (claims.sts === "pending") {
      throw new BearerAuthenticationError(
        403,
        "clerk_session_pending",
        "Clerk account setup is incomplete",
      );
    }

    const organizationId = claims.o?.id ?? claims.org_id;
    if (organizationId === undefined) {
      throw new BearerAuthenticationError(
        403,
        "organization_required",
        "select or join a Clerk organization before using LiveProbe",
      );
    }
    const organizationSlug = claims.o?.slg ?? claims.org_slug;
    const { role, organizationRole } = await resolveHumanRole(
      claims.sub,
      organizationId,
      claims.o?.rol ?? claims.org_role,
      options.membershipResolver,
    );

    return {
      type: "user",
      role,
      principalId: claims.sub,
      tenantId: organizationId,
      projectId,
      environmentId,
      organizationId,
      organizationRole,
      tenantDisplayName: organizationSlug ?? organizationId,
    };
  };
}

function decodeJwtPayload(token: string): unknown {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function createClerkOAuthAuthenticator(
  options: CreateClerkOAuthAuthenticatorOptions,
): BearerAuthenticator {
  const secretKey = requiredNonEmpty(options.secretKey, "CLERK_SECRET_KEY");
  const publishableKey = requiredNonEmpty(
    options.publishableKey,
    "CLERK_PUBLISHABLE_KEY",
  );
  const resourceUrl = new URL(
    requiredNonEmpty(options.resourceUrl, "LIVEPROBE_PUBLIC_URL"),
  );
  if (resourceUrl.protocol !== "https:") {
    throw new Error("LIVEPROBE_PUBLIC_URL must use https for Clerk OAuth");
  }
  resourceUrl.pathname = "/mcp";
  resourceUrl.search = "";
  resourceUrl.hash = "";
  const projectId = requiredNonEmpty(
    options.projectId ?? DEFAULT_PROJECT_ID,
    "Clerk OAuth projectId",
  );
  const environmentId = requiredNonEmpty(
    options.environmentId ?? DEFAULT_ENVIRONMENT_ID,
    "Clerk OAuth environmentId",
  );
  const requiredScopes = options.requiredScopes ?? ["user:org:read"];
  const clerk =
    options.verifier === undefined
      ? createClerkClient({ secretKey, publishableKey })
      : undefined;
  const verifier =
    options.verifier ??
    (async (token): Promise<ClerkOAuthVerificationResult | undefined> => {
      const state = await clerk!.authenticateRequest(
        new Request(resourceUrl, {
          headers: { authorization: `Bearer ${token}` },
        }),
        { acceptsToken: "oauth_token", publishableKey },
      );
      if (!state.isAuthenticated) return undefined;
      const auth = state.toAuth();
      return {
        userId: auth.userId,
        scopes: auth.scopes,
        claims: decodeJwtPayload(token),
      };
    });
  const membershipResolver =
    options.membershipResolver ?? createClerkMembershipResolver(secretKey);

  return async (token): Promise<BrokerPrincipal | undefined> => {
    let verified: ClerkOAuthVerificationResult | undefined;
    try {
      verified = await verifier(token);
    } catch {
      return undefined;
    }
    if (verified === undefined) return undefined;
    const missingScope = requiredScopes.find(
      (scope) => !verified.scopes.includes(scope),
    );
    if (missingScope !== undefined) {
      throw new BearerAuthenticationError(
        403,
        "insufficient_scope",
        `Clerk OAuth token is missing required scope ${missingScope}`,
      );
    }
    const parsed = clerkOAuthClaimsSchema.safeParse(verified.claims);
    if (!parsed.success || parsed.data.sub !== verified.userId) {
      return undefined;
    }
    if (parsed.data.org_id === undefined) {
      throw new BearerAuthenticationError(
        403,
        "organization_required",
        "select a Clerk organization when authorizing LiveProbe",
      );
    }
    const displayName =
      parsed.data.org_slug ?? parsed.data.org_name ?? parsed.data.org_id;
    const { role, organizationRole } = await resolveHumanRole(
      verified.userId,
      parsed.data.org_id,
      undefined,
      membershipResolver,
    );
    return {
      type: "user",
      role,
      principalId: verified.userId,
      tenantId: parsed.data.org_id,
      projectId,
      environmentId,
      organizationId: parsed.data.org_id,
      organizationRole,
      tenantDisplayName: displayName,
    };
  };
}

export function combineBearerAuthenticators(
  authenticators: readonly BearerAuthenticator[],
): BearerAuthenticator | undefined {
  if (authenticators.length === 0) return undefined;
  return async (token) => {
    for (const authenticate of authenticators) {
      const principal = await authenticate(token);
      if (principal !== undefined) return principal;
    }
    return undefined;
  };
}

export function clerkAuthenticatorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BearerAuthenticator | undefined {
  const secretKey = env["CLERK_SECRET_KEY"];
  const jwtKey = env["CLERK_JWT_KEY"];
  const authorizedPartiesValue = env["CLERK_AUTHORIZED_PARTIES"];
  const audienceValue = env["CLERK_AUDIENCE"];
  const configured = [
    secretKey,
    jwtKey,
    authorizedPartiesValue,
    audienceValue,
  ].some((value) => value !== undefined && value.trim().length > 0);
  if (!configured) return undefined;

  const authorizedParties = (authorizedPartiesValue ?? "").split(",");
  const audience = (audienceValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const membershipResolver =
    secretKey === undefined
      ? undefined
      : createClerkMembershipResolver(secretKey);
  return createClerkAuthenticator({
    ...(secretKey === undefined ? {} : { secretKey }),
    ...(jwtKey === undefined ? {} : { jwtKey }),
    authorizedParties,
    ...(audience.length === 0 ? {} : { audience }),
    ...(membershipResolver === undefined ? {} : { membershipResolver }),
  });
}

export function clerkOAuthAuthenticatorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BearerAuthenticator | undefined {
  const secretKey = env["CLERK_SECRET_KEY"];
  const publishableKey = env["CLERK_PUBLISHABLE_KEY"];
  const publicUrl = env["LIVEPROBE_PUBLIC_URL"];
  const configured = [publishableKey, publicUrl].some(
    (value) => value !== undefined && value.trim().length > 0,
  );
  if (!configured) return undefined;
  return createClerkOAuthAuthenticator({
    secretKey: requiredNonEmpty(secretKey, "CLERK_SECRET_KEY"),
    publishableKey: requiredNonEmpty(
      publishableKey,
      "CLERK_PUBLISHABLE_KEY",
    ),
    resourceUrl: requiredNonEmpty(publicUrl, "LIVEPROBE_PUBLIC_URL"),
  });
}
