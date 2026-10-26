import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { RouteObject } from "react-router";
import { useLocation, useNavigate, useNavigationType, useRoutes } from "react-router";
import { ScreenBoundary } from "../../app/route-error";
import { useConnection } from "../../app/shell-context";
import { ConnectionBanner } from "../shell/connection-banner";
import { ToolWarningBanner } from "../shell/tool-warning-banner";
import { useEdgeSwipe } from "./edge-swipe";
import { backLabel, phoneStackFor, phoneStackReduce, tabOf } from "./phone-stack";
import { TabBar } from "./tab-bar";

/** How long a popped view keeps sliding out before it unmounts (matches `.ios-view.leave`). */
const LEAVE_MS = 320;

interface StackState {
  /** Location key this state was computed for. */
  key: string;
  stack: string[];
  /** Entries on top of the seeded ones that were pushed by the router (they have history to pop). */
  pushed: number;
  /** The view sliding out after a pop. */
  leaving: { index: number; path: string } | null;
  /** The top view was just pushed (plays the push animation). */
  entering: boolean;
}

const isPrefix = (a: string[], of: string[]) => a.every((p, i) => p === of[i]);

/** Folds one router navigation into the stack state. */
function advance(
  s: StackState,
  key: string,
  type: "PUSH" | "POP" | "REPLACE",
  path: string,
): StackState {
  const stack = phoneStackReduce(s.stack, { type, path });
  const popped = stack.length < s.stack.length && isPrefix(stack, s.stack);
  const appended = stack.length === s.stack.length + 1 && isPrefix(s.stack, stack);
  let pushed = 0; // a tab switch or reseed leaves nothing to pop
  if (popped) pushed = Math.max(0, s.pushed - (s.stack.length - stack.length));
  else if (appended) pushed = type === "PUSH" ? s.pushed + 1 : s.pushed;
  else if (stack.length === s.stack.length && stack.length > 1) pushed = s.pushed;
  return {
    key,
    stack,
    pushed,
    leaving: popped ? { index: s.stack.length - 1, path: s.stack.at(-1) ?? "" } : null,
    entering: appended,
  };
}

interface PhoneStackValue {
  stack: string[];
  /** Pop the top view: `navigate(-1)` when it was pushed here, else step to the entry under it. */
  back(): void;
}
const StackContext = createContext<PhoneStackValue>({ stack: [], back: () => {} });
/** Position of the view being rendered in the stack (0 = tab root). */
const ViewContext = createContext(0);

/** The navigation stack and its back action. */
export const usePhoneStack = (): PhoneStackValue => useContext(StackContext);

/** Back label of the view being rendered, or undefined for a tab root. */
export function useBackLabel(): string | undefined {
  const { stack } = usePhoneStack();
  const index = useContext(ViewContext);
  return index > 0 ? backLabel(stack.slice(0, index + 1)) : undefined;
}

/** Position of the view being rendered in the stack. */
export const useViewIndex = (): number => useContext(ViewContext);

/** Renders the route that matches `path` (not the browser location), so under views keep their screen. */
// useRoutes under the pathless layout logs a dev-only "no trailing *" warning; harmless.
function Screen({ routes, path }: { routes: RouteObject[]; path: string }) {
  return useRoutes(routes, path);
}

/**
 * Phone layout: a navigation stack driven by router navigation (PUSH / POP / REPLACE), a tab
 * bar and the edge swipe. Only the top two entries are mounted (plus a view sliding out): the
 * top slides over the one under it, which shifts -28% and dims. A tab switch resets the stack.
 */
export function PhoneShell({ routes }: { routes: RouteObject[] }) {
  const { pathname, search, key } = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  const connection = useConnection();
  const [s, setS] = useState<StackState>(() => ({
    key,
    stack: phoneStackFor(pathname),
    pushed: 0,
    leaving: null,
    entering: false,
  }));
  // Derive the next state while rendering, so the first paint at a new location is already right.
  let state = s;
  if (s.key !== key) {
    state = advance(s, key, type, pathname);
    setS(state);
  }
  const { stack, leaving } = state;

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setS((x) => ({ ...x, leaving: null })), LEAVE_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  const latest = useRef(state);
  latest.current = state;
  const back = useCallback(() => {
    const { stack, pushed } = latest.current;
    if (stack.length < 2) return;
    if (pushed > 0) void navigate(-1);
    else void navigate(stack[stack.length - 2], { replace: true });
  }, [navigate]);

  const root = useRef<HTMLDivElement>(null);
  useEdgeSwipe(root, stack.length > 1, back);

  const lo = Math.max(0, stack.length - 2);
  const views = stack.slice(lo).map((path, i) => ({ path, index: lo + i, leave: false }));
  if (leaving) views.push({ ...leaving, leave: true });

  return (
    <StackContext.Provider value={{ stack, back }}>
      <div className="ios" ref={root}>
        {views.map(({ path, index, leave }) => {
          const top = index === stack.length - 1 && !leave;
          const cls = [
            "ios-view",
            index > 0 && "pushed",
            leave && "leave",
            !leave && !(top && index > 0) && "under",
            !leave && !top && "shift",
            top && index > 0 && state.entering && "enter",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div key={`${index}:${path}`} className={cls} inert={!top}>
              <ViewContext.Provider value={index}>
                <ScreenBoundary>
                  {/* The top view also gets the query (`?new=1` opens a sheet). */}
                  <Screen routes={routes} path={top && path === pathname ? path + search : path} />
                </ScreenBoundary>
              </ViewContext.Provider>
            </div>
          );
        })}
        <div className="ios-banner">
          <ConnectionBanner state={connection} />
          <ToolWarningBanner />
        </div>
        <TabBar active={tabOf(stack[0])} hidden={stack.length > 1} />
      </div>
    </StackContext.Provider>
  );
}
