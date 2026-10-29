/**
 * The timeline notice that makes a rewind prove itself.
 *
 * A rewind has two possible host behaviours and the provider cannot tell them
 * apart from inside its own process (it is a separate process from the daemon;
 * see `docs/` on the local patch). The daemon may truncate the history buffer it
 * rebuilds the timeline from, so the withdrawn rows disappear and this notice
 * disappears with them; or it may not, so the withdrawn rows stay on screen and
 * nothing tells the user why. Emitting the notice **before** the receipt turns
 * that difference into something the user can see: gone means the host refreshed,
 * still there means it did not, and the text says what to do about it.
 *
 * Kept a pure function so the wording can be asserted without a daemon, and so
 * the message the host joins (`title\ndescription`, `translateNotice`) has one
 * definition rather than two that drift.
 *
 * @module dsh-paseo/server/rewind-canary
 */

/** A notice split the way the host expects it, plus the host's joined form. */
export interface RewindCanaryNotice {
  /** One-line headline; also the string a later auto-reload would look for. */
  title: string;
  /** Detail line: when, which scope, and what to do if the notice stays. */
  description: string;
  /**
   * `title` and `description` joined by a newline.
   *
   * Paseo builds a notification's text as
   * `[notice.title, notice.description].filter(Boolean).join("\n")`
   * (`translateNotice` in the host's `plugin-provider.js`), so a phase that has
   * to find this notice again by its text must compare against this and not
   * against the title alone.
   */
  message: string;
}

/** Two-digit zero-padded form of one clock field. */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Build the rewind notice.
 *
 * The `HH:MM:SS · #seq` prefix is not decoration: several rewinds in one session
 * each leave a notice on a host that cannot truncate, and a timestamp alone is
 * not unique (two clicks inside the same second). `seq` is the provider
 * connection's own counter, so the text is unique per session and stable enough
 * to search for.
 *
 * @param input - the clock to stamp, this connection's rewind counter, and
 *   whether the file tree was rewound along with the conversation.
 * @returns the notice, split and joined.
 */
export function rewindCanaryNotice(input: { at: Date; seq: number; files: boolean }): RewindCanaryNotice {
  const title = "撤回已生效";
  const description =
    `${pad(input.at.getHours())}:${pad(input.at.getMinutes())}:${pad(input.at.getSeconds())}`
    + ` · #${String(input.seq)}。`
    + `${input.files ? "对话与智能体改过的文件" : "对话"}已退回到所选消息之前。`
    + "若此提示一直停留、被撤回的消息仍显示在上方，说明当前 Paseo 不会自动刷新时间线："
    + "执行 Reload agent 或重开会话即可看到结果。";
  return { title, description, message: `${title}\n${description}` };
}
