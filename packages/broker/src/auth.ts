import { createHash, randomBytes } from "node:crypto";

import {
  DEFAULT_ENVIRONMENT_ID,
  DEFAULT_PROJECT_ID,
  DEFAULT_TENANT_ID,
} from "./store/migrations.js";

export const SERVICE_API_KEY_PREFIX = "lp_service_";

export interface ResourceScope {
  tenantId: string;
  projectId: string;
  environmentId: string;
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

export type BrokerPrincipal =
  | (ResourceScope & {
      type: "shared";
      principalId: "shared-key" | "development";
      role: "operator";
    })
  | (ResourceScope & {
      type: "service";
      principalId: string;
      role: "agent";
      serviceId: string;
    });

export interface ServiceCredentialMaterial {
  apiKey: string;
  record: StoredServiceCredential;
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

export function sharedPrincipal(
  principalId: "shared-key" | "development",
): BrokerPrincipal {
  return {
    type: "shared",
    role: "operator",
    principalId,
    ...DEFAULT_RESOURCE_SCOPE,
  };
}
