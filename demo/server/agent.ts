import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { Ctx, ImportService, ImportView } from "@distru/csv-importer/core";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  importId?: string;
  createdAt: string;
}

/**
 * Rule-based stand-in for the Copilot agent. It decides which tool to call from simple rules; the tools,
 * gates and state are the real ones. A "yes" is relayed to the gate tool with the confirming message id.
 */
export function createAgent(deps: { importer: ImportService; tools: StructuredToolInterface[]; ctx: Ctx; persistPath?: string }) {
  const threads = new Map<string, ChatMessage[]>();
  const lastFile = new Map<string, { id: string; name: string }>();
  let seq = 0;
  // The demo keeps chat in memory; a JSON file lets it survive server restarts (tsx watch restarts on every edit).
  if (deps.persistPath) {
    try {
      const saved = JSON.parse(readFileSync(deps.persistPath, "utf8")) as { seq: number; threads: [string, ChatMessage[]][]; lastFile: [string, { id: string; name: string }][] };
      seq = saved.seq;
      for (const [k, v] of saved.threads) threads.set(k, v);
      for (const [k, v] of saved.lastFile) lastFile.set(k, v);
    } catch { /* first run */ }
  }
  const save = () => {
    if (!deps.persistPath) return;
    // Write then rename, so a restart mid-write can't leave a truncated file that silently resets the chat.
    try {
      writeFileSync(`${deps.persistPath}.tmp`, JSON.stringify({ seq, threads: [...threads], lastFile: [...lastFile] }));
      renameSync(`${deps.persistPath}.tmp`, deps.persistPath);
    } catch (e) { console.error("[chat] save failed", e); }
  };
  const tool = (name: string) => deps.tools.find((t) => t.name === name)!;
  const thread = (id: string) => threads.get(id) ?? threads.set(id, []).get(id)!;
  const post = (threadId: string, role: ChatMessage["role"], text: string, importId?: string) => {
    const m = { id: ++seq, role, text, importId, createdAt: new Date().toISOString() };
    thread(threadId).push(m);
    save();
    return m;
  };
  const activeImport = (threadId: string) => [...thread(threadId)].reverse().find((m) => m.importId)?.importId;
  const call = async (name: string, args: Record<string, unknown>, threadId: string, userMessageId?: number) =>
    JSON.parse(String(await tool(name).invoke(args, { configurable: { ...deps.ctx, threadId, userMessageId: userMessageId ? `msg_${userMessageId}` : undefined } })));

  const lastSystem = new Map<string, string>();
  const llmState = () => (deps.importer.stageEnabled("llm") ? "on" : "off");

  return {
    messages: (threadId: string) => thread(threadId),

    async userTurn(threadId: string, text: string, attachmentIn?: { id: string; name: string }): Promise<ChatMessage[]> {
      let attachment = attachmentIn;
      const out: ChatMessage[] = [];
      const user = post(threadId, "user", attachment ? `${text ? text + "\n" : ""}📎 ${attachment.name}` : text);
      out.push(user);
      const say = (t: string, importId?: string) => out.push(post(threadId, "assistant", t, importId));
      try {
        const cmd = text.trim().toLowerCase();
        // Demo switches for comparing runs with and without the LLM step.
        const sw = /^(?:llm|llm step)\s+(on|off|status)$/.exec(cmd);
        if (sw) {
          if (sw[1] !== "status") deps.importer.setStageEnabled("llm", sw[1] === "on");
          say(`The LLM step is ${llmState()}${sw[1] === "status" ? "" : " for new imports"}. ${lastFile.has(threadId) ? 'Say "rerun" to run the last file again with this setting.' : "Drop a file to try it."}`);
          return out;
        }
        if (/^(rerun|run again|run it again|again)$/.test(cmd)) {
          const file = lastFile.get(threadId);
          if (!file) { say("Drop a file first, then I can run it again."); return out; }
          const prev = activeImport(threadId);
          if (prev) {
            const pv = await call("import_csv_get", { importId: prev }, threadId);
            if (["queued", "mapping_review", "commit_review"].includes(pv.status)) await call("import_csv_cancel", { importId: prev }, threadId, user.id);
          }
          attachment = file;
          say(`Running ${file.name} again with the LLM step ${llmState()}.`);
        }
        if (attachment) {
          lastFile.set(threadId, attachment);
          save();
          const r = await call("import_csv_start", { attachmentId: attachment.id }, threadId, user.id);
          say(r.reused ? `This file is already open in an import. Picking it back up.` : `Reading ${attachment.name}. I'll map the columns and check them against your catalog.`, r.importId);
          return out;
        }
        const importId = activeImport(threadId);
        if (!importId) { say("Drop a CSV or XLSX of your products here and I'll import it."); return out; }
        const v = await call("import_csv_get", { importId }, threadId);
        const t = text.trim().toLowerCase();
        const atGate1 = v.status === "mapping_review";
        const atGate2 = v.status === "commit_review";
        const revise = async (args: Record<string, unknown>) => {
          const r = await call("import_csv_revise", { importId, planVersion: v.planVersion, ...args }, threadId, user.id);
          const after = await call("import_csv_get", { importId }, threadId);
          return { r, after };
        };

        // A gate is passed only by a message that is nothing but the confirmation. "yes, but ignore Notes" and
        // "import only the new ones" are edits and go to the revise path below.
        if (/^(yes|y|yep|yeah|ok|okay|confirm|looks good|go|go ahead|import( it)?|do it)[\s.!]*$/.test(t)) {
          if (atGate1) {
            if (v.blockingQuestions) { say(`I need ${v.blockingQuestions} answer(s) first.\n\n${questionList(v)}`); return out; }
            await call("import_csv_confirm_mapping", { importId, planVersion: v.planVersion }, threadId, user.id);
            say("Mapping confirmed. Checking every row and looking for duplicates.");
          } else if (atGate2) {
            await call("import_csv_confirm_commit", { importId, planVersion: v.planVersion }, threadId, user.id);
            say("Importing now. The card shows progress; you can leave and come back.");
          } else say(`Nothing to confirm right now (status: ${v.status.replace(/_/g, " ")}).`);
          return out;
        }
        if (/^(cancel|stop|abort)( (it|this|the import|import))?[\s.!]*$/.test(t)) {
          await call("import_csv_cancel", { importId }, threadId, user.id);
          lastSystem.set(threadId, `${importId}:cancelled`); // the harness turn for this cancel would repeat it
          say("Cancelled. Nothing was written to Distru.", importId);
          return out;
        }
        if (/^(status|where are we|\?)$/.test(t)) { say(describe(v)); return out; }
        if (/^(help|what (do )?you need|what'?s (left|needed|open|missing|next)|(any |open |show )?questions?|tell me what( you need)?|what now|next)[\s?.!]*$/.test(t)) {
          if (atGate1) say(v.openQuestions.length ? questionList(v) : `Nothing open. ${describe(v)}`);
          else if (atGate2) say(`${describe(v)}\n\n${problems(v)}\n\nYou can say "update existing", "skip existing", "clear blanks on/off", "set row 6 name to Blue Dream", or "yes".`);
          else say(describe(v));
          return out;
        }
        if (/^(show |list )?(the )?(mapping|mappings|columns)$/.test(t)) {
          say(`Mapped:\n${v.mapped.map((m: string) => `- ${m}`).join("\n")}${v.ignored.length ? `\n\nIgnored:\n${v.ignored.map((m: string) => `- ${m}`).join("\n")}` : ""}${v.defaults.length ? `\n\nDefaults:\n${v.defaults.map((m: string) => `- ${m}`).join("\n")}` : ""}\n\nChange one with "map <column> to <field>", "ignore <column>" or "set <field> to <value>".`);
          return out;
        }
        if (/^(show |list )?(the )?(problems|errors|invalid( rows)?|issues)$/.test(t)) { say(problems(v)); return out; }

        if (atGate1) {
          // Answer numbered questions: "1b", "2: Kiva", "accept 3", "accept all".
          const qs = v.openQuestions as { id: string; prompt: string; suggested: string | null; guess: { score: number } | null; options: { id: string; label: string }[] }[];
          let skippedLow = 0;
          let answers: Record<string, string> | null = null;
          let m = /^(\d+)\s*([a-z])$/.exec(t);
          if (m && qs[+m[1] - 1]?.options[m[2].charCodeAt(0) - 97]) answers = { [qs[+m[1] - 1].id]: qs[+m[1] - 1].options[m[2].charCodeAt(0) - 97].id };
          m = /^accept\s+(\d+)$/.exec(t);
          if (!answers && m && qs[+m[1] - 1]?.suggested) answers = { [qs[+m[1] - 1].id]: qs[+m[1] - 1].suggested! };
          if (!answers && /^(accept|use)\s+(all|suggestions|the suggestions|everything)[\s.!]*$/.test(t)) {
            // Low-confidence model guesses (< 40%) are never bulk-accepted.
            const ok = qs.filter((q) => q.suggested && !(q.guess && q.guess.score < 0.4));
            skippedLow = qs.filter((q) => q.suggested && q.guess && q.guess.score < 0.4).length;
            answers = Object.fromEntries(ok.map((q) => [q.id, q.suggested!]));
          }
          m = /^(\d+)\s*[:=)\-]\s*(.+)$/.exec(text.trim());
          if (!answers && m && qs[+m[1] - 1]) {
            const q = qs[+m[1] - 1];
            const want = m[2].trim().toLowerCase();
            const opt = q.options.find((o) => o.label.toLowerCase() === want) ?? q.options.find((o) => o.label.toLowerCase().includes(want));
            if (opt) answers = { [q.id]: opt.id };
            else if (q.id.startsWith("slang:")) answers = { [q.id]: m[2].trim() };
            else { say(`"${m[2].trim()}" isn't one of the options for question ${m[1]}. Options: ${q.options.map((o) => o.label).join(", ")}.`); return out; }
          }
          if (answers && !Object.keys(answers).length) {
            say(skippedLow ? `Nothing to accept in bulk: the ${skippedLow} open guess${skippedLow === 1 ? " is" : "es are"} low-confidence, so check ${skippedLow === 1 ? "it" : "them"} one by one.\n\n${questionList(v)}` : `Nothing is waiting for an answer. Say "yes" to confirm the mapping.`);
            return out;
          }
          if (answers) {
            const { after } = await revise({ answers });
            const low = skippedLow ? ` I left ${skippedLow} low-confidence guess${skippedLow === 1 ? "" : "es"} for you to check.` : "";
            say(`Got it: answered ${Object.keys(answers).length} question(s).${low}${after.openQuestions.length ? `\n\n${questionList(after)}` : ` Nothing else is open. Say "yes" to confirm the mapping.`}`);
            return out;
          }
        }

        if (atGate2) {
          let gate2: Record<string, unknown> | null = null;
          if (/\b(don'?t|do not|never|not)\b/.test(t) && /\b(update|skip)\b/.test(t)) {
            say('To be safe I changed nothing. Say "update existing" or "skip existing".');
            return out;
          }
          if (/\bupdate (the )?(existing|changed|changes)\b/.test(t)) gate2 = { existingAction: "update" };
          else if (/\bskip (the )?(existing|changed|changes)\b/.test(t)) gate2 = { existingAction: "skip" };
          else if (/blank/.test(t) && /(off|don'?t|do not|disable|no)\b/.test(t)) gate2 = { clearBlanks: false };
          else if (/blank/.test(t) && /(clear|on|enable|yes)\b/.test(t)) gate2 = { clearBlanks: true };
          const m = /^(?:set|fix|change)\s+row\s+(\d+)(?:'s)?\s+(.+?)\s+to\s+(.+)$/i.exec(text.trim());
          if (gate2 || m) {
            const { after } = await revise(m ? { edits: [{ row: +m[1], field: m[2], value: m[3].replace(/^["']|["']$/g, "") }] } : { gate2 });
            say(m ? `Updated row ${m[1]}. ${describe(after)}` : `Done. ${describe(after)}`);
            return out;
          }
        }

        if (!atGate1 && !atGate2) { say(`I can change things at a review step. Right now the import is ${v.status.replace(/_/g, " ")}.`); return out; }
        const { r, after } = await revise({ instruction: text });
        say(`${changedText(r.changed)}${r.status === "mapping_review" && atGate2 ? " That changes the mapping, so we're back at the mapping review." : ""}${after.openQuestions.length ? `\n\n${questionList(after)}` : atGate1 ? ' Say "yes" to confirm the mapping.' : ""}`);
      } catch (e) {
        say(String((e as Error).message ?? e));
      }
      return out;
    },

    /** System-started turn (harness.run): one message per milestone. */
    systemTurn(threadId: string, v: ImportView) {
      if (!["mapping_review", "commit_review", "completed", "partially_completed", "failed", "cancelled"].includes(v.status)) return;
      const key = `${v.id}:${v.status}`;
      if (lastSystem.get(threadId) === key) return;
      lastSystem.set(threadId, key);
      post(threadId, "assistant", describe(v), v.id);
    },
  };
}

/** Numbered questions with lettered options, answerable in chat ("1b", "2: Kiva", "accept 3"). */
function questionList(v: any): string {
  const qs = v.openQuestions ?? [];
  if (!qs.length) return "No open questions.";
  const lines = qs.map((q: any, i: number) => {
    const says = q.guess && q.suggested === "ignore" ? " says not a field" : "";
    const tag = q.guess ? `suggested, ${q.guess.method === "jev" ? "Jev" : "LLM"} ${Math.round(q.guess.score * 100)}%${says}${q.guess.score < 0.4 ? ", low confidence" : ""}` : "suggested";
    const opts = (q.options ?? []).map((o: any, j: number) => `${String.fromCharCode(97 + j)}) ${o.label.replace(/ \((Jev|LLM) \d+%[^)]*\)$/, "")}${o.id === q.suggested ? ` (${tag})` : ""}`).join("   ");
    return `${i + 1}. ${q.blocking ? "[required] " : ""}${q.prompt}\n   ${opts}`;
  });
  return `${qs.length === 1 ? "One thing needs you" : `${qs.length} things need you`}:\n\n${lines.join("\n")}\n\nReply "1b", "2: Kiva", "accept 3", or "accept all".`;
}

function problems(v: any): string {
  if (!v.issues?.length) return "No row problems.";
  return `Row problems:\n${v.issues.map((i: string) => `- ${i}`).join("\n")}\nThe error CSV in the card lists every row; fix one here with "set row 6 name to Blue Dream".`;
}

function changedText(changed: string[] = []): string {
  if (!changed.length) return "No change.";
  const answered = changed.filter((c) => /^(slang|value|column|unit):|^not_a_catalog$/.test(c)).length;
  const rest = changed.filter((c) => !/^(slang|value|column|unit):|^not_a_catalog$/.test(c)).map((c) => c.replace(/_/g, " "));
  return `Done: ${[answered ? `answered ${answered} question(s)` : "", rest.length ? `updated ${[...new Set(rest)].join(", ")}` : ""].filter(Boolean).join("; ")}.`;
}

function describe(v: any): string {
  const c = v.counts ?? {};
  switch (v.status) {
    case "mapping_review": {
      const fields = (v.plan?.fields ?? v.mapped ?? []).filter((m: any) => !m.rationale?.startsWith?.("derived:"));
      const open = v.openQuestions?.length ?? 0;
      return `I mapped ${fields.length} columns (confidence ${Math.round((v.overallConfidence ?? v.confidence ?? 0) * 100)}%). ${open ? `${open} question(s) need you; ask "what do you need?" to answer them here, or use the card. ` : ""}Say "yes" to confirm the mapping, or tell me what to change.`;
    }
    case "commit_review": {
      const est = v.followupEstimate ? ` ${v.followupEstimate.creates || v.followupEstimate.rows} will be created inactive, then finished over ~${v.followupEstimate.minutes} min.` : "";
      return `Ready: ${c.create ?? 0} new, ${c.update ?? 0} updates, ${c.skip ?? 0} skipped (${c.dup_in_file ?? 0} duplicates in the file, ${(c.exists_unchanged ?? 0) + (c.exists_changed ?? 0)} already in Distru), ${c.invalid ?? 0} invalid.${est} Say "yes" to import ${(c.create ?? 0) + (c.update ?? 0)} products.`;
    }
    case "completed":
      return `Done. ${c.committed ?? 0} products are in Distru.${c.invalid ? ` ${c.invalid} rows were invalid; the error CSV lists them.` : ""}`;
    case "partially_completed":
      return `Finished with problems: ${c.committed ?? 0} in Distru, ${(c.failed ?? 0) + (c.needs_attention ?? 0)} need attention. ${c.needs_attention ? "Products whose details failed stay inactive; use Retry details in the card." : ""} The error CSV lists every problem row.`;
    case "failed":
      if (v.error?.code === "duplicate_open_import") return "This file is already open in another import, so I didn't start a second one. Use the card to continue that import, or cancel it and start this one.";
      return `The import failed: ${(v.error?.message ?? "unknown error").replace(/\.$/, "")}.`;
    case "cancelled":
      return `Cancelled ${v.filename ?? "the import"}. Nothing was written to Distru. Drop another file to start again.`;
    default:
      return `Working on it (${String(v.status).replace(/_/g, " ")}).`;
  }
}
