import { contract, listProcedurePaths } from "@friday/contracts";
import { authed } from "./implementer";

/** The router shape `authed.router` accepts. */
export type AppRouterInput = Parameters<typeof authed.router>[0];

/** Handlers built by `stubRouter`, so `stubbedProcedures` can tell a stub from a real handler. */
export const stubHandlers = new WeakSet<object>();

/** A router or procedure node, loosely typed for the dot-path walk below. */
export interface LooseNode {
  [key: string]: LooseNode;
}

/** The thrower a stub handler receives from oRPC. */
type StubOptions = { errors: { NOT_IMPLEMENTED: () => Error } };

/** A nested router (`config.bots.list` -> `{ config: { bots: { list } } }`) where every procedure answers 501. */
export function stubRouter(): AppRouterInput {
  const root: LooseNode = {};
  for (const path of listProcedurePaths(contract)) {
    const keys = path.split(".");
    const leaf = keys.pop() as string;
    let node = root;
    for (const k of keys) node = node[k] ??= {};
    const builder = keys
      .concat(leaf)
      .reduce<LooseNode>((o, k) => o[k as keyof typeof o], authed as unknown as LooseNode);
    const handler = ({ errors }: StubOptions): never => {
      throw errors.NOT_IMPLEMENTED();
    };
    stubHandlers.add(handler);
    node[leaf] = (builder as unknown as { handler: (h: typeof handler) => LooseNode }).handler(
      handler,
    );
  }
  return root as unknown as AppRouterInput;
}
