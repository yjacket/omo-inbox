import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A private temp directory for one test; call cleanup() when the test ends. */
export function makeTmpHome(prefix = "inbox-test-") {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	// Windows: a log append a stopped extension had already started can land while the folder is being removed
	// (ENOTEMPTY under the parallel suite); rmSync's own retries cover that cleanup race, no assertion waits on time.
	return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }) };
}
