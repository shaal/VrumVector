export async function waitForServer(origin, server, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Static server exited (${server.exitCode})`);
    try {
      const response = await fetch(origin, {signal:AbortSignal.timeout(1000)});
      if (response.ok) return;
    } catch (_) { /* the child process may not have bound the port yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Static server did not become ready: ${origin}`);
}
