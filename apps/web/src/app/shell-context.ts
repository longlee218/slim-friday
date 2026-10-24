import { createContext, useContext } from "react";
import type { ConnectionState } from "../events/use-event-stream";

/** Opens the command palette (sidebar New chat / search, ⌘K, phone New chat). */
export const PaletteContext = createContext<() => void>(() => {});
/** Connection state of the one event stream `ResponsiveRoot` keeps open. */
export const ConnectionContext = createContext<ConnectionState>("live");

/** The opener of the command palette. */
export const useOpenPalette = (): (() => void) => useContext(PaletteContext);
/** State of the event stream, for the connection banners. */
export const useConnection = (): ConnectionState => useContext(ConnectionContext);
