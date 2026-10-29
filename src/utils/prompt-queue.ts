/**
 * Process-wide one-at-a-time prompt queue. Anything that decides to prompt
 * (any session, any parallel tool call, any extension) takes its turn here,
 * so the UI never has two live questions.
 */
let queueTail: Promise<unknown> = Promise.resolve();

export function enqueuePrompt<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => {});
  return run;
}
