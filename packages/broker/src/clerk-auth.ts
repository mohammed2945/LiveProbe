import { verifyToken } from "@clerk/backend";
import { z } from "zod";

import {
  BearerAuthenticationError,
  type BearerAuthenticator,
  type BrokerPrincipal,
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
    const organizationRole = normalizedRole(claims.o?.rol ?? claims.org_role);

    return {
      type: "user",
      role: "operator",
      principalId: claims.sub,
      tenantId: organizationId,
      projectId,
      environmentId,
      organizationId,
      ...(organizationRole === undefined ? {} : { organizationRole }),
      tenantDisplayName: organizationSlug ?? organizationId,
    };
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
  return createClerkAuthenticator({
    ...(secretKey === undefined ? {} : { secretKey }),
    ...(jwtKey === undefined ? {} : { jwtKey }),
    authorizedParties,
    ...(audience.length === 0 ? {} : { audience }),
  });
}
