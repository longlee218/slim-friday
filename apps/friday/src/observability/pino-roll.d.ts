/** pino-roll ships no types: only the options this app uses. */
declare module "pino-roll" {
  /** Opens a rolling file stream (sonic-boom); options not listed here are passed to sonic-boom. */
  export default function pinoRoll(options: {
    file: string;
    frequency?: "daily" | "hourly" | number;
    dateFormat?: string;
    limit?: { count: number };
    sync?: boolean;
    mode?: number;
  }): Promise<{ write(line: string): unknown; end(): void }>;
}
