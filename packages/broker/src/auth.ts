import { createHash, randomBytes } from "node:crypto";

import {
  DEFAULT_ENVIRONMENT_ID,
  DEFAULT_PROJECT_ID,
  DEFAULT_TENANT_ID,
} from "./store/migrations.js";

export const SERVICE_API_KEY_PREFIX = "lp_service_";
export const NATIVE_API_KEY_PREFIX = "lp_native_";

export type HumanRole = "admin" | "operator" | "viewer";

export interface ResourceScope {
  tenantId: string;
  projectId: string;
  environmentId: string;
}

export interface ResourceScopeLabels {
  tenantDisplayName?: string | undefined;
  projectDisplayName?: string | undefined;
  environmentDisplayName?: string | undefined;
}

export const DEFAULT_RESOURCE_SCOPE: ResourceScope = {
  tenantId: DEFAULT_TENANT_ID,
  projectId: DEFAULT_PROJECT_ID,
  environmentId: DEFAULT_ENVIRONMENT_ID,
};

export interface ServiceCredentialRecord extends ResourceScope {
  credentialId: string;
  serviceId: string;
  label: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt?: string | undefined;
  revokedAt?: string | undefined;
}

export interface StoredServiceCredential extends ServiceCredentialRecord {
  secretHash: string;
}

export interface NativeCredentialRecord extends ResourceScope {
  credentialId: string;
  agentId: string;
  allowedServiceIds: string[];
  label: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt?: string | undefined;
  revokedAt?: string | undefined;
}

export interface StoredNativeCredential extends NativeCredentialRecord {
  secretHash: string;
}

export type BrokerPrincipal =
  | (ResourceScope & {
      type: "shared";
      principalId: "shared-key" | "development";
      role: "admin";
    })
  | (ResourceScope & {
      type: "user";
      principalId: string;
      role: HumanRole;
      organizationId?: string | undefined;
      organizationRole?: string | undefined;
      tenantDisplayName?: string | undefined;
    })
  | (ResourceScope & {
      type: "service";
      principalId: string;
      role: "agent";
      serviceId: string;
    })
  | (ResourceScope & {
      type: "native";
      principalId: string;
      role: "native-agent";
      agentId: string;
      allowedServiceIds: string[];
    });

export interface ServiceCredentialMaterial {
  apiKey: string;
  record: StoredServiceCredential;
}

export interface NativeCredentialMaterial {
  apiKey: string;
  record: StoredNativeCredential;
}

export type BearerAuthenticator = (
  token: string,
) => Promise<BrokerPrincipal | undefined>;

export class BearerAuthenticationError extends Error {
  public constructor(
    public readonly statusCode: 401 | 403 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BearerAuthenticationError";
  }
}

export function hashBearerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createServiceCredentialMaterial(input: {
  serviceId: string;
  label: string;
  scope?: ResourceScope;
  now?: Date;
}): ServiceCredentialMaterial {
  const secret = randomBytes(32).toString("base64url");
  const apiKey = `${SERVICE_API_KEY_PREFIX}${secret}`;
  const scope = input.scope ?? DEFAULT_RESOURCE_SCOPE;
  return {
    apiKey,
    record: {
      credentialId: `svc_${randomBytes(16).toString("hex")}`,
      ...scope,
      serviceId: input.serviceId,
      label: input.label,
      keyPrefix: `${SERVICE_API_KEY_PREFIX}${secret.slice(0, 8)}`,
      secretHash: hashBearerToken(apiKey),
      createdAt: (input.now ?? new Date()).toISOString(),
    },
  };
}

export function createNativeCredentialMaterial(input: {
  agentId: string;
  allowedServiceIds: string[];
  label: string;
  scope?: ResourceScope;
  now?: Date;
}): NativeCredentialMaterial {
  const secret = randomBytes(32).toString("base64url");
  const apiKey = `${NATIVE_API_KEY_PREFIX}${secret}`;
  const scope = input.scope ?? DEFAULT_RESOURCE_SCOPE;
  return {
    apiKey,
    record: {
      credentialId: `nat_${randomBytes(16).toString("hex")}`,
      ...scope,
      agentId: input.agentId,
      allowedServiceIds: [...new Set(input.allowedServiceIds)].sort(),
      label: input.label,
      keyPrefix: `${NATIVE_API_KEY_PREFIX}${secret.slice(0, 8)}`,
      secretHash: hashBearerToken(apiKey),
      createdAt: (input.now ?? new Date()).toISOString(),
    },
  };
}

export function servicePrincipal(
  credential: ServiceCredentialRecord,
): BrokerPrincipal {
  return {
    type: "service",
    role: "agent",
    principalId: credential.credentialId,
    tenantId: credential.tenantId,
    projectId: credential.projectId,
    environmentId: credential.environmentId,
    serviceId: credential.serviceId,
  };
}

export function nativePrincipal(
  credential: NativeCredentialRecord,
): BrokerPrincipal {
  return {
    type: "native",
    role: "native-agent",
    principalId: credential.credentialId,
    tenantId: credential.tenantId,
    projectId: credential.projectId,
    environmentId: credential.environmentId,
    agentId: credential.agentId,
    allowedServiceIds: [...credential.allowedServiceIds],
  };
}

export function sharedPrincipal(
  principalId: "shared-key" | "development",
): BrokerPrincipal {
  return {
    type: "shared",
    role: "admin",
    principalId,
    ...DEFAULT_RESOURCE_SCOPE,
  };
}
