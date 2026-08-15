const ALLOW = new Set(["oui je confirme", "oui confirme", "je confirme", "yes i confirm", "yes confirm", "confirm"]);
const DENY = new Set(["non je refuse", "je refuse", "non annule", "no i deny", "deny", "no cancel"]);
function normalized(value) {
    return value
        .normalize("NFKD")
        .replaceAll(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replaceAll(/[’']/g, " ")
        .replaceAll(/[^\p{Letter}\p{Number}\s]/gu, " ")
        .replaceAll(/\s+/g, " ")
        .trim();
}
export class VoiceConfirmationController {
    confirmation = { type: "none" };
    ttlMs;
    constructor(ttlMs = 45_000) { this.ttlMs = ttlMs; }
    open(identity) {
        this.confirmation = { type: "pending", ...identity, expiresAt: Date.now() + this.ttlMs };
        return this.confirmation;
    }
    current() {
        if (this.confirmation.type === "pending" && this.confirmation.expiresAt <= Date.now()) {
            this.confirmation = { type: "none" };
        }
        return this.confirmation;
    }
    clear() { this.confirmation = { type: "none" }; }
    resolve(text, identity) {
        const pending = this.confirmation;
        if (pending.type === "none")
            return "none";
        if (pending.expiresAt <= Date.now()) {
            this.clear();
            return "expired";
        }
        if (pending.requestId !== identity.requestId ||
            pending.threadId !== identity.threadId ||
            pending.exactSummary !== identity.exactSummary)
            return "mismatch";
        const answer = normalized(text);
        if (ALLOW.has(answer)) {
            this.clear();
            return "allow";
        }
        if (DENY.has(answer)) {
            this.clear();
            return "deny";
        }
        if (/^(?:oui|yes) (?:valide|approve) (?:seulement|only) [\p{Letter}\p{Number} ]+$/u.test(answer)) {
            this.clear();
            return "allow";
        }
        return /\b(?:oui|yes|confirm|non|no|deny|refuse|annule|cancel)\b/u.test(answer) ? "ambiguous" : "none";
    }
}
