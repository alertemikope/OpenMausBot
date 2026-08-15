export const DEFAULT_PROACTIVE_POLICY = {
    enabled: true,
    quietHours: { from: "22:00", to: "07:00" },
    vipSenders: [],
    mutedRules: [],
    channels: ["dock", "system"],
    maxInterruptionsPerHour: 4,
    dedupeWindowMinutes: 60,
    requireConfirmationForActions: true,
    sources: { work: true, routine: true, calendar: false, gmail: false, pennylane: false, ci: false },
};
function minuteOfDay(value) {
    const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}
export function inQuietHours(policy, at) {
    const from = minuteOfDay(policy.quietHours.from);
    const to = minuteOfDay(policy.quietHours.to);
    if (from == null || to == null || from === to)
        return false;
    const date = new Date(at);
    const minute = date.getHours() * 60 + date.getMinutes();
    return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}
export function deliveryChannels(policy, at, interruptionsLastHour, voiceAvailable = false) {
    if (!policy.enabled)
        return { channels: [], reason: "Proactive notifications are disabled" };
    const quiet = inQuietHours(policy, at);
    const atLimit = interruptionsLastHour >= policy.maxInterruptionsPerHour;
    const channels = ["dock", ...policy.channels].filter((channel, index, all) => {
        if (all.indexOf(channel) !== index)
            return false;
        if (channel === "dock")
            return true;
        if (channel === "voice" && !voiceAvailable)
            return false;
        return !quiet && !atLimit;
    });
    if (!channels.length)
        return { channels, reason: quiet ? "Suppressed by quiet hours" : atLimit ? "Hourly interruption limit reached" : "No delivery channel enabled" };
    if (quiet)
        return { channels, reason: "Delivered silently to Mission Control during quiet hours" };
    if (atLimit)
        return { channels, reason: "Delivered silently to Mission Control after the hourly interruption limit" };
    if (policy.channels.includes("voice") && !voiceAvailable) {
        return { channels, reason: "Delivered without voice because there is no active voice session" };
    }
    return { channels, reason: "Delivered by the configured proactive policy" };
}
export function normalizePolicy(value) {
    const channels = Array.isArray(value.channels)
        ? [...new Set(value.channels.filter((channel) => ["dock", "system", "voice"].includes(channel)))]
        : DEFAULT_PROACTIVE_POLICY.channels;
    const quietFrom = minuteOfDay(value.quietHours?.from ?? "") == null ? DEFAULT_PROACTIVE_POLICY.quietHours.from : value.quietHours.from;
    const quietTo = minuteOfDay(value.quietHours?.to ?? "") == null ? DEFAULT_PROACTIVE_POLICY.quietHours.to : value.quietHours.to;
    const sources = { ...DEFAULT_PROACTIVE_POLICY.sources };
    for (const source of Object.keys(sources)) {
        if (typeof value.sources?.[source] === "boolean")
            sources[source] = value.sources[source];
    }
    return {
        ...DEFAULT_PROACTIVE_POLICY,
        ...value,
        enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_PROACTIVE_POLICY.enabled,
        quietHours: { from: quietFrom, to: quietTo },
        channels,
        vipSenders: Array.isArray(value.vipSenders) ? value.vipSenders.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean).slice(0, 100) : [],
        mutedRules: Array.isArray(value.mutedRules) ? [...new Set(value.mutedRules.map(String).map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, 500) : [],
        maxInterruptionsPerHour: Math.max(0, Math.min(20, Math.round(value.maxInterruptionsPerHour ?? DEFAULT_PROACTIVE_POLICY.maxInterruptionsPerHour))),
        dedupeWindowMinutes: Math.max(1, Math.min(24 * 60, Math.round(value.dedupeWindowMinutes ?? DEFAULT_PROACTIVE_POLICY.dedupeWindowMinutes))),
        requireConfirmationForActions: true,
        sources,
    };
}
