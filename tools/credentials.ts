import { z } from "zod";
import {
  credentialsStore,
  type CredentialScope,
} from "../security/credentials.ts";
import type { ToolDefinition } from "./runtime-tools.ts";

const scopeSchema = z
  .enum(["app", "skill"])
  .describe(
    "credential scope: app for integrations, skill for skill-specific secrets",
  );

const saveCredentialSchema = z.object({
  scope: scopeSchema,
  owner: z
    .string()
    .describe("integration or skill name that owns this credential"),
  name: z
    .string()
    .describe("credential name like api_key, client_secret, or access_token"),
  value: z.string().describe("credential secret value to encrypt and store"),
  description: z
    .string()
    .optional()
    .describe("optional note about what this credential is used for"),
});

const getCredentialSchema = z.object({
  scope: scopeSchema,
  owner: z
    .string()
    .describe("integration or skill name that owns this credential"),
  name: z.string().describe("credential name to retrieve"),
});

const deleteCredentialSchema = z.object({
  scope: scopeSchema,
  owner: z
    .string()
    .describe("integration or skill name that owns this credential"),
  name: z.string().describe("credential name to delete"),
});

const listCredentialsSchema = z.object({
  scope: scopeSchema
    .optional()
    .describe("optional scope filter to limit results"),
  owner: z
    .string()
    .optional()
    .describe("optional owner filter to list one integration or skill only"),
  limit: z
    .number()
    .optional()
    .describe("maximum credentials to return default 50 max 200"),
});

function ensureStoreAvailable(): string | null {
  const status = credentialsStore.isAvailable();
  if (status.ok) {
    return null;
  }

  return `[Credentials] Store unavailable: ${status.reason}. Set CRUSTY_CREDENTIALS_MASTER_KEY to enable encrypted credential storage.`;
}

async function handleSaveCredential(
  args: {
    scope: CredentialScope;
    owner: string;
    name: string;
    value: string;
    description?: string;
  },
  userId: number,
): Promise<string> {
  const unavailable = ensureStoreAvailable();
  if (unavailable) {
    return unavailable;
  }

  const metadata = await credentialsStore.upsertCredential(
    userId,
    args.scope,
    args.owner,
    args.name,
    args.value,
    args.description,
  );

  return `[Credentials] Saved ${metadata.scope}/${metadata.owner}/${metadata.name}. Stored encrypted at rest.`;
}

async function handleGetCredential(
  args: {
    scope: CredentialScope;
    owner: string;
    name: string;
  },
  userId: number,
): Promise<string> {
  const unavailable = ensureStoreAvailable();
  if (unavailable) {
    return unavailable;
  }

  const credential = await credentialsStore.getCredential(
    userId,
    args.scope,
    args.owner,
    args.name,
  );

  if (!credential) {
    return `[Credentials] Not found: ${args.scope}/${args.owner}/${args.name}`;
  }

  return `[Credentials] ${credential.scope}/${credential.owner}/${credential.name}\nvalue: ${credential.value}`;
}

async function handleDeleteCredential(
  args: {
    scope: CredentialScope;
    owner: string;
    name: string;
  },
  userId: number,
): Promise<string> {
  const unavailable = ensureStoreAvailable();
  if (unavailable) {
    return unavailable;
  }

  const deleted = await credentialsStore.deleteCredential(
    userId,
    args.scope,
    args.owner,
    args.name,
  );

  if (!deleted) {
    return `[Credentials] Not found: ${args.scope}/${args.owner}/${args.name}`;
  }

  return `[Credentials] Deleted ${args.scope}/${args.owner}/${args.name}`;
}

async function handleListCredentials(
  args: {
    scope?: CredentialScope;
    owner?: string;
    limit?: number;
  },
  userId: number,
): Promise<string> {
  const unavailable = ensureStoreAvailable();
  if (unavailable) {
    return unavailable;
  }

  const credentials = await credentialsStore.listCredentials(userId, {
    scope: args.scope,
    owner: args.owner,
    limit: args.limit,
  });

  if (credentials.length === 0) {
    return `[Credentials] No stored credentials found.`;
  }

  const lines = credentials.map((credential) => {
    const accessed = credential.lastAccessedAt
      ? `, last used ${new Date(credential.lastAccessedAt).toISOString()}`
      : "";
    const description = credential.description
      ? `\n  note: ${credential.description}`
      : "";

    return `- ${credential.scope}/${credential.owner}/${credential.name} (updated ${new Date(credential.updatedAt).toISOString()}${accessed})${description}`;
  });

  return `[Credentials] Stored credential metadata (${credentials.length}):\n${lines.join("\n")}`;
}

export const credentialTools: Record<string, ToolDefinition> = {
  save_credential: {
    description:
      "save a credential for an app or skill in the encrypted credentials store for later secure retrieval",
    schema: saveCredentialSchema,
    handler: handleSaveCredential,
  },
  get_credential: {
    description:
      "retrieve and decrypt a credential for an app or skill when a tool or workflow needs it",
    schema: getCredentialSchema,
    handler: handleGetCredential,
  },
  delete_credential: {
    description: "delete a credential from the encrypted credentials store",
    schema: deleteCredentialSchema,
    handler: handleDeleteCredential,
  },
  list_credentials: {
    description:
      "list stored credential metadata without exposing secret values",
    schema: listCredentialsSchema,
    handler: handleListCredentials,
  },
};
