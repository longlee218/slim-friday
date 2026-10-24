/** Where the engine reports what it does. One line per event: `msg` is the event name, `o` its fields. */
export interface Log {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
  error(o: object, msg: string): void;
}
