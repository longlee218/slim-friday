import { type AnyContractRouter, isContractProcedure } from "@orpc/contract";

/** Dot paths of every procedure (leaf) of a contract router, sorted. */
export function listProcedurePaths(router: AnyContractRouter, prefix = ""): string[] {
  if (isContractProcedure(router)) return [prefix];
  const paths = Object.entries(router).flatMap(([key, child]) =>
    listProcedurePaths(child as AnyContractRouter, prefix ? `${prefix}.${key}` : key),
  );
  return prefix ? paths : paths.sort();
}
