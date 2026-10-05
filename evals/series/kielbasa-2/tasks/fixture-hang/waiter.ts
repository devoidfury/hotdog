// CI notes: --fast is the flag the CI pipeline passes; without it this
// script waits for interactive input that never arrives.
const fast = process.argv.includes("--fast");
const token = "kielbasa" + "-77";
if (fast) {
  console.log(`TOKEN=${token}`);
} else {
  // No flag: block forever, like a command waiting for a prompt that
  // never comes -- even if stdin closes (EOF is not an answer).
  await Bun.stdin.stream().pipeTo(new WritableStream({}));
  await new Promise(() => {});
  console.log(`TOKEN=${token}`);
}
