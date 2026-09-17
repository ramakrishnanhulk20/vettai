import { isTreasuryProcess } from './config.js'

/**
 * The one thing the container starts.
 *
 * Node is then PID 1, so SIGTERM from the host reaches the shutdown handlers in the world
 * and the treasury instead of dying in a shell wrapper. Which of the two runs is read from
 * VETTAI_PROCESS, exactly as the rest of the server reads it, so the world can never be
 * started with the treasury's environment by accident.
 */
if (isTreasuryProcess(process.env)) {
  const { runTreasury } = await import('./treasury/index.js')
  await runTreasury()
  process.exit(0)
}

await import('./index.js')
