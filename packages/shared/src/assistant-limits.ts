/**
 * The limits the database holds the ask-log to, said once (SCRUM-591, plan
 * §D.3). A file of its own, with no imports, so the launcher's panel can read
 * them through `@oto/shared/assistant-limits` without pulling the registry's
 * zod schemas (`assistant-tools.ts`) into its bundle; `assistant-tools`
 * re-exports them, so the api and the database read them as before.
 */
export const ASSISTANT_QUESTION_MAX = 2000;
export const ASSISTANT_STORED_ANSWER_MAX = 4000;
export const ASSISTANT_CORRECTION_MAX = 1000;
/** Links an answer may carry (§D.1). */
export const ASSISTANT_LINKS_MAX = 3;
/** The ask-log's retention (owner G4 default): `purge_after` = asked + this. */
export const ASSISTANT_ASK_RETENTION_DAYS = 90;
