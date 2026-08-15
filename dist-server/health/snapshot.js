function finding(code, severity, message, action) {
    return { code, severity, message, action };
}
function level(hasError, hasWarning) {
    return hasError ? "error" : hasWarning ? "warning" : "ok";
}
/** Build a bounded, content-free health projection. Inputs are counts and
 * booleans owned by each subsystem; prompts, results and provider errors never
 * cross this diagnostic boundary. */
export function buildRuntimeHealthSnapshot(input) {
    const findings = [];
    if (input.providers.loaded === 0) {
        findings.push(finding("providers.none_loaded", "error", "No agent provider is loaded.", "Open Settings and install or select an available provider."));
    }
    else if (input.providers.configured > input.providers.loaded) {
        const unavailable = input.providers.configured - input.providers.loaded;
        findings.push(finding("providers.unavailable", "warning", `${unavailable} configured provider${unavailable === 1 ? " is" : "s are"} unavailable.`, "Open the model picker to inspect availability or select another provider."));
    }
    if (input.work.stale > 0) {
        findings.push(finding("work.stale", "warning", `${input.work.stale} active work item${input.work.stale === 1 ? " has" : "s have"} no recent activity.`, "Open Mission Control, inspect the owner, then steer or cancel it explicitly."));
    }
    if (input.work.cancellationStuck > 0) {
        findings.push(finding("work.cancellation_stuck", "warning", `${input.work.cancellationStuck} cancellation request${input.work.cancellationStuck === 1 ? " is" : "s are"} still pending.`, "Open Mission Control and verify the provider process before retrying."));
    }
    if (!input.routines.schedulerRunning) {
        findings.push(finding("routines.scheduler_stopped", "error", "The routine scheduler is not running.", "Restart OpenMausBot and verify Runtime health again."));
    }
    if (input.routines.overdue > 0) {
        findings.push(finding("routines.overdue", "warning", `${input.routines.overdue} enabled routine${input.routines.overdue === 1 ? " is" : "s are"} overdue.`, "Open Routines to inspect the schedule and its latest receipt."));
    }
    const providerUnavailable = Math.max(0, input.providers.configured - input.providers.loaded);
    const providerError = input.providers.loaded === 0;
    const workWarning = input.work.stale > 0 || input.work.cancellationStuck > 0;
    const routineError = !input.routines.schedulerRunning;
    const routineWarning = input.routines.overdue > 0;
    return {
        app: "openmausbot",
        pid: input.pid,
        static: input.static,
        status: findings.length ? "degraded" : "ready",
        checkedAt: input.checkedAt,
        uptimeSeconds: Math.max(0, Math.floor(input.uptimeSeconds)),
        components: {
            providers: {
                level: level(providerError, providerUnavailable > 0),
                configured: input.providers.configured,
                loaded: input.providers.loaded,
                unavailable: providerUnavailable,
            },
            work: { level: level(false, workWarning), ...input.work },
            routines: { level: level(routineError, routineWarning), ...input.routines },
            proactivity: {
                level: input.proactivity.enabled ? "ok" : "disabled",
                ...input.proactivity,
            },
            voice: { level: input.voiceActive ? "ok" : "disabled", active: input.voiceActive },
            integrations: { level: "ok", ...input.integrations },
        },
        findings,
    };
}
