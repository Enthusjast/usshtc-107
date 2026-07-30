'use strict';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 7000;

function createShutdownCoordinator({
  stop,
  exit,
  onPrepare = () => {},
  onCleanupError = () => {},
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (typeof stop !== 'function' || typeof exit !== 'function') {
    throw new TypeError('stop and exit must be functions');
  }

  let started = false;
  let shutdownPromise = null;
  let exitCode = 0;
  let forceTimer = null;
  let exitRequested = false;

  const exitOnce = (code) => {
    if (exitRequested) return;
    exitRequested = true;
    exit(code);
  };

  const reportCleanupError = (error) => {
    exitCode = Math.max(exitCode, 1);
    try { onCleanupError(error); } catch (_) { /* shutdown must continue */ }
  };

  const request = (requestedExitCode = 0) => {
    const normalizedExitCode = Number.isInteger(requestedExitCode) && requestedExitCode > 0
      ? requestedExitCode
      : 0;
    exitCode = Math.max(exitCode, normalizedExitCode);

    if (!started) {
      started = true;
      try { onPrepare(); } catch (error) { reportCleanupError(error); }
    }
    if (shutdownPromise) return shutdownPromise;

    forceTimer = setTimer(() => exitOnce(Math.max(exitCode, 1)), timeoutMs);
    shutdownPromise = Promise.resolve()
      .then(stop)
      .then((result) => {
        if (result?.ok === false) {
          reportCleanupError(new Error(result.error || 'Shutdown cleanup failed'));
        }
      }, reportCleanupError)
      .finally(() => {
        if (forceTimer !== null) clearTimer(forceTimer);
        forceTimer = null;
        exitOnce(exitCode);
      });

    return shutdownPromise;
  };

  return {
    getExitCode: () => exitCode,
    isStarted: () => started,
    request,
  };
}

module.exports = {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  createShutdownCoordinator,
};
