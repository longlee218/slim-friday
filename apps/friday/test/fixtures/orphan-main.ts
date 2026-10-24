import { eventually, workerHarness } from "../worker-harness";

/**
 * A main process for the orphan test: main plus one worker (settle wait 1 s) over the home in argv; the owner
 * sends a message whose run never settles; once it runs, prints `WORKER_PID <pid>` and waits to be killed.
 */
const home = process.argv[2] ?? "";
const h = await workerHarness(1, home, ["--settle-ms", "1000"]);
await h.send("stuck forever");
await eventually(async () => (await h.engine.wakes.inFlight())[0]?.status === "running");
process.stdout.write(`WORKER_PID ${h.app.workers?.handle(0)?.pid}\n`);
setInterval(() => {}, 1000);
