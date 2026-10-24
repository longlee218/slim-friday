/**
 * A stand-in worker for the process-group test: starts a long `sleep` child (an SDK child stand-in), sends
 * its pid over IPC and waits to be killed.
 */
const sleeper = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
process.send?.({ sleeper: sleeper.pid });
setInterval(() => {}, 1000);
