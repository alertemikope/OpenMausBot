const STATUS = /^(?:où\s+(?:tu\s+)?en\s+es|quel\s+est\s+(?:le\s+)?statut|what(?:'s| is)\s+(?:the\s+)?(?:status|progress)|how(?:'s| is)\s+it\s+going)[\s?!.]*$/iu;
const CANCEL = /^(?:annule|arrête|stoppe|cancel|abort|stop)(?:\s+(?:cette|la|le|this|the|tout|all|current|active))*\s+(?:tâche|travail|tour|task|work|run|tout|all)[\s?!.]*$/iu;
const FOLLOWUP = /^(?:après\s+(?:ça|cela)|ensuite|quand\s+(?:tu\s+)?(?:auras\s+)?fini|when\s+(?:you(?:'re| are)\s+)?done|after\s+(?:that|this))[,\s:-]+(.+)$/iu;
const STEER = /^(?:ne\s+.+\s+(?:plus|pas).*(?:plutôt|seulement|uniquement|regarde|vérifie)|(?:utilise|regarde|vérifie).+(?:plutôt\s+que|au\s+lieu\s+de)|(?:use|check|look\s+at).+(?:instead\s+of|rather\s+than|only))/iu;
export function classifyAgentControl(input) {
    const text = input.trim();
    if (!text || text.length > 2_000)
        return null;
    const marked = /^\[OPENMAUS_CONTROL:(status|cancel|steer|followup)\]\s*([\s\S]*)$/iu.exec(text);
    if (marked) {
        const mode = marked[1].toLowerCase();
        const markedText = marked[2].trim();
        return markedText ? { mode, text: markedText } : null;
    }
    if (STATUS.test(text))
        return { mode: "status", text };
    if (CANCEL.test(text))
        return { mode: "cancel", text };
    const followup = FOLLOWUP.exec(text);
    if (followup?.[1]?.trim())
        return { mode: "followup", text: followup[1].trim() };
    if (STEER.test(text))
        return { mode: "steer", text };
    return null;
}
