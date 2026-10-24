import type { OwnerAuth } from "./owner-auth";

/** Create the owner user at boot when missing (magic link sign-up is disabled). */
export async function ensureOwner(auth: OwnerAuth, email: string): Promise<"created" | "exists"> {
  const { internalAdapter } = await auth.$context;
  if (await internalAdapter.findUserByEmail(email, { includeAccounts: false })) return "exists";
  await internalAdapter.createUser(
    { email, name: "Owner", emailVerified: true },
    { method: "admin" },
  );
  return "created";
}
