import type { Routine, RoutineInput, RoutineRun } from "../routines.ts";
import type { VoiceRoutineRequest } from "./contracts.ts";

type RoutinePort = {
  listRoutines(): Routine[];
  create(input: RoutineInput): Routine;
  update(id: string, patch: Partial<RoutineInput>): Routine | null;
  remove(id: string): boolean;
  runNow(id: string): RoutineRun | null;
};

type BotSummary = { id: string; name: string };

function normalized(value: string): string {
  return value.normalize("NFKD").replaceAll(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

export function manageVoiceRoutine(
  input: VoiceRoutineRequest,
  deps: { routines: RoutinePort; bot: (id: string) => BotSummary | undefined; now?: () => number },
): { ok: boolean; message: string } {
  const now = deps.now ?? Date.now;
  const targetId = input.targetId ?? "";
  const routineName = String(input.name ?? "").trim();
  const resolveRoutine = () => {
    if (!routineName) throw new Error("name the routine to manage");
    const matches = deps.routines.listRoutines().filter((routine) => normalized(routine.name) === normalized(routineName));
    if (!matches.length) throw new Error(`no routine named ${routineName}`);
    if (matches.length > 1) throw new Error(`several routines are named ${routineName}; rename one in the calendar first`);
    return matches[0]!;
  };
  if (input.action === "list") {
    const visible = deps.routines.listRoutines().filter((routine) => !targetId || routine.botId === targetId);
    return {
      ok: true,
      message: visible.length
        ? `Routines: ${visible.slice(0, 12).map((routine) => `${routine.name}, ${routine.enabled ? "active" : "paused"}`).join("; ")}.`
        : "There are no matching routines.",
    };
  }
  if (input.action === "create") {
    const bot = deps.bot(targetId);
    if (!bot) throw new Error("the selected agent does not exist");
    if (!routineName) throw new Error("give the routine a name");
    if (!input.prompt?.trim()) throw new Error("say what the routine must do");
    const schedule = input.scheduleType === "once"
      ? (() => {
          const at = Date.parse(input.at ?? "");
          if (!Number.isFinite(at) || at <= now()) throw new Error("give a future date and time with a timezone");
          return { type: "once" as const, at };
        })()
      : input.scheduleType === "daily"
        ? { type: "daily" as const, time: input.time ?? "", weekdays: input.weekdays ?? [0, 1, 2, 3, 4, 5, 6] }
        : (() => { throw new Error("choose a one-time or daily schedule"); })();
    const routine = deps.routines.create({ name: routineName, prompt: input.prompt, botId: bot.id, runOn: "maus", schedule });
    const when = routine.schedule.type === "once"
      ? new Date(routine.schedule.at).toLocaleString()
      : `${routine.schedule.time} on ${routine.schedule.weekdays.length === 7 ? "every day" : `weekdays ${routine.schedule.weekdays.join(", ")}`}`;
    return { ok: true, message: `Scheduled ${routine.name} with ${bot.name} at ${when}.` };
  }
  const routine = resolveRoutine();
  if (input.action === "pause" || input.action === "resume") {
    const enabled = input.action === "resume";
    deps.routines.update(routine.id, { enabled });
    return { ok: true, message: `${routine.name} is now ${enabled ? "active" : "paused"}.` };
  }
  if (input.action === "delete") {
    deps.routines.remove(routine.id);
    return { ok: true, message: `Deleted routine ${routine.name}.` };
  }
  const run = deps.routines.runNow(routine.id);
  if (!run) throw new Error("the routine could not be started");
  return { ok: true, message: `Started ${routine.name} now with ${deps.bot(routine.botId)?.name ?? "its agent"}.` };
}
